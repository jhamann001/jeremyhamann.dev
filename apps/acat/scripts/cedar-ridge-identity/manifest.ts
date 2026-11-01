import { randomUUID } from "node:crypto";
import { sha256 } from "./canonical";
import { approvalSchema, manifestSchema, trackerSnapshotSchema, type Approval, type Evidence, type Manifest, type TrackerSnapshot } from "./contracts";
import { matchRecord, validateEvidence } from "./match";
import { coverageSummary, sourceCoverage } from "./coverage";
import { rejectLegacyWrite } from "./legacy";

export function validateManifest(input: unknown): Manifest {
  rejectLegacyWrite(input);
  const manifest = manifestSchema.parse(input);
  const ids = new Set<string>();
  for (const row of manifest.rows) {
    if (ids.has(row.expected.id)) throw new Error("DUPLICATE_MANIFEST_RECORD");
    ids.add(row.expected.id);
    for (const candidates of [row.candidateIds, row.accountCandidateIds, row.transferCandidateIds, row.nameCandidateIds]) {
      if (new Set(candidates).size !== candidates.length) throw new Error("DUPLICATE_CANDIDATE");
    }
    if (row.decision.kind === "link") {
      if (row.expected.cedarRidgeUserIds.length) throw new Error("BACKFILL_CANNOT_RELINK");
      if (row.decision.userIds.some((id) => !row.candidateIds.includes(id))) throw new Error("DECISION_OUTSIDE_EVIDENCE");
      if (row.decision.userIds.length > 1 && row.category !== "joint-account-members") throw new Error("MULTI_LINK_REQUIRES_JOINT_ACCOUNT");
      if (row.category === "joint-account-members" && sha256(row.decision.userIds) !== sha256(row.accountCandidateIds)) throw new Error("JOINT_LINK_REQUIRES_COMPLETE_ACCOUNT_SET");
      if (row.category === "evidence-conflict") throw new Error("CONFLICTING_SOURCE_REQUIRES_NEW_EVIDENCE");
      if (row.category === "name-only" && !row.decision.corroboratingEvidence) throw new Error("NAME_ONLY_CORROBORATION_REQUIRED");
    }
    if (row.decision.kind === "exception" && row.expected.cedarRidgeUserIds.length) throw new Error("EXCEPTION_REQUIRES_UNLINKED_RECORD");
  }
  return manifest;
}

export function buildManifest(input: unknown, source: unknown, options: { now?: string; runId?: string } = {}): Manifest {
  rejectLegacyWrite(input);
  const tracker = trackerSnapshotSchema.parse(input);
  const evidence = validateEvidence(source);
  const rows = [...tracker.records].sort((a, b) => a.id.localeCompare(b.id)).map((record) => matchRecord(record, evidence));
  return validateManifest({
    version: 2, runId: options.runId ?? randomUUID(), generatedAt: options.now ?? new Date().toISOString(),
    target: tracker.target, databaseName: tracker.databaseName, trackerExtractedAt: tracker.extractedAt,
    installationId: tracker.installationId,
    trackerHash: sha256(tracker), evidenceHash: sha256(evidence), sourceSnapshotId: evidence.snapshotId, rows,
    sourceCoverage: sourceCoverage(evidence),
    preMigrationPlaceholders: tracker.preMigrationPlaceholders,
  });
}

export function verifyApproval(manifest: Manifest, value: unknown): Approval {
  const approval = approvalSchema.parse(value);
  if (approval.manifestHash !== sha256(manifest)) throw new Error("MANIFEST_APPROVAL_MISMATCH");
  return approval;
}

export function verifyManifestEvidence(manifest: Manifest, evidence: Evidence): void {
  validateEvidence(evidence);
  if (manifest.sourceCoverage && sha256(manifest.sourceCoverage) !== sha256(sourceCoverage(evidence))) throw new Error("SOURCE_COVERAGE_CHANGED_SINCE_REVIEW");
  for (const row of manifest.rows) {
    const current = matchRecord(row.expected, evidence);
    if (current.evidenceHash !== row.evidenceHash || current.category !== row.category ||
      (["candidateIds", "accountCandidateIds", "transferCandidateIds", "nameCandidateIds"] as const).some((key) => sha256(current[key]) !== sha256(row[key]))) {
      throw new Error("RELEVANT_SOURCE_EVIDENCE_CHANGED");
    }
  }
}

export function summarizeManifest(manifest: Manifest): Record<string, unknown> {
  const categories: Record<string, number> = {};
  const decisions: Record<string, number> = {};
  for (const row of manifest.rows) {
    categories[row.category] = (categories[row.category] ?? 0) + 1;
    decisions[row.decision.kind] = (decisions[row.decision.kind] ?? 0) + 1;
  }
  return { manifestHash: sha256(manifest), runId: manifest.runId, records: manifest.rows.length,
    version: manifest.version, reviewedLinkPeople: manifest.rows.reduce((count, row) => count + (row.decision.kind === "link" ? row.decision.userIds.length : 0), 0),
    sourceCoverage: coverageSummary(manifest.sourceCoverage),
    nonDeleted: manifest.rows.filter((row) => row.expected.deletedAt === null).length,
    deleted: manifest.rows.filter((row) => row.expected.deletedAt !== null).length, categories, decisions };
}

export function findCatchUpRecords(manifest: Manifest, current: TrackerSnapshot): { newRecordIds: string[]; changedRecordIds: string[]; missingRecordIds: string[] } {
  if (manifest.target !== current.target || manifest.databaseName !== current.databaseName || manifest.installationId !== current.installationId) throw new Error("TARGET_MISMATCH");
  const originals = new Map(manifest.rows.map((row) => [row.expected.id, row.expected]));
  const currentIds = new Set(current.records.map((row) => row.id));
  return {
    newRecordIds: current.records.filter((row) => !originals.has(row.id)).map((row) => row.id),
    changedRecordIds: current.records.filter((row) => originals.has(row.id) && sha256(row) !== sha256(originals.get(row.id))).map((row) => row.id),
    missingRecordIds: [...originals.keys()].filter((id) => !currentIds.has(id)),
  };
}
