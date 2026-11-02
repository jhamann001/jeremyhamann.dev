import "server-only";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { acatEvidenceHash, acatPairIdentityReason, acatPairLifecycleEligible, canonicalAcatUuid, makeAcatMatchDecision, matchAcatPopulation } from "./acat-match";
import { validateTransferLinkageSnapshot } from "./acat-match-source";
import type { AcatRejectedPair, AoaAcatCandidate, LinkageRecord, LinkageSnapshot } from "./acat-link-contract";
import { prepareManifestFromMatches } from "./acat-reconciliation/prepare";
import { sealPreparedManifest } from "./acat-reconciliation/manifest";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(256);
export const historicalAcatEvidenceSchema = z.object({
  evidenceKind: z.enum(["TRANSACTION_REFERENCE", "TRANSFER_DOCUMENT"]),
  // A stable identifier/reference, not pasted statements or account data.
  evidenceReference: z.string().trim().min(3).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]+$/)
    .refine((value) => !["unknown", "n/a", "none", "tbd", "pending", "placeholder"].includes(value.toLowerCase())),
  correspondence: z.string().trim().min(40).max(2000),
}).strict();
export type HistoricalAcatEvidence = z.infer<typeof historicalAcatEvidenceSchema>;
export const historicalAcatContextSchema = historicalAcatEvidenceSchema.extend({
  kind: z.literal("HISTORICAL_ACAT_REVIEW"), version: z.literal(1),
  confirmation: z.literal("SAME_TRANSFER_KEEP_HOLD"), intentDigest: hash,
}).strict();
export type HistoricalAcatReviewContext = z.infer<typeof historicalAcatContextSchema>;

/** A present but malformed historical context must never fall through to the
 * ordinary review path. Context remains immutable, human-only authority. */
export function readHistoricalReviewContext(payload: unknown): HistoricalAcatReviewContext | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const context = (payload as { context?: unknown }).context;
  if (!context || typeof context !== "object" || Array.isArray(context) || !Object.hasOwn(context, "historicalReview")) return null;
  return historicalAcatContextSchema.parse((context as { historicalReview: unknown }).historicalReview);
}

const rejection = z.object({ id, recordId: id.nullable(), reviewVersion: z.number().int().nonnegative(), evidenceDigest: hash });
const clear = z.object({ id, recordId: id.nullable(), transferUuid: z.string().max(256).nullable() });
export type HistoricalAcatIntent = {
  rejections: z.infer<typeof rejection>[];
  linkClears: z.infer<typeof clear>[];
  digest: string;
};
export function makeHistoricalAcatIntent(rejections: HistoricalAcatIntent["rejections"], linkClears: HistoricalAcatIntent["linkClears"]): HistoricalAcatIntent {
  const r = z.array(rejection).max(1000).parse(rejections).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const c = z.array(clear).max(1000).parse(linkClears).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(r.map((x) => x.id)).size !== r.length || new Set(c.map((x) => x.id)).size !== c.length) throw new Error("historical_intent_invalid");
  return { rejections: r, linkClears: c, digest: acatEvidenceHash({ rejections: r, linkClears: c }) };
}

const linkState = z.object({ recordId: id.nullable(), transferUuid: z.string().max(256).nullable() }).strict();
const undoDetail = z.object({
  changes: z.record(z.string(), z.object({ from: z.string().nullable(), to: z.string().nullable() }).strict()),
  acat_link_version: z.number().int().nonnegative(), provenance: z.literal("UNDO"), automation_hold: z.literal(true),
  decision_id: id, link_before: linkState, link_after: linkState,
}).strict();
export type HistoricalUndoneDecision = { id: string; transfer_id: string | null; record_id: string | null;
  applied_version: number | null; outcome: string; payload: unknown };

/** Resolve only the fixed guarded writer's Undo receipt against its retained
 * decision. Missing/free-form/mismatched receipts remain unknown intent. */
