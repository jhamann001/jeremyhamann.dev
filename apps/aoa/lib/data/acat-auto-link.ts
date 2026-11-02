import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { withUserScope, type Identity } from "@/lib/rls";
import { withIngestScope } from "@/lib/ingest/scope";
import { appWritesPaused } from "@/lib/maintenance";
import { acatAutoLinkEnabled, acatAutoLinkReviewEnabled } from "@/lib/flags";
import { ACAT_LINK_APPLY, ACAT_LINK_HOLD, ACAT_LINK_UNDO, writeAudit } from "@/lib/audit";
import { fetchTransferLinkageSnapshot, readAcatCandidatesWithinScope, validateTransferLinkageSnapshot } from "./acat-match-source";
import { acatEvidenceHash, acatPairIdentityReason, acatPairLifecycleEligible, canonicalAcatUuid, matchAcatPopulation } from "./acat-match";
import { historicalAcatPairBlocker, readHistoricalAcatIntentWithinScope, readHistoricalReviewContext } from "./acat-historical-review";
import { writeAcatLinkWithinScope } from "./acat-link";
import { ACAT_MATCH_REASONS, ACAT_MATCH_RULE_VERSION, type AcatApplicationResult, type AcatRejectedPair, type LinkageSnapshot } from "./acat-link-contract";

const decisionSchema = z.object({
  transferId: z.string().nullable(), recordId: z.string().nullable(), reason: z.enum(ACAT_MATCH_REASONS),
  action: z.enum(["preserve", "propose", "review", "exclude", "no_counterpart"]), ruleVersion: z.literal(ACAT_MATCH_RULE_VERSION),
  targetVersion: z.number().int().nonnegative().nullable(), targetDigest: z.string().nullable(),
  sourceRecordDigest: z.string().nullable(), sourceAccountDigest: z.string().nullable(),
  sourceCandidateSetDigest: z.string(), evidenceDigest: z.string(),
}).strict();
const targetBeforeSchema = z.object({ recordId: z.string().nullable(), transferUuid: z.string().nullable(), hold: z.boolean() }).strict();
const payloadSchema = z.object({ decision: decisionSchema, context: z.object({ targetBefore: targetBeforeSchema }).passthrough() });
const isOperator = (identity: Identity): boolean => ["ADMIN", "OPERATIONS"].includes(identity.role ?? "") && !!identity.email?.trim();
const result = (decisionId: string, outcome: AcatApplicationResult["outcome"], reason: string | null,
  transferId: string | null = null, recordId: string | null = null, appliedVersion: number | null = null): AcatApplicationResult =>
  ({ decisionId, outcome, reason, transferId, recordId, appliedVersion });

export type AcatApplyInput = { decisionId: string; identity: Identity; mode: "reviewed" | "automatic"; expectedReviewVersion: number };
export type AcatUndoInput = Omit<AcatApplyInput, "mode">;

/** All automated batches share one transaction lock. Row CAS/unique indexes
 * also protect manual writers and legacy paths that do not take this lock. */
