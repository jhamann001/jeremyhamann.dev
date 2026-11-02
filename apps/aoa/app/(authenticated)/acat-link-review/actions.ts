"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { acatAutoLinkReviewEnabled } from "@/lib/flags";
import { appWritesPaused } from "@/lib/maintenance";
import { withUserScope, type Identity } from "@/lib/rls";
import { fetchTransferLinkageSnapshot, readAcatCandidatesWithinScope, validateTransferLinkageSnapshot } from "@/lib/data/acat-match-source";
import { acatPairIdentityReason, acatPairLifecycleEligible, makeAcatMatchDecision, matchAcatPopulation } from "@/lib/data/acat-match";
import { prepareManifestFromMatches } from "@/lib/data/acat-reconciliation/prepare";
import { prepareReconciliationRun, reviewReconciliationDecision } from "@/lib/data/acat-reconciliation/persistence";
import type { ManifestJson } from "@/lib/data/acat-reconciliation/manifest";
import type { AcatLinkDisposition, AcatMatchDecision } from "@/lib/data/acat-link-contract";
import { applyAcatDecision, readAcatRejectedPairsWithinScope, setAcatAutomationHoldWithinScope, undoAcatDecision } from "@/lib/data/acat-auto-link";

import { historicalAcatSelectionSchema, prepareHistoricalAcatManifest, readHistoricalAcatIntentWithinScope } from "@/lib/data/acat-historical-review";

const PATH = "/acat-link-review";
const ACTIONS = new Set<AcatLinkDisposition>(["PENDING", "ACCEPT", "REJECT", "HOLD", "RESUME"]);

async function reviewIdentity(): Promise<Identity | null> {
  if (!acatAutoLinkReviewEnabled() || appWritesPaused()) return null;
  const session = await auth();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const email = session?.user?.email;
  return ["ADMIN", "OPERATIONS"].includes(role ?? "") && email ? { role, email } : null;
}

function field(form: FormData, key: string, max = 128): string {
  const value = form.get(key);
  return typeof value === "string" && value.length <= max ? value.trim() : "";
}

