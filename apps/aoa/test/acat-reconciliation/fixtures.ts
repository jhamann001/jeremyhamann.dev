import type { AcatMatchDecision, AoaAcatCandidate, LinkageRecord, LinkageSnapshot } from "@/lib/data/acat-link-contract";
import type { PreparedManifest } from "@/lib/data/acat-reconciliation/manifest";

export const TEST_AT = new Date("2026-09-26T19:00:00.000Z");
export const UUID = "abcdef12-abcd-4abc-8abc-abcdef123456";
export const DIGEST = { snapshot: "a".repeat(64), target: "b".repeat(64), record: "c".repeat(64), account: "d".repeat(64), decision: "e".repeat(64) };
export function sourceRecord(id = "synthetic-record"): LinkageRecord {
  return {
    recordId: id, cedarRidgeUserIds: ["synthetic-person"], identityVersion: 0,
    acatTransferId: UUID, controlNumber: null, crmDealId: null, crmDealIdProvenance: "ABSENT",
    direction: "IN", transferType: "FULL", workflow: "STANDARD", status: "Submitted", deletedAt: null,
    createdAt: TEST_AT.toISOString(), requestDate: null,
    receivingAccount: { namespace: "cedarRidge.investment_account", id: "synthetic-account", status: "OPEN", isCurrent: true,
      members: [{ cedarRidgeUserId: "synthetic-person", relationshipType: "INDIVIDUAL", isCurrent: true, clientEligibility: "ACTIVE", presentInSnapshot: true }],
      holderSetComplete: true, verification: "VERIFIED" },
    recordEvidenceDigest: DIGEST.record, accountEvidenceDigest: DIGEST.account,
  };
}
export function targetRecord(id = "synthetic-transfer"): AoaAcatCandidate {
  return {
    transferId: id, linkVersion: 0, existingRecordId: null, existingTransferUuid: UUID, hold: false,
    stage: "IN_TRANSFER", fundingType: "ACAT_FULL", archived: false,
    canonicalClientUserIds: ["synthetic-person"], dealUserId: null, identityState: "verified",
    receivingAccount: { namespace: "cedarRidge.investment_account", id: "synthetic-account", holderIds: ["synthetic-person"], complete: true },
    transactionReference: { namespace: "apex-acat-transfer", value: UUID, provenance: "EXISTING_LINK" }, evidenceDigest: DIGEST.target,
  };
}
export function snapshot(records = [sourceRecord()]): LinkageSnapshot {
  return {
    contractVersion: 1, source: { system: "transfer-tracker", installationId: "synthetic-reconciliation", environment: "synthetic" },
    scope: "ALL_RECORDS_INCLUDING_DELETED", complete: true, observedAt: TEST_AT.toISOString(), recordCount: records.length,
    snapshotDigest: DIGEST.snapshot,
    directory: { snapshotId: "synthetic-directory", publishedGeneration: 1, health: "FRESH", freshnessBasis: "FETCH_SUCCESS", lastSuccessAt: TEST_AT.toISOString(), sourceAsOf: null }, records,
  };
}
export function decision(): AcatMatchDecision {
  return {
    transferId: "synthetic-transfer", recordId: "synthetic-record", reason: "legacy_enrichment", action: "propose", ruleVersion: "acat-link-v1",
    targetVersion: 0, targetDigest: DIGEST.target, sourceRecordDigest: DIGEST.record, sourceAccountDigest: DIGEST.account,
    sourceCandidateSetDigest: DIGEST.snapshot, evidenceDigest: DIGEST.decision,
  };
}
export function preparedManifest(): PreparedManifest {
  return {
    mode: "PREPARE", contractVersion: 1, ruleVersion: "acat-link-v1", installationId: "synthetic-reconciliation", sourceScope: "ALL_RECORDS_INCLUDING_DELETED",
    sourceDigest: DIGEST.snapshot, sourceCount: 1, sourceComplete: true, targetDigest: DIGEST.target, targetCount: 1,
    decisions: [{ ...decision(), decisionKey: "synthetic-decision", payload: { synthetic: true } }],
  };
}
