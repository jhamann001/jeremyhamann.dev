import { Prisma, PrismaClient } from "@prisma/client";
import { getDirectoryInstallationId, lockDirectory, readBackfillDirectoryEvidence, resolveClientIdentities, replaceAcatRecordClients } from "../../src/lib/client-directory";
import { canonicalJson, normalizeName, sha256 } from "./canonical";
import { auditProvenanceSchema, trackerRowSchema, type AuditProvenance, type Evidence, type Manifest, type ManifestRow, type TrackerRow, type TrackerSnapshot } from "./contracts";
import { auditProvenanceSchema as legacyAuditSchema } from "./legacy-contracts";
import type { BackfillStore, BackfillTransaction, LockedRecord } from "./engine";

export const PROVENANCE_ACTION = "identity-backfill-provenance";
const scalarSelect = { id: true, cedarRidgeUserId: true, identityVersion: true, clientName: true, apexAccountId: true, acatTransferId: true, deletedAt: true, identitySetIds: true, clientLinks: { select: { cedarRidgeUserId: true }, orderBy: { cedarRidgeUserId: "asc" } } } as const;

function trackerRow(row: { deletedAt: Date | null } & Record<string, unknown>): TrackerRow {
  const links = row.clientLinks as Array<{ cedarRidgeUserId: string }>;
  const ids = links.map((link) => link.cedarRidgeUserId).sort();
  if (sha256(row.identitySetIds) !== sha256(ids)) throw new Error("IDENTITY_CACHE_MISMATCH");
  return trackerRowSchema.parse({ ...row, cedarRidgeUserIds: ids, deletedAt: row.deletedAt?.toISOString() ?? null });
}

async function recordState(tx: Prisma.TransactionClient, id: string): Promise<LockedRecord | null> {
  const row = await tx.acatRecord.findUnique({ where: { id }, include: {
    clientLinks: { select: { cedarRidgeUserId: true }, orderBy: { cedarRidgeUserId: "asc" } },
    assets: { select: { id: true, acatRecordId: true }, orderBy: { id: "asc" } },
    documents: { select: { id: true, acatRecordId: true, sha256: true }, orderBy: { id: "asc" } },
    dataQualityReviews: { select: { id: true, acatRecordId: true }, orderBy: { id: "asc" } },
  } });
  if (!row) return null;
  const { cedarRidgeUserId: _id, identityVersion: _version, identitySetIds: _cache, clientLinks: _links, ...business } = row;
  void _id; void _version; void _cache; void _links;
  return { identity: trackerRow(row), business };
}

export function directoryEvidenceDigest(view: Awaited<ReturnType<typeof readBackfillDirectoryEvidence>>): string {
  // Snapshot identity and retrieval clock may advance without changing facts.
  return sha256({ freshnessBasis: view.freshnessBasis, accounts: view.accounts, clients: view.clients });
}

export async function readDirectoryBinding(tx: Prisma.TransactionClient, row: ManifestRow) {
  const ids = [...new Set([...row.candidateIds, ...row.nameCandidateIds, ...row.expected.cedarRidgeUserIds])].sort();
  return readBackfillDirectoryEvidence(tx, { accountNumber: row.expected.apexAccountId, candidateUserIds: ids });
}

export async function validateReviewedSource(tx: Prisma.TransactionClient, row: ManifestRow, evidence: Evidence): Promise<{ snapshotId: string; directoryEvidenceHash: string }> {
  const view = await readDirectoryBinding(tx, row);
  if (row.directoryEvidenceHash !== directoryEvidenceDigest(view)) throw new Error("PUBLISHED_DIRECTORY_EVIDENCE_CHANGED");
  if (row.decision.kind !== "link") throw new Error("UNREVIEWED_DECISION");
  const selectedIds = row.decision.userIds;
  for (const selectedId of selectedIds) {
    const selected = view.clients.find((client) => client.cedarRidgeUserId === selectedId);
    const sourceClient = evidence.clients.find((client) => client.userId === selectedId);
    if (!selected || !sourceClient || normalizeName(selected.canonicalName) !== normalizeName(sourceClient.name)) throw new Error("REVIEWED_CLIENT_NAME_CHANGED");
  }
  if (selectedIds.length > 1) {
    if (sha256(selectedIds) !== sha256(row.accountCandidateIds)) throw new Error("JOINT_LINK_REQUIRES_COMPLETE_ACCOUNT_SET");
    await resolveClientIdentities(tx, { cedarRidgeUserIds: selectedIds, apexAccountId: row.expected.apexAccountId, allowHistoricalAccount: true });
  } else {
    const selectedId = selectedIds[0];
    const member = view.accounts.some((account) => account.members.some((entry) => entry.cedarRidgeUserId === selectedId));
    if (member) {
      await resolveClientIdentities(tx, { cedarRidgeUserIds: selectedIds, apexAccountId: row.expected.apexAccountId, allowHistoricalAccount: true });
    } else {
      // A singleton historical dossier is explicit evidence, never a pending-account bypass.
      if (!row.decision.corroboratingEvidence || !row.candidateIds.includes(selectedId)) throw new Error("MANUAL_CORROBORATION_REQUIRED");
      if (row.category !== "name-only" && !row.transferCandidateIds.includes(selectedId)) throw new Error("HISTORICAL_MEMBERSHIP_NOT_CORROBORATED");
    }
  }
  return { snapshotId: view.snapshotId, directoryEvidenceHash: directoryEvidenceDigest(view) };
}