export function historicalUndoAuditIntent(transferId: string, audit: { id: string; detail: string | null },
  decisions: readonly HistoricalUndoneDecision[]): HistoricalAcatIntent["linkClears"][number] {
  const unresolved = { id: `undo-audit:${id.parse(audit.id)}`, recordId: null, transferUuid: null };
  if (!audit.detail || audit.detail.length > 16_384) return unresolved;
  try {
    const parsed = undoDetail.safeParse(JSON.parse(audit.detail));
    if (!parsed.success) return unresolved;
    const detail = parsed.data;
    const matching = decisions.filter((d) => d.id === detail.decision_id && d.transfer_id === transferId && d.outcome === "UNDONE");
    if (matching.length !== 1) return unresolved;
    const decision = matching[0];
    const payload = z.object({ decision: z.object({ transferId: id, recordId: id }),
      context: z.object({ targetBefore: linkState.extend({ hold: z.boolean() }) }) }).safeParse(decision.payload);
    if (!payload.success || decision.record_id === null || decision.record_id !== detail.link_before.recordId
      || decision.applied_version !== detail.acat_link_version || payload.data.decision.transferId !== transferId
      || payload.data.decision.recordId !== decision.record_id
      || payload.data.context.targetBefore.recordId !== detail.link_after.recordId
      || payload.data.context.targetBefore.transferUuid !== detail.link_after.transferUuid) return unresolved;
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    if (detail.link_before.recordId !== detail.link_after.recordId) changes.acat_record_id = { from: detail.link_before.recordId, to: detail.link_after.recordId };
    if (detail.link_before.transferUuid !== detail.link_after.transferUuid) changes.acat_transfer_id = { from: detail.link_before.transferUuid, to: detail.link_after.transferUuid };
    if (acatEvidenceHash(changes) !== acatEvidenceHash(detail.changes)) return unresolved;
    return { id: unresolved.id, ...detail.link_before };
  } catch { return unresolved; }
}

/** Caller owns Operations RLS and its transaction. No audit, decision or link
 * writes. Read prior intent across runs; a new ACCEPT is not supersession. */
export async function readHistoricalAcatIntentWithinScope(tx: Prisma.TransactionClient, transferId: string): Promise<HistoricalAcatIntent> {
  id.parse(transferId);
  const rejections = await tx.$queryRaw<HistoricalAcatIntent["rejections"]>`
    SELECT id,record_id AS "recordId",review_version AS "reviewVersion",evidence_digest AS "evidenceDigest"
    FROM app.acat_link_decision d WHERE transfer_id=${transferId}
      AND (disposition='REJECT' OR EXISTS(SELECT 1 FROM app.acat_link_review_event e WHERE e.decision_id=d.id AND e.action='REJECT'))
    ORDER BY id LIMIT 1001`;
  const linkClears = await tx.$queryRaw<HistoricalAcatIntent["linkClears"]>`
    SELECT * FROM (
      SELECT 'row:'||id::text AS id,changed->'acat_record_id'->>'from' AS "recordId",
        changed->'acat_transfer_id'->>'from' AS "transferUuid"
      FROM audit.row_change WHERE schema_name='app' AND table_name='transfer' AND row_pk=${transferId} AND op='UPDATE'
        AND ((changed->'acat_record_id'->'from' IS NOT NULL AND changed->'acat_record_id'->'from'<>'null'::jsonb
          AND changed->'acat_record_id'->'to'='null'::jsonb)
        OR (changed->'acat_transfer_id'->'from' IS NOT NULL AND changed->'acat_transfer_id'->'from'<>'null'::jsonb
          AND changed->'acat_transfer_id'->'to'='null'::jsonb))
      UNION ALL
      SELECT 'decision:'||id,record_id,NULL::text FROM app.acat_link_decision
        WHERE transfer_id=${transferId} AND outcome='UNDONE'
      UNION ALL
      SELECT 'current:'||t.id,d.record_id,NULL::text FROM app.transfer t
        LEFT JOIN app.acat_link_decision d ON d.id=t.acat_link_decision_id AND d.transfer_id=t.id AND d.outcome='UNDONE'
        WHERE t.id=${transferId} AND t.acat_link_provenance='UNDO'
    ) intent ORDER BY id LIMIT 1001`;
  const undoAudits = await tx.$queryRaw<Array<{ id: string; detail: string | null }>>`
    SELECT id::text AS id,detail FROM audit."AuditLog"
    WHERE "entityType"='transfer' AND "entityId"=${transferId} AND action='acat_link.undo' ORDER BY id LIMIT 1001`;
  if (undoAudits.length > 1000) throw new Error("historical_intent_invalid");
  const undone = undoAudits.length ? await tx.acatLinkDecision.findMany({
    where: { transfer_id: transferId, outcome: "UNDONE" },
    select: { id: true, transfer_id: true, record_id: true, applied_version: true, outcome: true, payload: true }, take: 1001,
  }) : [];
  if (undone.length > 1000) throw new Error("historical_intent_invalid");
  return makeHistoricalAcatIntent(rejections, [...linkClears, ...undoAudits.map((audit) => historicalUndoAuditIntent(transferId, audit, undone))]);
}

