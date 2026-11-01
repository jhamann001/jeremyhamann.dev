import { sha256 } from "./canonical";
import type { AuditProvenance, Manifest, TrackerSnapshot } from "./contracts";

export function reconcile(manifests: Manifest[], snapshot: TrackerSnapshot, audits: AuditProvenance[]) {
  const manifestIds = new Set(manifests.map((manifest) => sha256(manifest)));
  if (manifests.some((manifest) => manifest.target !== snapshot.target || manifest.databaseName !== snapshot.databaseName || !manifest.installationId || manifest.installationId !== snapshot.installationId || manifest.preMigrationPlaceholders.length > 0)) throw new Error("VERIFICATION_TARGET_MISMATCH");
  const outcomes = snapshot.records.map((record) => {
    const applications = audits.filter((audit) => audit.recordId === record.id && manifestIds.has(audit.manifestHash));
    const sameVersion = applications.filter((audit) => audit.afterVersion === record.identityVersion);
    const current = sameVersion.filter((audit) => audit.newUserId === record.cedarRidgeUserId && sha256(audit.newUserIds) === sha256(record.cedarRidgeUserIds));
    if (sameVersion.length && !current.length) return { recordId: record.id, deleted: record.deletedAt !== null, status: "integrity-failure" };
    const latest = current.at(-1);
    if (latest && latest.beforeBusinessHash !== latest.afterBusinessHash) return { recordId: record.id, deleted: record.deletedAt !== null, status: "integrity-failure" };
    const manifest = latest ? manifests.find((item) => sha256(item) === latest.manifestHash) : undefined;
    const planned = manifest?.rows.find((row) => row.expected.id === record.id);
    if (latest && !planned) return { recordId: record.id, deleted: record.deletedAt !== null, status: "integrity-failure" };
    if (latest && planned && (latest.evidenceHash !== planned.evidenceHash ||
      sha256(latest.oldUserIds) !== sha256(planned.expected.cedarRidgeUserIds) || latest.beforeVersion !== planned.expected.identityVersion ||
      (latest.operation === "apply" && (planned.decision.kind !== "link" ||
        sha256(latest.newUserIds) !== sha256(planned.decision.userIds) || latest.afterVersion <= latest.beforeVersion ||
        latest.directoryEvidenceHash !== planned.directoryEvidenceHash)) ||
      (latest.operation === "exception" && (planned.decision.kind !== "exception" || latest.afterVersion !== latest.beforeVersion)))) {
      return { recordId: record.id, deleted: record.deletedAt !== null, status: "integrity-failure" };
    }
    const expectedKeysMatch = planned && ["clientName", "apexAccountId", "acatTransferId", "deletedAt"].every((field) => record[field as keyof typeof record] === planned.expected[field as keyof typeof record]);
    if (latest?.operation === "exception" && record.cedarRidgeUserIds.length === 0 && expectedKeysMatch) return { recordId: record.id, deleted: record.deletedAt !== null, status: "accepted-exception" };
    if (latest?.operation === "apply" && expectedKeysMatch) return { recordId: record.id, deleted: record.deletedAt !== null, status: "backfill-link-needs-validation", manifestHash: latest.manifestHash };
    // Existing/new application links require independent validation by the
    // CLI's current directory check; nonnull alone is not verification.
    return { recordId: record.id, deleted: record.deletedAt !== null, status: record.cedarRidgeUserIds.length ? "linked-needs-validation" : "unresolved" };
  });
  const ids = new Set(snapshot.records.map((row) => row.id));
  const missingRecordIds = [...new Set(manifests.flatMap((manifest) => manifest.rows.map((row) => row.expected.id)))].filter((id) => !ids.has(id));
  return { extractedAt: snapshot.extractedAt, target: snapshot.target, total: snapshot.records.length,
    linkedPeople: snapshot.records.reduce((count, row) => count + row.cedarRidgeUserIds.length, 0),
    multiClientRecords: snapshot.records.filter((row) => row.cedarRidgeUserIds.length > 1).length,
    nonDeleted: snapshot.records.filter((record) => record.deletedAt === null).length,
    deleted: snapshot.records.filter((record) => record.deletedAt !== null).length,
    missingRecordIds, outcomes };
}
