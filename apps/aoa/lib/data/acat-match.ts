import { createHash } from "node:crypto";
import {
  ACAT_LINK_MAX_PROOF_AGE_MS, ACAT_MATCH_RULE_VERSION,
  type AcatMatchAction, type AcatMatchDecision, type AcatMatchReason,
  type AcatRejectedPair, type AoaAcatCandidate, type LinkageRecord, type LinkageSnapshot,
} from "./acat-link-contract";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OPEN_STATUSES = new Set([
  "WaitingForApex", "PendingAccountOpening", "WaitingOnClient", "WaitingForStatement",
  "AcatReceived", "ToCome", "Submitted", "PendingReview", "PendingContraResponse",
  "Accepted", "PendingSettlement", "PendingBookkeeping", "Pending", "Matched", "Mismatch",
]);
export const acatEvidenceHash = (facts: unknown): string =>
  createHash("sha256").update(JSON.stringify(facts)).digest("hex");

export function canonicalAcatUuid(value: string | null): string | null {
  const cleaned = value?.trim() ?? "";
  return UUID.test(cleaned) ? cleaned.toLowerCase() : null;
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((id, i) => id === [...right].sort()[i]);
}

/** Identity corroborates a transaction reference; it never creates one. AOA's
 * household membership and type-derived receiving account are not proof of
 * the complete holders on a particular joint transfer. */
export function acatPairIdentityReason(target: AoaAcatCandidate, record: LinkageRecord): AcatMatchReason | null {
  if (target.identityState === "conflict") return "identity_conflict";
  const ids = [...new Set(target.canonicalClientUserIds)];
  if (target.identityState !== "verified" || !ids.length || !record.cedarRidgeUserIds.length) return "missing_identity";
  if (ids.length !== 1 || (target.dealUserId != null && !ids.includes(target.dealUserId))) return "identity_conflict";
  if (!ids.every((id) => record.cedarRidgeUserIds.includes(id))) return "identity_conflict";
  const receiving = record.receivingAccount;
  if (!receiving.holderSetComplete || receiving.verification !== "VERIFIED" || !receiving.isCurrent) {
    return record.cedarRidgeUserIds.length > 1 ? "incomplete_joint_evidence" : "missing_identity";
  }
  const currentHolders = receiving.members.filter((member) => member.isCurrent && member.presentInSnapshot);
  if (!equalIds(currentHolders.map((member) => member.cedarRidgeUserId), record.cedarRidgeUserIds)) return "incomplete_joint_evidence";
  if (target.receivingAccount) {
    if (!target.receivingAccount.complete) return "incomplete_joint_evidence";
    if (target.receivingAccount.namespace !== receiving.namespace || target.receivingAccount.id !== receiving.id
      || !equalIds(target.receivingAccount.holderIds, record.cedarRidgeUserIds)) return "identity_conflict";
  } else if (record.cedarRidgeUserIds.length > 1) {
    return "incomplete_joint_evidence";
  }
  return null;
}

export function acatPairLifecycleEligible(target: AoaAcatCandidate, record: LinkageRecord): boolean {
  return !target.archived && ["DECISION", "IN_TRANSFER"].includes(target.stage)
    && ["ACAT_FULL", "ACAT_PARTIAL"].includes(target.fundingType ?? "")
    && record.deletedAt === null && record.direction === "IN" && record.workflow === "ACAT"
    && OPEN_STATUSES.has(record.status)
    && ((target.fundingType === "ACAT_FULL" && record.transferType === "FULL")
      || (target.fundingType === "ACAT_PARTIAL" && record.transferType === "PARTIAL"));
}

export function makeAcatMatchDecision(
  snapshot: LinkageSnapshot,
  target: AoaAcatCandidate | null,
  record: LinkageRecord | null,
  reason: AcatMatchReason,
  action: AcatMatchAction,
): AcatMatchDecision {
  const pair = {
    transferId: target?.transferId ?? null, recordId: record?.recordId ?? null,
    ruleVersion: ACAT_MATCH_RULE_VERSION as typeof ACAT_MATCH_RULE_VERSION,
    targetVersion: target?.linkVersion ?? null, targetDigest: target?.evidenceDigest ?? null,
    sourceRecordDigest: record?.recordEvidenceDigest ?? null,
    sourceAccountDigest: record?.accountEvidenceDigest ?? null,
  };
  return { ...pair, reason, action, sourceCandidateSetDigest: snapshot.snapshotDigest,
    evidenceDigest: acatEvidenceHash(pair) };
}

/** Every target gets one decision; source records without any represented
 * counterpart get a separate decision. Coverage reducers must account for the
 * two populations separately. Input arrays must contain full history. */