export type HistoricalAcatBlocker = "already_linked" | "funding_unspecified" | "not_acat_funding" | "archived_transfer"
  | "ineligible_target_stage" | "ineligible_source_lifecycle" | "funding_type_mismatch"
  | "missing_identity" | "identity_conflict" | "incomplete_joint_evidence" | "duplicate_reference" | "reserved_link"
  | "prior_rejection" | "prior_unlink";

/** This does not infer a match. It only bounds which exact pairs Operations
 * may adjudicate using separately recorded transfer-specific evidence. */
export function historicalAcatEligibility(target: AoaAcatCandidate, record: LinkageRecord): HistoricalAcatBlocker | null {
  if (target.existingRecordId) return "already_linked";
  if (target.fundingType === null) return "funding_unspecified";
  if (!["ACAT_FULL", "ACAT_PARTIAL"].includes(target.fundingType)) return "not_acat_funding";
  if (target.archived) return "archived_transfer";
  if (!["DECISION", "IN_TRANSFER", "FUNDED"].includes(target.stage)) return "ineligible_target_stage";
  if (record.deletedAt !== null || record.direction !== "IN" || record.workflow !== "ACAT") return "ineligible_source_lifecycle";
  if ((target.fundingType === "ACAT_FULL" ? "FULL" : "PARTIAL") !== record.transferType) return "funding_type_mismatch";
  // Use the unchanged open-source lifecycle predicate with a hypothetical
  // open stage for classification only. Only Completed extends that source set.
  if (record.status !== "Completed" && !acatPairLifecycleEligible({ ...target, stage: "IN_TRANSFER" }, record)) return "ineligible_source_lifecycle";
  const identity = acatPairIdentityReason(target, record);
  return identity === "missing_identity" || identity === "identity_conflict" || identity === "incomplete_joint_evidence" ? identity : null;
}

export function historicalAcatPairBlocker(snapshot: LinkageSnapshot, targets: readonly AoaAcatCandidate[],
  target: AoaAcatCandidate, record: LinkageRecord, intent: HistoricalAcatIntent): HistoricalAcatBlocker | null {
  const eligibility = historicalAcatEligibility(target, record);
  if (eligibility) return eligibility;
  const uuid = canonicalAcatUuid(record.acatTransferId);
  if (uuid && snapshot.records.filter((r) => canonicalAcatUuid(r.acatTransferId) === uuid).length !== 1) return "duplicate_reference";
  const storedUuid = canonicalAcatUuid(target.existingTransferUuid);
  if (target.existingTransferUuid !== null && (storedUuid === null || uuid === null || storedUuid !== uuid)) return "reserved_link";
  if (targets.some((t) => t.transferId !== target.transferId && (t.existingRecordId === record.recordId
    || (uuid !== null && canonicalAcatUuid(t.existingTransferUuid) === uuid)))) return "reserved_link";
  if (intent.rejections.some((r) => r.recordId === null || r.recordId === record.recordId)) return "prior_rejection";
  if (intent.linkClears.some((c) => c.recordId === record.recordId
    || (uuid !== null && canonicalAcatUuid(c.transferUuid) === uuid)
    || (!c.recordId && !canonicalAcatUuid(c.transferUuid)))) return "prior_unlink";
  return null;
}

