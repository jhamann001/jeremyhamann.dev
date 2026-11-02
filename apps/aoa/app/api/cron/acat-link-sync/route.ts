import { Prisma } from "@prisma/client";
import { requireAcatLinkCronAuth } from "@/lib/cron/acat-link-auth";
import { withIngestScope } from "@/lib/ingest/scope";
import { acatAutoLinkEnabled, acatAutoLinkReviewEnabled } from "@/lib/flags";
import { appWritesPaused } from "@/lib/maintenance";
import { ACAT_LINK_RUN, writeAudit } from "@/lib/audit";
import { LINKAGE_ERROR_CODES, LINKAGE_ERROR_REASONS, LinkageError } from "@/lib/data/acat-link-contract";
import { fetchTransferLinkageSnapshot, readAcatCandidatesWithinScope } from "@/lib/data/acat-match-source";
import { applyAcatDecision, readAcatRejectedPairsWithinScope } from "@/lib/data/acat-auto-link";
import { matchAcatPopulation } from "@/lib/data/acat-match";
import { prepareManifestFromMatches } from "@/lib/data/acat-reconciliation/prepare";
import { prepareReconciliationRun } from "@/lib/data/acat-reconciliation/persistence";

export const runtime = "nodejs";
export const maxDuration = 120;
const IDENTITY = { role: "INGEST", email: null } as const;
const MAX_BATCH = 10;
const START_BUDGET_MS = 60_000;
const err = (error: string, status: number) => Response.json({ error }, { status });
const methodNotAllowed = () => err("method_not_allowed", 405);
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

type Phase = "source" | "prepare" | "select" | "summary";
type FailureCause = readonly [label: string, matches: (error: unknown) => boolean];

// ticket: a caught error only SELECTS one of these constant labels. None of
// its message, properties or other derived text reaches the log (CWE-209), so
// the line can never carry a payload, token or identifier. Rows are ordered
// most specific first; anything unlisted logs the next broader label.
const SOURCE_STATUSES = [400, 401, 403, 404, 408, 409, 413, 429, 500, 502, 503, 504] as const;
const PRISMA_CODES = ["P1001", "P1002", "P1008", "P1017", "P2002", "P2003", "P2010", "P2024", "P2025", "P2028", "P2034"] as const;
const INTERNAL_CODES = ["acat_link_duplicate_population_ids", "acat_reconciliation_candidate_proof_mismatch",
  "acat_reconciliation_conflicting_proposals", "acat_reconciliation_foreign_source_decision",
  "acat_reconciliation_invalid_boundary", "acat_reconciliation_invalid_source_boundary",
  "acat_reconciliation_invalid_target_decisions", "acat_reconciliation_manifest_conflict",
  "acat_reconciliation_payload_too_large"] as const;
const FAILURE_CAUSES: readonly FailureCause[] = [
  ...LINKAGE_ERROR_CODES.flatMap((code): FailureCause[] => [
    ...SOURCE_STATUSES.map((status): FailureCause => [`cause=${code} reason=http_status status=${status}`,
      (error) => error instanceof LinkageError && error.code === code && error.reason === "http_status" && error.httpStatus === status]),
    ...LINKAGE_ERROR_REASONS.map((reason): FailureCause => [`cause=${code} reason=${reason}`,
      (error) => error instanceof LinkageError && error.code === code && error.reason === reason]),
    [`cause=${code}`, (error) => error instanceof LinkageError && error.code === code],
  ]),
  ...PRISMA_CODES.map((code): FailureCause => [`cause=database reason=${code}`,
    (error) => (error instanceof Prisma.PrismaClientKnownRequestError && error.code === code)
      || (error instanceof Prisma.PrismaClientInitializationError && error.errorCode === code)]),
  ["cause=database reason=known_request", (error) => error instanceof Prisma.PrismaClientKnownRequestError],
  ["cause=database reason=initialization", (error) => error instanceof Prisma.PrismaClientInitializationError],
  ["cause=database reason=unknown_request", (error) => error instanceof Prisma.PrismaClientUnknownRequestError],
  ["cause=database reason=panic", (error) => error instanceof Prisma.PrismaClientRustPanicError],
  ["cause=database reason=validation", (error) => error instanceof Prisma.PrismaClientValidationError],
  ...INTERNAL_CODES.map((code): FailureCause => [`cause=internal reason=${code}`, (error) => error instanceof Error && error.message === code]),
];

/** Separate from deal projection. Default-off is inert. Preview is genuinely
 * read-only; prepare/apply receipts are written only in live mode. */