export function matchAcatPopulation(
  snapshot: LinkageSnapshot,
  targets: readonly AoaAcatCandidate[],
  options: { now: Date; rejectedPairs?: readonly AcatRejectedPair[]; allowLegacyEnrichment?: boolean },
): AcatMatchDecision[] {
  if (new Set(targets.map((target) => target.transferId)).size !== targets.length
    || new Set(snapshot.records.map((record) => record.recordId)).size !== snapshot.records.length) {
    throw new Error("acat_link_duplicate_population_ids");
  }
  const age = options.now.getTime() - Date.parse(snapshot.observedAt);
  const sourceReason: AcatMatchReason | null = !snapshot.complete
    || snapshot.scope !== "ALL_RECORDS_INCLUDING_DELETED" || snapshot.recordCount !== snapshot.records.length
    || snapshot.directory.health !== "FRESH" ? "source_unavailable"
    : !Number.isFinite(age) || age < -30_000 || age > ACAT_LINK_MAX_PROOF_AGE_MS ? "stale_evidence" : null;
  const records = new Map(snapshot.records.map((record) => [record.recordId, record]));
  const byUuid = new Map<string, LinkageRecord[]>();
  for (const record of snapshot.records) {
    const uuid = canonicalAcatUuid(record.acatTransferId);
    if (uuid) byUuid.set(uuid, [...(byUuid.get(uuid) ?? []), record]);
  }
  const uuidReservations = new Map<string, AoaAcatCandidate[]>();
  for (const target of targets) {
    const uuid = canonicalAcatUuid(target.existingTransferUuid);
    if (uuid) uuidReservations.set(uuid, [...(uuidReservations.get(uuid) ?? []), target]);
  }
  const represented = new Set<string>();
  const decisions = targets.map((target) => {
    const decide = (record: LinkageRecord | null, reason: AcatMatchReason, action: AcatMatchAction) => {
      if (record) represented.add(record.recordId);
      return makeAcatMatchDecision(snapshot, target, record, reason, action);
    };
    if (target.existingRecordId) {
      const record = records.get(target.existingRecordId) ?? null;
      if (sourceReason) return decide(record, sourceReason, "preserve");
      if (!record) return decide(null, "source_unavailable", "preserve");
      const conflict = acatPairIdentityReason(target, record);
      const storedUuid = canonicalAcatUuid(target.existingTransferUuid);
      const inconsistent = storedUuid != null && storedUuid !== canonicalAcatUuid(record.acatTransferId);
      return decide(record, inconsistent ? "identity_conflict" : conflict ?? "existing_link", conflict || inconsistent ? "review" : "preserve");
    }
    if (sourceReason) return decide(null, sourceReason, "review");
    if (target.hold) return decide(null, "manual_hold", "exclude");
    if (target.identityState !== "verified") return decide(null, target.identityState === "conflict" ? "identity_conflict" : "missing_identity", "review");

    const legacyUuid = canonicalAcatUuid(target.existingTransferUuid);
    let matches: LinkageRecord[];
    let reason: AcatMatchReason;
    if (target.existingTransferUuid != null) {
      if (!legacyUuid) return decide(null, "missing_transaction_evidence", "review");
      matches = byUuid.get(legacyUuid) ?? [];
      reason = "legacy_enrichment";
      if (matches.length > 1 || (uuidReservations.get(legacyUuid)?.length ?? 0) > 1) return decide(null, "duplicate_reference", "review");
    } else {
      const reference = target.transactionReference;
      if (!reference) return decide(null, "missing_transaction_evidence", "review");
      // All current CRM source values are explicitly unverified. A
      // syntactically valid opportunity id does not silently become authority.
      if (reference.provenance !== "VERIFIED" || reference.namespace === "crm.opportunity") {
        return decide(null, "unverified_transaction_evidence", "review");
      }
      const uuid = canonicalAcatUuid(reference.value);
      if (!uuid) return decide(null, "missing_transaction_evidence", "review");
      matches = byUuid.get(uuid) ?? [];
      reason = "unique_transaction_match";
      const referenceTargets = targets.filter((candidate) => canonicalAcatUuid(candidate.transactionReference?.namespace === "apex-acat-transfer"
        ? candidate.transactionReference.value : null) === uuid);
      if (matches.length > 1 || referenceTargets.length > 1) return decide(null, "duplicate_reference", "review");
    }
    if (!matches.length) return decide(null, "no_counterpart", "no_counterpart");
    const record = matches[0];
    const reserved = targets.some((candidate) => candidate.transferId !== target.transferId
      && (candidate.existingRecordId === record.recordId
        || (canonicalAcatUuid(candidate.existingTransferUuid) != null
          && canonicalAcatUuid(candidate.existingTransferUuid) === canonicalAcatUuid(record.acatTransferId))));
    if (reserved) return decide(record, "reserved_link", "review");
    const identityReason = acatPairIdentityReason(target, record);
    if (identityReason) return decide(record, identityReason, "review");
    // Historical records may enrich an exact existing UUID only in an
    // explicitly selected initial-run scope. New inferred history is review.
    if (reason === "legacy_enrichment" ? options.allowLegacyEnrichment !== true : !acatPairLifecycleEligible(target, record)) {
      return decide(record, "ineligible_lifecycle", "review");
    }
    const proposed = makeAcatMatchDecision(snapshot, target, record, reason, "propose");
    const rejected = options.rejectedPairs?.filter((pair) => pair.transferId === target.transferId && pair.recordId === record.recordId) ?? [];
    if (rejected.length) {
      return decide(record, "pair_rejected", rejected.some((pair) => pair.evidenceDigest === null || pair.evidenceDigest === proposed.evidenceDigest) ? "exclude" : "review");
    }
    return decide(record, reason, "propose");
  });
  for (const record of snapshot.records) {
    if (!represented.has(record.recordId)) decisions.push(makeAcatMatchDecision(snapshot, null, record,
      sourceReason ?? "no_counterpart", sourceReason ? "review" : "no_counterpart"));
  }
  return decisions;
}