export const historicalAcatSelectionSchema = historicalAcatEvidenceSchema.extend({
  transferId: id, recordId: id, historicalConfirmed: z.literal("yes"),
  expectedTargetVersion: z.number().int().nonnegative(), expectedTargetDigest: hash, expectedSourceDigest: hash,
}).strict();
export type HistoricalAcatSelection = z.infer<typeof historicalAcatSelectionSchema>;

/** Called with facts read in the same serializable transaction that persists
 * the result. Reuses complete population accounting; never toggles a hold. */
export function prepareHistoricalAcatManifest(input: {
  snapshot: LinkageSnapshot; targets: readonly AoaAcatCandidate[]; rejectedPairs: readonly AcatRejectedPair[];
  intent: HistoricalAcatIntent; selection: HistoricalAcatSelection; now: Date;
}) {
  const selected = historicalAcatSelectionSchema.parse(input.selection);
  validateTransferLinkageSnapshot(input.snapshot, { baseUrl: "", installationId: input.snapshot.source.installationId, environment: input.snapshot.source.environment }, input.now);
  const target = input.targets.find((t) => t.transferId === selected.transferId);
  const record = input.snapshot.records.find((r) => r.recordId === selected.recordId);
  if (!target || !record || selected.expectedTargetVersion !== target.linkVersion || selected.expectedTargetDigest !== target.evidenceDigest
    || selected.expectedSourceDigest !== input.snapshot.snapshotDigest) throw new Error("historical_evidence_changed");
  const intent = makeHistoricalAcatIntent(input.intent.rejections, input.intent.linkClears);
  if (intent.digest !== input.intent.digest) throw new Error("historical_intent_invalid");
  const blocked = historicalAcatPairBlocker(input.snapshot, input.targets, target, record, intent);
  if (blocked) throw new Error(blocked);
  if (target.canonicalClientUserIds.includes(selected.evidenceReference) || /^\d{4}-\d{2}-\d{2}$/.test(selected.evidenceReference)) throw new Error("historical_transfer_evidence_required");
  const context: HistoricalAcatReviewContext = historicalAcatContextSchema.parse({
    kind: "HISTORICAL_ACAT_REVIEW", version: 1, confirmation: "SAME_TRANSFER_KEEP_HOLD", intentDigest: intent.digest,
    evidenceKind: selected.evidenceKind, evidenceReference: selected.evidenceReference, correspondence: selected.correspondence,
  });
  const decisions = matchAcatPopulation(input.snapshot, input.targets, { now: input.now, rejectedPairs: input.rejectedPairs })
    .filter((d) => d.transferId !== target.transferId && !(d.transferId === null && d.recordId === record.recordId));
  decisions.push(makeAcatMatchDecision(input.snapshot, target, record, "missing_transaction_evidence", "review"));
  const prepared = prepareManifestFromMatches({ mode: "PREPARE", snapshot: input.snapshot, targets: input.targets, targetBoundary: input.now, decisions });
  const paired = prepared.manifest.decisions.find((d) => d.transferId === target.transferId)!;
  paired.payload = { targetBefore: { recordId: target.existingRecordId, transferUuid: target.existingTransferUuid, hold: target.hold }, historicalReview: context };
  return { ...prepared, ...sealPreparedManifest(prepared.manifest) };
}