export function parseProvenance(value: string | null) {
  if (!value) throw new Error("AUDIT_PROVENANCE_INVALID");
  const input: unknown = JSON.parse(value);
  const parsed = auditProvenanceSchema.or(legacyAuditSchema).safeParse(input);
  if (!parsed.success) throw new Error("AUDIT_PROVENANCE_INVALID");
  return parsed.data;
}

export async function loadApplications(tx: Prisma.TransactionClient, recordId?: string): Promise<AuditProvenance[]> {
  const rows = await tx.auditLog.findMany({ where: { action: PROVENANCE_ACTION, ...(recordId ? { acatRecordId: recordId } : {}) }, orderBy: [{ timestamp: "asc" }, { id: "asc" }], select: { newValue: true } });
  // v1 audits remain readable but cannot prove or authorize an authoritative set.
  return rows.map((row) => parseProvenance(row.newValue)).filter((audit): audit is AuditProvenance => audit.version === 2);
}

function adapter(tx: Prisma.TransactionClient): BackfillTransaction {
  return {
    lockRecord: async (id) => {
      await tx.$queryRaw`SELECT "id" FROM "AcatRecord" WHERE "id" = ${id} FOR UPDATE`;
      return recordState(tx, id);
    },
    validateSource: (row, evidence) => validateReviewedSource(tx, row, evidence),
    findApplication: async (runId, manifestHash, recordId) => {
      const applications = (await loadApplications(tx, recordId)).filter((item) => item.runId === runId && item.manifestHash === manifestHash);
      if (applications.length > 1) throw new Error("DUPLICATE_AUDIT_APPLICATION");
      return applications[0] ?? null;
    },
    writeIdentity: async (id, userIds, expectedIdentityVersion) => {
      // Shared setter changes junction rows only; PostgreSQL owns cache/projection/version.
      await replaceAcatRecordClients(tx, { recordId: id, cedarRidgeUserIds: userIds, expectedIdentityVersion });
      const after = await recordState(tx, id);
      if (!after) throw new Error("RECORD_MISSING");
      return after;
    },
    appendAudit: async (provenance) => {
      const audit = { acatRecordId: provenance.recordId, performedBy: provenance.actor, timestamp: new Date(provenance.timestamp) };
      if (provenance.operation !== "exception") {
        await tx.auditLog.create({ data: { ...audit, action: `identity-backfill-${provenance.operation}`,
          field: "cedarRidgeUserIds", oldValue: canonicalJson(provenance.oldUserIds), newValue: canonicalJson(provenance.newUserIds) } });
      }
      await tx.auditLog.create({ data: { ...audit, action: PROVENANCE_ACTION, field: "identityBackfillProvenance", newValue: canonicalJson(provenance) } });
    },
  };
}

export class PrismaBackfillStore implements BackfillStore {
  constructor(readonly db: PrismaClient, readonly target: string, readonly databaseName: string, readonly installationId: string) {}
  async transaction<T>(fn: (tx: BackfillTransaction) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx) => {
      // Universal lock order: publication singleton, then transfer. A queued
      // publisher must not deadlock a backfill against a normal relink writer.
      await lockDirectory(tx);
      if (await getDirectoryInstallationId(tx) !== this.installationId) throw new Error("DATABASE_INSTALLATION_CHANGED");
      return fn(adapter(tx));
    }, { timeout: 15000, maxWait: 10000 });
  }
  async snapshot(): Promise<TrackerSnapshot> {
    return this.db.$transaction((tx) => this.snapshotWithin(tx), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async snapshotWithin(tx: Prisma.TransactionClient): Promise<TrackerSnapshot> {
    if (await getDirectoryInstallationId(tx) !== this.installationId) throw new Error("DATABASE_INSTALLATION_CHANGED");
    const records = await tx.acatRecord.findMany({ select: scalarSelect, orderBy: { id: "asc" } });
    return { version: 2, extractedAt: new Date().toISOString(), target: this.target, databaseName: this.databaseName,
      installationId: this.installationId,
      preMigrationPlaceholders: [], records: records.map(trackerRow) };
  }
  async bind(manifest: Manifest): Promise<Manifest> {
    if (manifest.target !== this.target || manifest.databaseName !== this.databaseName || !manifest.installationId || manifest.installationId !== this.installationId) throw new Error("TARGET_MISMATCH");
    if (manifest.preMigrationPlaceholders.length) throw new Error("PREMIGRATION_PLAN_CANNOT_APPLY");
    return this.db.$transaction(async (tx) => {
      await lockDirectory(tx);
      if (await getDirectoryInstallationId(tx) !== this.installationId) throw new Error("DATABASE_INSTALLATION_CHANGED");
      const copy = structuredClone(manifest);
      for (const row of copy.rows) {
        if (row.decision.kind === "link") row.directoryEvidenceHash = directoryEvidenceDigest(await readDirectoryBinding(tx, row));
      }
      return copy;
    }, { timeout: 60000, maxWait: 10000 });
  }
}

export async function connectStore(databaseUrl: string, target: string): Promise<PrismaBackfillStore> {
  if (!target || !databaseUrl) throw new Error("EXPLICIT_DATABASE_TARGET_REQUIRED");
  const db = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
  try {
    const [row] = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    return new PrismaBackfillStore(db, target, row.name, await getDirectoryInstallationId(db));
  } catch (error) { await db.$disconnect(); throw error; }
}
