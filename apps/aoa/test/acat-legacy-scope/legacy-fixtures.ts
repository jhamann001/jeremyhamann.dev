import { acatEvidenceHash, matchAcatPopulation } from "@/lib/data/acat-match";
import { sourceRecord, targetRecord, snapshot } from "../acat-reconciliation/fixtures";
export const NOW = new Date("2026-09-29T14:00:00.000Z");
export function facts(kind: "legacy" | "verified" = "legacy", terminal = false) {
  const record = { ...sourceRecord(), workflow: "ACAT", status: terminal ? "Completed" : "Submitted" };
  record.recordEvidenceDigest = acatEvidenceHash(record);
  const source = snapshot([record]);
  source.observedAt = NOW.toISOString(); source.directory.lastSuccessAt = NOW.toISOString();
  source.snapshotDigest = acatEvidenceHash({ contractVersion: source.contractVersion, source: source.source,
    scope: source.scope, records: source.records.map(r => [r.recordId, r.recordEvidenceDigest, r.accountEvidenceDigest]) });
  const target = { ...targetRecord(), stage: terminal ? "FUNDED" : "IN_TRANSFER", receivingAccount: null,
    ...(kind === "verified" ? { existingTransferUuid: null, transactionReference: {
      namespace: "apex-acat-transfer" as const, value: record.acatTransferId!, provenance: "VERIFIED" as const } } : {}) };
  target.evidenceDigest = acatEvidenceHash(target);
  const decision = matchAcatPopulation(source, [target], { now: NOW, allowLegacyEnrichment: true })[0];
  return { record, source, target, decision };
}
