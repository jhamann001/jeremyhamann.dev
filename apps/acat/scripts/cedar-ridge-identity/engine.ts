import { sha256 } from "./canonical";
import { approvalSchema, undoPlanSchema, type Approval, type AuditProvenance, type Evidence, type Manifest, type ManifestRow, type Outcome, type Receipt, type TrackerRow } from "./contracts";
import { validateManifest, verifyApproval, verifyManifestEvidence } from "./manifest";
import { assertSourcePolicy } from "./coverage";
import { validateEvidence } from "./match";
import { rejectLegacyWrite } from "./legacy";

export interface LockedRecord {
  identity: TrackerRow;
  /** All scalar business fields and stable relation identifiers, excluding identity/version/audits. */
  business: unknown;
}

export interface BackfillTransaction {
  lockRecord(id: string): Promise<LockedRecord | null>;
  /** Acquires A's publication share-lock and compares reviewed relevant evidence. */
  validateSource(row: ManifestRow, evidence: Evidence): Promise<{ snapshotId: string; directoryEvidenceHash: string }>;
  findApplication(runId: string, manifestHash: string, recordId: string): Promise<AuditProvenance | null>;
  writeIdentity(id: string, userIds: string[], expectedIdentityVersion: number): Promise<LockedRecord>;
  appendAudit(provenance: AuditProvenance): Promise<void>;
}

export interface BackfillStore {
  target: string;
  databaseName: string;
  installationId: string;
  transaction<T>(fn: (tx: BackfillTransaction) => Promise<T>): Promise<T>;
}

export function sameIdentity(a: TrackerRow, b: TrackerRow): boolean {
  return sha256(a) === sha256(b);
}

function replayIsCurrent(record: TrackerRow, prior: AuditProvenance): boolean {
  return sha256(record.cedarRidgeUserIds) === sha256(prior.newUserIds) && record.cedarRidgeUserId === prior.newUserId && record.identityVersion === prior.afterVersion;
}

/** Per-record transactions are resumable; committed progress is reconstructed from DB audits. */
export async function applyManifest(
  input: unknown, source: Evidence, approvalInput: unknown, store: BackfillStore,
  options: { now?: () => string; onOutcome?: (outcome: Outcome) => Promise<void> } = {},
): Promise<Receipt> {
  const manifest = validateManifest(input);
  if (manifest.preMigrationPlaceholders.length) throw new Error("PREMIGRATION_PLAN_CANNOT_APPLY");
  const approval = verifyApproval(manifest, approvalInput);
  if (manifest.target !== store.target || manifest.databaseName !== store.databaseName || !manifest.installationId || manifest.installationId !== store.installationId) throw new Error("TARGET_MISMATCH");
  source = validateEvidence(source);
  assertSourcePolicy(source);
  verifyManifestEvidence(manifest, source);
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const outcomes: Outcome[] = [];
  for (const row of manifest.rows) {
    let outcome: Outcome;
    if (row.decision.kind === "unresolved") {
      outcome = { recordId: row.expected.id, outcome: "unresolved" };
    } else {
      try {
        outcome = await store.transaction(async (tx) => applyRecord(tx, manifest, row, source, approval, now));
      } catch (error) {
        // Do not dump DB errors, URLs, or raw identity values to stdout/receipts.
        outcome = { recordId: row.expected.id, outcome: "conflict", code: safeErrorCode(error) };
      }
    }
    outcomes.push(outcome);
    await options.onOutcome?.(outcome);
  }
  return { version: 2, operation: "apply", runId: manifest.runId, manifestHash: approval.manifestHash,
    target: manifest.target, startedAt, finishedAt: now(), outcomes };
}

async function applyRecord(tx: BackfillTransaction, manifest: Manifest, row: ManifestRow, source: Evidence, approval: Approval, now: () => string): Promise<Outcome> {
  const recordId = row.expected.id;
  const before = await tx.lockRecord(recordId);
  if (!before) throw new Error("RECORD_MISSING");
  const prior = await tx.findApplication(manifest.runId, approval.manifestHash, recordId);
  if (prior) {
    if (!replayIsCurrent(before.identity, prior) || !sameIdentity(before.identity, { ...row.expected, cedarRidgeUserId: prior.newUserId, cedarRidgeUserIds: prior.newUserIds, identityVersion: prior.afterVersion })) throw new Error("APPLICATION_SUPERSEDED");
    return { recordId, outcome: "noop", provenance: prior };
  }
  if (!sameIdentity(before.identity, row.expected)) throw new Error("RECORD_CHANGED_SINCE_REVIEW");
  if (row.decision.kind === "unresolved") throw new Error("UNREVIEWED_DECISION");
  // Source checks apply to links. An approved exception does not pretend its
  // absent/ambiguous source is valid; it records exactly why the row is unlinked.
  let directoryProvenance: { snapshotId: string; directoryEvidenceHash: string } | null = null;
  if (row.decision.kind === "link") {
    if (!row.directoryEvidenceHash) throw new Error("DIRECTORY_EVIDENCE_NOT_BOUND");
    directoryProvenance = await tx.validateSource(row, source);
  }
  const beforeBusinessHash = sha256(before.business);
  const after = row.decision.kind === "link"
    ? await tx.writeIdentity(recordId, row.decision.userIds, before.identity.identityVersion)
    : before;
  const afterBusinessHash = sha256(after.business);
  if (beforeBusinessHash !== afterBusinessHash) throw new Error("BUSINESS_FIELDS_CHANGED");
  if (row.decision.kind === "link" && (sha256(after.identity.cedarRidgeUserIds) !== sha256(row.decision.userIds) || after.identity.identityVersion <= before.identity.identityVersion)) {
    throw new Error("IDENTITY_TRIGGER_MISMATCH");
  }
  const provenance: AuditProvenance = {
    version: 2, operation: row.decision.kind === "link" ? "apply" : "exception",
    runId: manifest.runId, manifestHash: approval.manifestHash, approvalReference: approval.reference,
    actor: approval.actor, recordId, oldUserId: before.identity.cedarRidgeUserId,
    newUserId: after.identity.cedarRidgeUserId, oldUserIds: before.identity.cedarRidgeUserIds, newUserIds: after.identity.cedarRidgeUserIds, beforeVersion: before.identity.identityVersion,
    afterVersion: after.identity.identityVersion, beforeBusinessHash, afterBusinessHash,
    evidenceHash: row.evidenceHash, reviewer: row.decision.reviewer, reason: row.decision.reason, timestamp: now(),
    directorySnapshotId: directoryProvenance?.snapshotId ?? null,
    directoryEvidenceHash: directoryProvenance?.directoryEvidenceHash ?? null,
  };
  await tx.appendAudit(provenance);
  return { recordId, outcome: row.decision.kind === "link" ? "applied" : "exception-recorded", provenance };
}