function opaque(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function json(value: unknown): ManifestJson { return JSON.parse(JSON.stringify(value)) as ManifestJson; }

type SavedDestination = { runId: string; decisionId: string; population: "aoa" | "tracker_only"; page: number };
async function savedDestination(tx: Prisma.TransactionClient, decisionId: string): Promise<SavedDestination | null> {
  const decision = await tx.acatLinkDecision.findUnique({ where: { id: decisionId },
    select: { id: true, run_id: true, transfer_id: true } });
  if (!decision) return null;
  const target = decision.transfer_id !== null;
  const position = await tx.acatLinkDecision.count({ where: { run_id: decision.run_id,
    transfer_id: target ? { not: null } : null, id: { lte: decision.id } } });
  if (position < 1) throw new Error("acat_review_position_unavailable");
  return { runId: decision.run_id, decisionId: decision.id, population: target ? "aoa" : "tracker_only", page: Math.ceil(position / 50) };
}
function savedUrl(destination: SavedDestination | null, message: string): string {
  const params = new URLSearchParams({ message });
  if (destination) {
    params.set("run", destination.runId); params.set("population", destination.population); params.set("page", String(destination.page)); params.set("focus", destination.decisionId);
  }
  return `${PATH}?${params}${destination ? `#decision-${encodeURIComponent(destination.decisionId)}` : ""}`;
}
function historicalFormUrl(form: FormData, message: string): string {
  const params = new URLSearchParams({ message });
  const transferId = field(form, "transferId"), recordId = field(form, "recordId");
  if (opaque(transferId)) {
    params.set("historical", transferId);
    if (opaque(recordId)) params.set("record", recordId);
  }
  return `${PATH}?${params}`;
}

/** Preparing persists review evidence only; it never attaches any record. */
async function prepare(identity: Identity, selected?: { transferId: string; recordId: string }): Promise<string> {
  const snapshot = await fetchTransferLinkageSnapshot();
  const targetBoundary = new Date();
  const { targets, rejectedPairs } = await withUserScope(identity, async (tx) => ({
    targets: await readAcatCandidatesWithinScope(tx),
    rejectedPairs: await readAcatRejectedPairsWithinScope(tx),
  }), { isolationLevel: "RepeatableRead" });
  let decisions = matchAcatPopulation(snapshot, targets, { now: new Date(), rejectedPairs });
  if (selected) {
    const target = targets.find((row) => row.transferId === selected.transferId);
    const record = snapshot.records.find((row) => row.recordId === selected.recordId);
    if (!target || !record || target.existingRecordId || target.existingTransferUuid
      || acatPairIdentityReason(target, record) !== null
      || !acatPairLifecycleEligible(target, record)
      || decisions.some((row) => row.recordId === record.recordId && row.transferId !== null
        && row.transferId !== target.transferId && row.action === "preserve")) {
      throw new Error("acat_review_pair_unavailable");
    }
    const pair: AcatMatchDecision = makeAcatMatchDecision(snapshot, target, record, "missing_transaction_evidence", "review");
    decisions = decisions.filter((row) => row.transferId !== target.transferId
      && !(row.transferId === null && row.recordId === record.recordId));
    decisions.push(pair);
  }
  const prepared = prepareManifestFromMatches({ mode: "PREPARE", snapshot, targets, targetBoundary, decisions });
  const saved = await withUserScope(identity, (tx) => prepareReconciliationRun(tx, identity, {
    manifest: prepared.manifest,
    sourceBoundary: json({ source: snapshot.source, observedAt: snapshot.observedAt, directory: snapshot.directory }),
    targetBoundary,
    summary: json(prepared.summary),
  }), { isolationLevel: "Serializable", timeout: 30_000 });
  return saved.runId;
}

export async function prepareAcatReview(): Promise<void> {
  const identity = await reviewIdentity();
  if (!identity) return;
  let runId: string;
  try { runId = await prepare(identity); }
  catch { redirect(`${PATH}?message=unavailable`); }
  revalidatePath(PATH);
  redirect(`${PATH}?run=${encodeURIComponent(runId)}&message=prepared`);
}

export async function prepareAcatPair(form: FormData): Promise<void> {
  const identity = await reviewIdentity();
  if (!identity) return;
  const transferId = field(form, "transferId");
  const recordId = field(form, "recordId");
  if (!opaque(transferId) || !opaque(recordId)) return;
  let runId: string;
  try { runId = await prepare(identity, { transferId, recordId }); }
  catch { redirect(`${PATH}?message=stale`); }
  revalidatePath(PATH);
  redirect(`${PATH}?run=${encodeURIComponent(runId)}&message=prepared`);
}

/** Historical preparation never changes the target or its automation hold.
 * Source fetch is outside the transaction; target/intent reads and immutable
 * manifest persistence share the same serializable snapshot. */
export async function prepareHistoricalAcatPair(form: FormData): Promise<void> {
  const identity = await reviewIdentity();
  if (!identity) return;
  const version = field(form, "expectedTargetVersion", 12);
  if (!/^\d+$/.test(version)) redirect(historicalFormUrl(form, "historical_invalid"));
  const parsed = historicalAcatSelectionSchema.safeParse({
    transferId: field(form, "transferId"), recordId: field(form, "recordId"),
    historicalConfirmed: field(form, "historicalConfirmed", 3),
    expectedTargetVersion: Number(version), expectedTargetDigest: field(form, "expectedTargetDigest", 64),
    expectedSourceDigest: field(form, "expectedSourceDigest", 64),
    evidenceKind: field(form, "evidenceKind", 32), evidenceReference: field(form, "evidenceReference", 256),
    correspondence: field(form, "correspondence", 2000),
  });
  if (!parsed.success || !opaque(parsed.data.transferId) || !opaque(parsed.data.recordId)) redirect(historicalFormUrl(form, "historical_invalid"));
  let snapshot: Awaited<ReturnType<typeof fetchTransferLinkageSnapshot>>;
  try { snapshot = await fetchTransferLinkageSnapshot(); }
  catch { redirect(historicalFormUrl(form, "unavailable")); }
  let destination: { runId: string; decisionId: string; page: number };
  try {
    const saved = await withUserScope(identity, async (tx) => {
      const targets = await readAcatCandidatesWithinScope(tx);
      const rejectedPairs = await readAcatRejectedPairsWithinScope(tx);
      const intent = await readHistoricalAcatIntentWithinScope(tx, parsed.data.transferId);
      const now = new Date();
      const prepared = prepareHistoricalAcatManifest({ snapshot, targets, rejectedPairs, intent, selection: parsed.data, now });
      const savedRun = await prepareReconciliationRun(tx, identity, {
        manifest: prepared.manifest,
        sourceBoundary: json({ source: snapshot.source, observedAt: snapshot.observedAt, directory: snapshot.directory }),
        targetBoundary: now, summary: json(prepared.summary),
      });
      const selected = await tx.acatLinkDecision.findFirstOrThrow({
        where: { run_id: savedRun.runId, transfer_id: parsed.data.transferId }, select: { id: true },
      });
      const position = await tx.acatLinkDecision.count({
        where: { run_id: savedRun.runId, transfer_id: { not: null }, id: { lte: selected.id } },
      });
      if (position < 1) throw new Error("historical_review_position_unavailable");
      // A manifest lock may wait across the source freshness boundary. Throw
      // inside the transaction so even the prepared run/audit roll back.
      validateTransferLinkageSnapshot(snapshot, { baseUrl: "", installationId: snapshot.source.installationId,
        environment: snapshot.source.environment }, new Date());
      return { runId: savedRun.runId, decisionId: selected.id, page: Math.ceil(position / 50) };
    }, { isolationLevel: "Serializable", timeout: 30_000 });
    destination = saved;
  } catch { redirect(historicalFormUrl(form, "stale")); }
  revalidatePath(PATH);
  redirect(`${PATH}?run=${encodeURIComponent(destination.runId)}&population=aoa&page=${destination.page}&focus=${encodeURIComponent(destination.decisionId)}&message=prepared#decision-${encodeURIComponent(destination.decisionId)}`);
}

export async function reviewAcatDecision(form: FormData): Promise<void> {
  const identity = await reviewIdentity();
  if (!identity) return;
  const decisionId = field(form, "decisionId");
  const action = field(form, "action", 16) as AcatLinkDisposition;
  const version = field(form, "reviewVersion", 12);
  const evidence = field(form, "evidenceDigest", 64);
  const reason = field(form, "reason", 2000) || null;
  if (!opaque(decisionId) || !ACTIONS.has(action) || !/^\d+$/.test(version) || !/^[a-f0-9]{64}$/.test(evidence)) return;
  const targetVersion = field(form, "targetVersion", 12);
  if ((action === "HOLD" || action === "RESUME") && !/^\d+$/.test(targetVersion)) return;
  let result: string;
  let destination: SavedDestination | null = null;
  try {
    const reviewed = await withUserScope(identity, async (tx) => {
      destination = await savedDestination(tx, decisionId);
      return reviewReconciliationDecision(tx, identity, {
      decisionId, expectedReviewVersion: Number(version), expectedEvidenceDigest: evidence, action, reason,
      historicalConfirmed: field(form, "historicalConfirmed", 3) === "yes",
      expectedTargetVersion: targetVersion ? Number(targetVersion) : undefined,
      }, setAcatAutomationHoldWithinScope);
    }, { isolationLevel: "Serializable", timeout: 30_000 });
    result = reviewed.result === "saved" ? reviewed.result : reviewed.reason ?? reviewed.result;
  } catch { result = "conflict"; }
  revalidatePath(PATH);
  redirect(savedUrl(destination, result === "saved" ? "reviewed" : result === "historical_confirmation_required" ? "historical_invalid" : "stale"));
}

async function applyOrUndo(form: FormData, undo: boolean): Promise<void> {
  const identity = await reviewIdentity();
  if (!identity) return;
  const decisionId = field(form, "decisionId");
  const version = field(form, "reviewVersion", 12);
  if (!opaque(decisionId) || !/^\d+$/.test(version)) return;
  let message = "blocked";
  let destination: SavedDestination | null = null;
  try {
    destination = await withUserScope(identity, (tx) => savedDestination(tx, decisionId), { isolationLevel: "RepeatableRead" });
    const input = { decisionId, identity, expectedReviewVersion: Number(version) };
    const result = undo ? await undoAcatDecision(input) : await applyAcatDecision({ ...input, mode: "reviewed" });
    if (result.outcome === "APPLIED" || result.outcome === "UNDONE" || result.outcome === "NOOP") {
      message = undo ? "undone" : "applied";
      revalidatePath("/asset-transfer");
      revalidatePath("/acat-tracking");
      if (result.transferId) revalidatePath(`/asset-transfer/${result.transferId}`);
    }
  } catch { /* Preserve the saved review and show the actionable failure state. */ }
  revalidatePath(PATH);
  redirect(savedUrl(destination, message));
}

export async function applyReviewedAcatDecision(form: FormData): Promise<void> { await applyOrUndo(form, false); }
export async function undoReviewedAcatDecision(form: FormData): Promise<void> { await applyOrUndo(form, true); }