export async function POST(request: Request): Promise<Response> {
  if (!await requireAcatLinkCronAuth(request)) return err("unauthorized", 401);
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode") ?? "automatic";
  if (!["automatic", "preview"].includes(mode) || [...params.keys()].some((key) => key !== "mode")) return err("invalid_mode", 400);
  const enabled = () => mode === "preview" ? acatAutoLinkReviewEnabled() || acatAutoLinkEnabled() : acatAutoLinkEnabled();
  if (!enabled() || appWritesPaused()) return Response.json({ disabled: true });
  const started = Date.now();
  let phase: Phase = "source";
  try {
    // A source failure here produces zero new run/decision/link/audit writes.
    const snapshot = await fetchTransferLinkageSnapshot();
    if (!enabled() || appWritesPaused()) return Response.json({ disabled: true });
    phase = "prepare";
    const prepared = await withIngestScope(async (tx) => {
      const targets = await readAcatCandidatesWithinScope(tx);
      const rejectedPairs = await readAcatRejectedPairsWithinScope(tx);
      const targetBoundary = new Date();
      const decisions = matchAcatPopulation(snapshot, targets, { now: targetBoundary, rejectedPairs });
      const proposal = prepareManifestFromMatches({ mode: "AUTOMATIC", snapshot, targets, targetBoundary, decisions });
      if (mode === "preview") return { runId: null, summary: proposal.summary };
      if (!acatAutoLinkEnabled() || appWritesPaused()) return { disabled: true, runId: null, summary: proposal.summary };
      const receipt = await prepareReconciliationRun(tx, IDENTITY, { manifest: proposal.manifest,
        sourceBoundary: { source: { ...snapshot.source }, observedAt: snapshot.observedAt,
          directoryHealth: snapshot.directory.health, freshnessBasis: snapshot.directory.freshnessBasis },
        targetBoundary, summary: { ...proposal.summary } });
      return { runId: receipt.runId, summary: proposal.summary };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000, maxWait: 5_000 });
    if ("disabled" in prepared) return Response.json({ disabled: true });
    if (!prepared.runId) return Response.json({ mode: "preview", summary: prepared.summary });
    const runId = prepared.runId;
    phase = "select";
    const pending = await withIngestScope((tx) => tx.acatLinkDecision.findMany({
      where: { run_id: runId, action: "propose", disposition: "PENDING", outcome: { in: ["PENDING", "CONFLICT", "BLOCKED"] } },
      select: { id: true, review_version: true }, orderBy: { id: "asc" }, take: MAX_BATCH,
    }), { timeout: 5_000, maxWait: 2_000 });
    const counts = { applied: 0, noop: 0, conflict: 0, blocked: 0 };
    for (const decision of pending) {
      if (Date.now() - started >= START_BUDGET_MS || appWritesPaused() || !acatAutoLinkEnabled()) break;
      try {
        const applied = await applyAcatDecision({ decisionId: decision.id, identity: IDENTITY,
          mode: "automatic", expectedReviewVersion: decision.review_version });
        if (applied.outcome === "APPLIED") counts.applied++;
        else if (applied.outcome === "NOOP") counts.noop++;
        else if (applied.outcome === "CONFLICT") counts.conflict++;
        else counts.blocked++;
      } catch {
        // Preserve already committed links and mark this interrupted batch.
        counts.blocked++;
        break;
      }
    }
    if (appWritesPaused() || !acatAutoLinkEnabled()) return Response.json({ mode: "automatic", runId, ...counts, paused: true });
    phase = "summary";
    const summary = await withIngestScope(async (tx) => {
      const remaining = await tx.acatLinkDecision.count({ where: { run_id: runId, action: "propose", outcome: { in: ["PENDING", "CONFLICT", "BLOCKED"] } } });
      const metrics = { ...counts, remaining, durationMs: Date.now() - started };
      await tx.acatLinkRun.update({ where: { id: runId }, data: { status: remaining || counts.blocked ? "PARTIAL" : "COMPLETED",
        summary: { coverage: { ...prepared.summary }, metrics } } });
      await writeAudit(tx, IDENTITY, { action: ACAT_LINK_RUN, entityType: "acat_link_run", entityId: runId, detail: metrics });
      return metrics;
    }, { timeout: 5_000, maxWait: 2_000 });
    return Response.json({ mode: "automatic", runId, ...summary });
  } catch (error) {
    let cause = "cause=unexpected";
    for (const [label, matches] of FAILURE_CAUSES) if (matches(error)) { cause = label; break; }
    console.error(`[cron:acat-link-sync] run_failed phase=${phase} ${cause}`);
    return err("source_or_database_unavailable", 503);
  }
}
