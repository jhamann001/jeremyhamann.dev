import "server-only";
import type { Prisma } from "@prisma/client";
import type { Identity } from "@/lib/rls";
import { normalizeAppRole } from "@/lib/auth/app-roles";
import { z } from "zod";
import { ACAT_MATCH_REASONS, ACAT_MATCH_RULE_VERSION, type AcatLinkOutcome } from "../acat-link-contract";
import { reviewCoverage, type ReviewCoverage } from "./presentation";
import { sealPreparedManifest, type ManifestJson, type PreparedManifest } from "./manifest";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueId = z.string().min(1).max(256);
const json: z.ZodType<ManifestJson> = z.lazy(() => z.union([
  z.null(), z.string(), z.number().finite(), z.boolean(), z.array(json), z.record(z.string(), json),
]));
const envelope = z.object({
  decision: z.object({
    transferId: opaqueId.nullable(), recordId: opaqueId.nullable(), reason: z.enum(ACAT_MATCH_REASONS),
    action: z.enum(["preserve", "propose", "review", "exclude", "no_counterpart"]), ruleVersion: z.literal(ACAT_MATCH_RULE_VERSION),
    targetVersion: z.number().int().nonnegative().nullable(), targetDigest: hash.nullable(),
    sourceRecordDigest: hash.nullable(), sourceAccountDigest: hash.nullable(), sourceCandidateSetDigest: hash, evidenceDigest: hash,
  }).strict(),
  context: json,
}).strict();
const mode = z.enum(["PREPARE", "APPLY", "VERIFY", "UNDO", "AUTOMATIC"]);
const outcomes = ["PENDING", "APPLIED", "NOOP", "CONFLICT", "BLOCKED", "UNDONE"] as const;

export type RunVerificationSummary = {
  runId: string;
  manifestValid: boolean;
  decisionCount: number;
  outcomes: Record<AcatLinkOutcome, number>;
  coverage: ReviewCoverage | null;
  invalidOutcomeCount: number;
  linkStateDriftCount: number;
  outcomeMetadataMissingCount: number;
};

/** Read-only in-system verification. Full prepared proof and target rows stay
 * server-side; the return value contains counts plus the opaque run ID only. */
export async function verifyReconciliationRun(
  tx: Prisma.TransactionClient, identity: Identity, runId: string,
): Promise<RunVerificationSummary | null> {
  const role = normalizeAppRole(identity.role);
  if ((role !== "OPERATIONS" && role !== "ADMIN") || !identity.email?.trim()) throw new Error("acat_reconciliation_forbidden");
  if (!runId || runId.length > 256) throw new Error("acat_reconciliation_invalid_run");
  const run = await tx.acatLinkRun.findUnique({ where: { id: runId }, include: { decisions: true } });
  if (!run) return null;
  const summary: RunVerificationSummary = {
    runId, manifestValid: false, decisionCount: run.decisions.length, coverage: null,
    outcomes: { PENDING: 0, APPLIED: 0, NOOP: 0, CONFLICT: 0, BLOCKED: 0, UNDONE: 0 },
    invalidOutcomeCount: 0, linkStateDriftCount: 0, outcomeMetadataMissingCount: 0,
  };
  const parsedMode = mode.safeParse(run.mode);
  const sourceBoundary = z.object({ source: z.object({ system: z.literal("transfer-tracker"),
    installationId: z.literal(run.installation_id), environment: z.enum(["production", "synthetic"]),
  }) }).safeParse(run.source_boundary);
  const parsed = run.decisions.map((decision) => ({ row: decision, data: envelope.safeParse(decision.payload) }));
  if (parsedMode.success && sourceBoundary.success && run.contract_version === 1 && run.rule_version === ACAT_MATCH_RULE_VERSION && parsed.every((item) => item.data.success)) {
    const manifest: PreparedManifest = {
      mode: parsedMode.data, contractVersion: 1, ruleVersion: ACAT_MATCH_RULE_VERSION,
      installationId: run.installation_id, sourceScope: run.source_scope, sourceDigest: run.source_digest,
      sourceCount: run.source_count, sourceComplete: run.source_complete, targetDigest: run.target_digest, targetCount: run.target_count,
      decisions: [],
    };
    let columnsAgree = true;
    for (const item of parsed) {
      if (!item.data.success) continue;
      const { decision, context } = item.data.data;
      const row = item.row;
      if (row.record_id !== decision.recordId || row.transfer_id !== decision.transferId || row.reason !== decision.reason
        || row.action !== decision.action || row.rule_version !== decision.ruleVersion || row.evidence_digest !== decision.evidenceDigest
        || row.expected_target_version !== decision.targetVersion || row.target_evidence_digest !== decision.targetDigest
        || row.source_candidate_set_digest !== decision.sourceCandidateSetDigest) columnsAgree = false;
      manifest.decisions.push({ ...decision, decisionKey: row.decision_key, payload: context });
    }
    // Invalid typed metadata is a verification finding, never a partial pass.
    if (columnsAgree) {
      try {
        const sealed = sealPreparedManifest(manifest);
        summary.manifestValid = sealed.digest === run.manifest_digest && sealed.idempotencyKey === run.idempotency_key;
        if (summary.manifestValid) summary.coverage = reviewCoverage(manifest);
      }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("acat_manifest_")) throw error;
        summary.manifestValid = false;
      }
    }
  }
  const targetIds = [...new Set(run.decisions.flatMap((row) => row.transfer_id ? [row.transfer_id] : []))];
  const targets = new Map((await tx.transfer.findMany({
    where: { id: { in: targetIds } },
    select: { id: true, acat_record_id: true, acat_transfer_id: true, acat_link_version: true, acat_auto_link_hold: true, acat_link_decision_id: true },
  })).map((row) => [row.id, row]));
  for (const { row, data } of parsed) {
    if (!outcomes.includes(row.outcome as AcatLinkOutcome)) { summary.invalidOutcomeCount += 1; continue; }
    summary.outcomes[row.outcome as AcatLinkOutcome] += 1;
    if (!["APPLIED", "UNDONE"].includes(row.outcome)) continue;
    if (row.applied_version === null || !row.application_id || !row.applied_at) summary.outcomeMetadataMissingCount += 1;
    const target = row.transfer_id ? targets.get(row.transfer_id) : undefined;
    if (!target || target.acat_link_version !== row.applied_version) { summary.linkStateDriftCount += 1; continue; }
    if (row.outcome === "APPLIED") {
      if (target.acat_record_id !== row.record_id || target.acat_link_decision_id !== row.id) summary.linkStateDriftCount += 1;
    } else {
      const context = data.success ? data.data.context : null;
      const before = context !== null && !Array.isArray(context) && typeof context === "object" ? context.targetBefore : null;
      if (!before || typeof before !== "object" || Array.isArray(before) || !Object.hasOwn(before, "recordId") || !Object.hasOwn(before, "transferUuid")
        || target.acat_record_id !== before.recordId || target.acat_transfer_id !== before.transferUuid || !target.acat_auto_link_hold) {
        summary.linkStateDriftCount += 1;
      }
    }
  }
  return summary;
}