export function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "BACKFILL_OPERATION_FAILED";
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : "BACKFILL_OPERATION_FAILED";
}

export interface UndoRow {
  recordId: string;
  originalApplication: AuditProvenance;
  expected: TrackerRow;
}
export interface UndoPlan {
  version: 2;
  runId: string;
  originalManifestHash: string;
  generatedAt: string;
  target: string;
  databaseName: string;
  installationId: string;
  rows: UndoRow[];
}

export async function undoPlan(plan: UndoPlan, approval: Approval, store: BackfillStore, now = () => new Date().toISOString()): Promise<Receipt> {
  rejectLegacyWrite(plan);
  plan = undoPlanSchema.parse(plan);
  approval = approvalSchema.parse(approval);
  if (plan.rows.some((row) => row.recordId !== row.expected.id || row.recordId !== row.originalApplication.recordId)) throw new Error("UNDO_RECORD_MISMATCH");
  if (approval.manifestHash !== sha256(plan)) throw new Error("MANIFEST_APPROVAL_MISMATCH");
  if (plan.target !== store.target || plan.databaseName !== store.databaseName || plan.installationId !== store.installationId) throw new Error("TARGET_MISMATCH");
  if (new Set(plan.rows.map((row) => row.recordId)).size !== plan.rows.length) throw new Error("DUPLICATE_MANIFEST_RECORD");
  const startedAt = now();
  const outcomes: Outcome[] = [];
  for (const row of plan.rows) {
    try {
      const result = await store.transaction(async (tx): Promise<Outcome> => {
        const before = await tx.lockRecord(row.recordId);
        if (!before) throw new Error("RECORD_MISSING");
        const previousUndo = await tx.findApplication(plan.runId, approval.manifestHash, row.recordId);
        if (previousUndo) {
          if (!replayIsCurrent(before.identity, previousUndo) || !sameIdentity(before.identity, {
            ...row.expected, cedarRidgeUserId: previousUndo.newUserId, cedarRidgeUserIds: previousUndo.newUserIds, identityVersion: previousUndo.afterVersion,
          })) throw new Error("UNDO_SUPERSEDED");
          return { recordId: row.recordId, outcome: "noop", provenance: previousUndo };
        }
        const application = await tx.findApplication(row.originalApplication.runId, plan.originalManifestHash, row.recordId);
        if (!application || application.operation !== "apply" || sha256(application) !== sha256(row.originalApplication)) throw new Error("ORIGINAL_APPLICATION_NOT_VERIFIED");
        if (!sameIdentity(before.identity, row.expected) || !replayIsCurrent(before.identity, application)) throw new Error("UNDO_CONFLICT");
        const after = await tx.writeIdentity(row.recordId, application.oldUserIds, before.identity.identityVersion);
        const beforeBusinessHash = sha256(before.business);
        const afterBusinessHash = sha256(after.business);
        if (beforeBusinessHash !== afterBusinessHash) throw new Error("BUSINESS_FIELDS_CHANGED");
        if (sha256(after.identity.cedarRidgeUserIds) !== sha256(application.oldUserIds) || after.identity.identityVersion <= before.identity.identityVersion) throw new Error("IDENTITY_TRIGGER_MISMATCH");
        const provenance: AuditProvenance = { ...application, operation: "undo", runId: plan.runId,
          manifestHash: approval.manifestHash, approvalReference: approval.reference, actor: approval.actor,
          oldUserId: before.identity.cedarRidgeUserId, newUserId: after.identity.cedarRidgeUserId,
          oldUserIds: before.identity.cedarRidgeUserIds, newUserIds: after.identity.cedarRidgeUserIds,
          beforeVersion: before.identity.identityVersion, afterVersion: after.identity.identityVersion,
          beforeBusinessHash, afterBusinessHash, reason: `Undo approved application ${application.runId}`, timestamp: now() };
        await tx.appendAudit(provenance);
        return { recordId: row.recordId, outcome: "undone", provenance };
      });
      outcomes.push(result);
    } catch (error) {
      outcomes.push({ recordId: row.recordId, outcome: "conflict", code: safeErrorCode(error) });
    }
  }
  return { version: 2, operation: "undo", runId: plan.runId, manifestHash: approval.manifestHash,
    target: plan.target, startedAt, finishedAt: now(), outcomes };
}