async function lockDecision(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(268261, 1)`;
  await tx.$queryRaw`SELECT id FROM app.acat_link_decision WHERE id = ${id} FOR UPDATE`;
}

export async function readAcatRejectedPairsWithinScope(tx: Prisma.TransactionClient): Promise<AcatRejectedPair[]> {
  const rows = await tx.acatLinkDecision.findMany({ where: { disposition: "REJECT" },
    select: { transfer_id: true, record_id: true, evidence_digest: true }, take: 20_001 });
  if (rows.length > 20_000) throw new Error("ACAT rejected pair inventory overflow");
  return rows.flatMap((row) => row.transfer_id && row.record_id
    ? [{ transferId: row.transfer_id, recordId: row.record_id, evidenceDigest: row.evidence_digest }] : []);
}

async function attemptAcatDecisionWithinScope(
  tx: Prisma.TransactionClient,
  identity: Identity,
  input: Omit<AcatApplyInput, "identity"> & { snapshot: LinkageSnapshot; now: Date },
): Promise<AcatApplicationResult> {
  if (appWritesPaused() || (input.mode === "reviewed" ? !isOperator(identity) : identity.role !== "INGEST")) return result(input.decisionId, "BLOCKED", "forbidden");
  await lockDecision(tx, input.decisionId);
  const stored = await tx.acatLinkDecision.findUnique({ where: { id: input.decisionId }, include: { run: true } });
  if (!stored) return result(input.decisionId, "BLOCKED", "decision_unavailable");
  const parsed = payloadSchema.safeParse(stored.payload);
  const reject = (reason: string) => result(stored.id, "CONFLICT", reason, stored.transfer_id, stored.record_id);
  if (!parsed.success) return reject("invalid_evidence");
  const expected = parsed.data.decision;
  let historical: ReturnType<typeof readHistoricalReviewContext>;
  try { historical = readHistoricalReviewContext(stored.payload); }
  catch { return reject("invalid_evidence"); }
  if (historical && (input.mode !== "reviewed" || stored.run.mode !== "PREPARE" || expected.action !== "review")) return reject("historical_review_required");
  if (expected.transferId !== stored.transfer_id || expected.recordId !== stored.record_id
    || expected.reason !== stored.reason || expected.action !== stored.action || expected.ruleVersion !== stored.rule_version
    || expected.targetVersion !== stored.expected_target_version || expected.targetDigest !== stored.target_evidence_digest
    || expected.evidenceDigest !== stored.evidence_digest || expected.sourceCandidateSetDigest !== stored.source_candidate_set_digest
    || stored.run.rule_version !== ACAT_MATCH_RULE_VERSION || !stored.run.source_complete
    || stored.run.source_scope !== "ALL_RECORDS_INCLUDING_DELETED"
    || stored.run.source_digest !== expected.sourceCandidateSetDigest) return reject("invalid_evidence");
  if (stored.review_version !== input.expectedReviewVersion) return reject("review_changed");
  if (input.mode === "reviewed" ? stored.disposition !== "ACCEPT" || !stored.reviewed_by || !stored.reviewed_at
    : stored.run.mode !== "AUTOMATIC" || stored.disposition !== "PENDING" || stored.action !== "propose") return reject("not_approved");
  if (!expected.transferId || !expected.recordId) return reject("specific_pair_required");
  await tx.$queryRaw`SELECT id FROM app.transfer WHERE id = ${expected.transferId} FOR UPDATE`;
  const targets = await readAcatCandidatesWithinScope(tx);
  const target = targets.find((candidate) => candidate.transferId === expected.transferId);
  if (!target) return reject("target_unavailable");
  if (stored.outcome === "APPLIED" || stored.outcome === "NOOP") {
    const row = await tx.transfer.findUnique({ where: { id: target.transferId } });
    return row?.acat_link_decision_id === stored.id && target.existingRecordId === expected.recordId && target.linkVersion === stored.applied_version
      ? result(stored.id, "NOOP", null, target.transferId, expected.recordId, target.linkVersion) : reject("target_changed");
  }
  if (stored.outcome === "UNDONE") return reject("decision_undone");
  if (input.snapshot.source.installationId !== stored.run.installation_id) return reject("wrong_installation");
  const sourceBoundary = z.object({ source: z.object({ system: z.literal("transfer-tracker"), installationId: z.string(),
    environment: z.enum(["production", "synthetic"]) }) }).safeParse(stored.run.source_boundary);
  if (!sourceBoundary.success || sourceBoundary.data.source.installationId !== input.snapshot.source.installationId
    || sourceBoundary.data.source.environment !== input.snapshot.source.environment) return reject("wrong_installation");
  try {
    validateTransferLinkageSnapshot(input.snapshot, { baseUrl: "", installationId: stored.run.installation_id,
      environment: sourceBoundary.data.source.environment }, new Date(Math.max(input.now.getTime(), Date.now())));
  } catch { return reject("source_unavailable"); }
  if (input.snapshot.snapshotDigest !== expected.sourceCandidateSetDigest) return reject("source_changed");
  if (target.linkVersion !== expected.targetVersion || target.evidenceDigest !== expected.targetDigest
    || target.existingRecordId !== parsed.data.context.targetBefore.recordId
    || target.existingTransferUuid !== parsed.data.context.targetBefore.transferUuid
    || target.hold !== parsed.data.context.targetBefore.hold) return reject("target_changed");
  const source = input.snapshot.records.find((record) => record.recordId === expected.recordId);
  if (!source || source.recordEvidenceDigest !== expected.sourceRecordDigest || source.accountEvidenceDigest !== expected.sourceAccountDigest) return reject("source_changed");
  // Run the full-population matcher even for a human-selected pair, so source
  // completeness/freshness and all reserved references are assessed together.
  const rejectedPairs = await readAcatRejectedPairsWithinScope(tx);
  const all = matchAcatPopulation(input.snapshot, targets, { now: input.now, rejectedPairs });
  const identityReason = acatPairIdentityReason(target, source);
  if (identityReason) return reject(identityReason);
  const uuid = canonicalAcatUuid(source.acatTransferId);
  if (uuid && input.snapshot.records.filter((record) => canonicalAcatUuid(record.acatTransferId) === uuid).length !== 1) return reject("duplicate_reference");
  if (targets.some((candidate) => candidate.transferId !== target.transferId
    && (candidate.existingRecordId === source.recordId || (uuid && canonicalAcatUuid(candidate.existingTransferUuid) === uuid)))) return reject("reserved_link");
  if (target.existingRecordId !== null && target.existingRecordId !== source.recordId) return reject("target_changed");
  if (target.existingTransferUuid !== null && (!uuid || !canonicalAcatUuid(target.existingTransferUuid)
    || canonicalAcatUuid(target.existingTransferUuid) !== uuid)) return reject("reserved_link");
  const decision = all.find((item) => item.transferId === target.transferId);
  if (input.mode === "automatic") {
    if (!decision || decision.action !== "propose" || decision.recordId !== source.recordId || decision.evidenceDigest !== expected.evidenceDigest) return reject(decision?.reason ?? "target_changed");
  } else {
    // Ordinary accepted pairs retain their existing lifecycle rule. Historical
    // review has its own narrow lifecycle and durable-intent checks; neither
    // path may bypass complete identity or reservation proof.
    if (historical) {
      const intent = await readHistoricalAcatIntentWithinScope(tx, target.transferId);
      const blocked = historicalAcatPairBlocker(input.snapshot, targets, target, source, intent);
      if (blocked) return reject(blocked);
      if (intent.digest !== historical.intentDigest) return reject("historical_intent_changed");
    } else {
      // Initial-run legacy authority is not a reusable approval. UUID-only
      // enrichment now requires the dedicated historical evidence workflow.
      if (target.existingTransferUuid !== null) return reject("historical_review_required");
      if (!acatPairLifecycleEligible(target, source)) return reject("ineligible_lifecycle");
    }
  }
  try {
    validateTransferLinkageSnapshot(input.snapshot, { baseUrl: "", installationId: stored.run.installation_id,
      environment: sourceBoundary.data.source.environment }, new Date(Math.max(input.now.getTime(), Date.now())));
  } catch { return reject("stale_evidence"); }
  const written = await writeAcatLinkWithinScope(tx, identity, {
    transferId: target.transferId, expectedVersion: target.linkVersion,
    expectedRecordId: target.existingRecordId, expectedTransferUuid: target.existingTransferUuid,
    recordId: source.recordId, acatTransferId: source.acatTransferId,
    hold: input.mode === "reviewed", provenance: input.mode === "reviewed" ? "REVIEWED" : "AUTOMATIC",
    decisionId: stored.id, auditAction: ACAT_LINK_APPLY,
  });
  if (!written.ok) return reject("target_changed");
  await tx.acatLinkDecision.update({ where: { id: stored.id }, data: { outcome: "APPLIED", applied_version: written.appliedVersion,
    application_id: acatEvidenceHash([stored.id, expected.evidenceDigest]), applied_at: input.now } });
  return result(stored.id, "APPLIED", null, target.transferId, source.recordId, written.appliedVersion);
}

export async function applyAcatDecisionWithinScope(
  tx: Prisma.TransactionClient, identity: Identity,
  input: Omit<AcatApplyInput, "identity"> & { snapshot: LinkageSnapshot; now: Date },
): Promise<AcatApplicationResult> {
  const applied = await attemptAcatDecisionWithinScope(tx, identity, input);
  if ((applied.outcome === "CONFLICT" || applied.outcome === "BLOCKED")
    && applied.reason !== "forbidden" && (isOperator(identity) || identity.role === "INGEST")) {
    // Preserve a prior successful/undone receipt even if later drift is found.
    // Pending failures become visible in this same attempt transaction.
    await tx.acatLinkDecision.updateMany({ where: { id: input.decisionId, review_version: input.expectedReviewVersion,
      disposition: input.mode === "reviewed" ? "ACCEPT" : "PENDING", outcome: { in: ["PENDING", "CONFLICT", "BLOCKED"] } },
      data: { outcome: applied.outcome } });
  }
  return applied;
}

async function serializable<T>(identity: Identity, automatic: boolean, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const options = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000, maxWait: 5_000 };
  return automatic ? withIngestScope(callback, options) : withUserScope(identity, callback, options);
}

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && (error.code === "P2034" || (error.code === "P2010" && error.meta?.code === "40001"));
}

/** A fresh COMPLETE source snapshot is fetched before every attempted DB
 * transaction. Tracker can change after that read; recorded proof permits
 * later drift detection but cannot provide a distributed transaction. */
export async function applyAcatDecision(input: AcatApplyInput): Promise<AcatApplicationResult> {
  if (appWritesPaused() || !(input.mode === "automatic" ? acatAutoLinkEnabled() : acatAutoLinkReviewEnabled())) return result(input.decisionId, "BLOCKED", "disabled");
  if (input.mode === "reviewed" ? !isOperator(input.identity) : input.identity.role !== "INGEST") return result(input.decisionId, "BLOCKED", "forbidden");
  const maxAttempts = input.mode === "automatic" ? 1 : 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const snapshot = await fetchTransferLinkageSnapshot();
    try {
      return await serializable(input.identity, input.mode === "automatic", (tx) => applyAcatDecisionWithinScope(tx, input.identity, { ...input, snapshot, now: new Date() }));
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (attempt + 1 < maxAttempts) continue;
        return result(input.decisionId, "CONFLICT", "target_changed");
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return result(input.decisionId, "CONFLICT", "reserved_link");
      throw error;
    }
  }
  throw new Error("ACAT serializable retry exhausted");
}

export async function setAcatAutomationHoldWithinScope(
  tx: Prisma.TransactionClient, identity: Identity,
  input: { action: "HOLD" | "RESUME"; transferId: string; expectedTargetVersion: number; decisionId: string },
): Promise<boolean> {
  if (appWritesPaused() || !isOperator(identity) || !Number.isSafeInteger(input.expectedTargetVersion)) return false;
  const changed = await tx.transfer.updateMany({ where: { id: input.transferId, acat_link_version: input.expectedTargetVersion },
    data: { acat_auto_link_hold: input.action === "HOLD", updated_by: identity.email } });
  if (changed.count !== 1) return false;
  await writeAudit(tx, identity, { action: ACAT_LINK_HOLD, entityType: "transfer", entityId: input.transferId,
    detail: { disposition: input.action, decision_id: input.decisionId } });
  return true;
}

export async function undoAcatDecisionWithinScope(tx: Prisma.TransactionClient, identity: Identity, input: AcatUndoInput): Promise<AcatApplicationResult> {
  if (appWritesPaused() || !isOperator(identity)) return result(input.decisionId, "BLOCKED", "forbidden");
  await lockDecision(tx, input.decisionId);
  const stored = await tx.acatLinkDecision.findUnique({ where: { id: input.decisionId } });
  if (!stored || !stored.transfer_id || !stored.record_id) return result(input.decisionId, "BLOCKED", "decision_unavailable");
  if (stored.review_version !== input.expectedReviewVersion) return result(stored.id, "CONFLICT", "review_changed");
  const current = await tx.transfer.findUnique({ where: { id: stored.transfer_id } });
  if (stored.outcome === "UNDONE") {
    const before = payloadSchema.safeParse(stored.payload);
    return before.success && current?.acat_link_version === stored.applied_version
      && current.acat_link_decision_id === stored.id && current.acat_link_provenance === "UNDO" && current.acat_auto_link_hold
      && current.acat_record_id === before.data.context.targetBefore.recordId && current.acat_transfer_id === before.data.context.targetBefore.transferUuid
      ? result(stored.id, "NOOP", null, stored.transfer_id, stored.record_id, current.acat_link_version)
      : result(stored.id, "CONFLICT", "target_changed", stored.transfer_id, stored.record_id);
  }
  if (stored.outcome !== "APPLIED" || !current || current.acat_link_version !== stored.applied_version
    || current.acat_link_decision_id !== stored.id || current.acat_record_id !== stored.record_id
    || !["AUTOMATIC", "REVIEWED"].includes(current.acat_link_provenance ?? "")) return result(stored.id, "CONFLICT", "target_changed");
  const parsed = payloadSchema.safeParse(stored.payload);
  if (!parsed.success) return result(stored.id, "BLOCKED", "prior_link_evidence_unavailable");
  const before = parsed.data.context.targetBefore;
  const written = await writeAcatLinkWithinScope(tx, identity, { transferId: current.id, expectedVersion: current.acat_link_version,
    expectedRecordId: current.acat_record_id, expectedTransferUuid: current.acat_transfer_id,
    recordId: before.recordId, acatTransferId: before.transferUuid,
    hold: true, provenance: "UNDO", decisionId: stored.id, auditAction: ACAT_LINK_UNDO });
  if (!written.ok) return result(stored.id, "CONFLICT", "target_changed");
  await tx.acatLinkDecision.update({ where: { id: stored.id }, data: { outcome: "UNDONE", applied_version: written.appliedVersion } });
  return result(stored.id, "UNDONE", null, current.id, stored.record_id, written.appliedVersion);
}

export async function undoAcatDecision(input: AcatUndoInput): Promise<AcatApplicationResult> {
  if (appWritesPaused() || !acatAutoLinkReviewEnabled()) return result(input.decisionId, "BLOCKED", "disabled");
  if (!isOperator(input.identity)) return result(input.decisionId, "BLOCKED", "forbidden");
  try {
    return await serializable(input.identity, false, (tx) => undoAcatDecisionWithinScope(tx, input.identity, input));
  } catch (error) {
    if (isSerializationConflict(error)) return result(input.decisionId, "CONFLICT", "target_changed");
    throw error;
  }
}
