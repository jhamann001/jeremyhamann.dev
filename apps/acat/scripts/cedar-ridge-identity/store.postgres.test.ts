// @vitest-environment node
import { PrismaClient, type CedarRidgeDirectorySync } from "@prisma/client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDirectoryInstallationId, replaceAcatRecordClients } from "../../src/lib/client-directory";
import { sha256 } from "./canonical";
import { applyManifest, undoPlan, type UndoPlan } from "./engine";
import { buildManifest } from "./manifest";
import { evidence, record, USER_A, USER_B, NOW } from "./fixtures/synthetic";
import { loadApplications, PrismaBackfillStore } from "./store";
import { reconcile } from "./verify";
import { databaseCommand } from "./database-cli";
import { writeRestricted } from "./files";
import type { Evidence, Manifest } from "./contracts";

const testUrl = process.env.BACKFILL_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/transfer_tracker_test") throw new Error("BACKFILL_TEST_REQUIRES_LOCAL_ISOLATED_DATABASE");
}
const suite = describe.skipIf(!testUrl);
const id = "identity-check-backfill-test-record";
const accountId = "identity-check-backfill-test-account";
const source = { ...evidence, accounts: [{ ...evidence.accounts[0], accountId }] };

suite("backfill with real PostgreSQL triggers and transactions", () => {
  let db: PrismaClient;
  let store: PrismaBackfillStore;
  let originalSync: CedarRidgeDirectorySync | undefined;
  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: testUrl });
    await db.$connect();
    const counts = await Promise.all([db.cedarRidgeClient.count(), db.cedarRidgeAccount.count(), db.acatRecord.count()]);
    if (counts.some((count) => count !== 0)) throw new Error("BACKFILL_TEST_REQUIRES_EMPTY_ISOLATED_DATABASE");
    originalSync = await db.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } });
    store = new PrismaBackfillStore(db, "local-test", "transfer_tracker_test", await getDirectoryInstallationId(db));
  });
  beforeEach(async () => {
    vi.stubEnv("CLIENT_DIRECTORY_MAX_AGE_SECONDS", "3600");
    vi.stubEnv("CLIENT_DIRECTORY_SOURCE_MAX_AGE_SECONDS", "3600");
    for (const client of evidence.clients) {
      await db.cedarRidgeClient.create({ data: { cedarRidgeUserId: client.userId, canonicalName: client.name, normalizedName: client.name.toLowerCase(), source: "synthetic", lastSeenSnapshotId: "backfill-test-snapshot" } });
    }
    await db.cedarRidgeAccount.create({ data: { investmentAccountId: accountId, custodian: "APEX", accountNumber: "SYNTHETIC1", normalizedAccountNumber: "SYNTHETIC1", lastSeenSnapshotId: "backfill-test-snapshot" } });
    await db.cedarRidgeAccountMember.create({ data: { investmentAccountId: accountId, cedarRidgeUserId: USER_A, relationshipType: "PRIMARY", lastSeenSnapshotId: "backfill-test-snapshot" } });
    await db.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { activeSnapshotId: "backfill-test-snapshot", lastSuccessAt: new Date(), sourceAsOf: new Date(), sourceHealth: "FRESH", lastErrorCode: null } });
    await db.acatRecord.create({ data: { id, clientName: record.clientName, apexAccountId: record.apexAccountId,
      acatTransferId: record.acatTransferId, acatDate: "2026-09-25", lastUpdated: "historical-value", statementAmount: 123456,
      status: "Completed", mappingAccountId: "mapping-preserved", deletedAt: new Date(NOW), assets: { create: { symbol: "SYNTH", description: "Synthetic asset" } } } });
  });
  async function restoreFixtures() {
    // Never remove pre-existing rows when the isolation guard rejected this DB.
    if (!originalSync) return;
    const state = originalSync;
    await db.$transaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { acatRecordId: id } });
      await tx.asset.deleteMany({ where: { acatRecordId: id } });
      await tx.acatRecord.deleteMany({ where: { id } });
      await tx.cedarRidgeAccountMember.deleteMany({ where: { investmentAccountId: accountId } });
      await tx.cedarRidgeAccount.deleteMany({ where: { investmentAccountId: accountId } });
      await tx.cedarRidgeClient.deleteMany({ where: { cedarRidgeUserId: { in: evidence.clients.map((client) => client.userId) } } });
      await tx.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: state });
    });
  }
  afterEach(async () => {
    try { await restoreFixtures(); } finally { vi.unstubAllEnvs(); }
  });
  afterAll(async () => {
    try { await restoreFixtures(); } finally { vi.unstubAllEnvs(); await db?.$disconnect(); }
  });

  async function approvedManifest(evidenceInput: Evidence = source, userIds = [USER_A]) {
    const manifest = buildManifest(await store.snapshot(), evidenceInput);
    // The fixture database is isolated, but deliberately target only our record
    // so another test suite's leftover fixtures cannot acquire fake approval.
    manifest.rows = manifest.rows.filter((row) => row.expected.id === id);
    manifest.rows[0].decision = { kind: "link", userIds, reviewer: "synthetic-operator", reviewedAt: NOW, reason: "Synthetic test approved membership" };
    return store.bind(manifest);
  }
  async function setClients(cedarRidgeUserIds: string[]) {
    return db.$transaction(async (tx) => {
      const current = await tx.acatRecord.findUniqueOrThrow({ where: { id } });
      return replaceAcatRecordClients(tx, { recordId: id, cedarRidgeUserIds, expectedIdentityVersion: current.identityVersion });
    });
  }
  async function jointFixture() {
    await db.cedarRidgeAccountMember.updateMany({ where: { investmentAccountId: accountId }, data: { relationshipType: "JOINT" } });
    await db.cedarRidgeAccountMember.create({ data: { investmentAccountId: accountId, cedarRidgeUserId: USER_B, relationshipType: "JOINT", lastSeenSnapshotId: "backfill-test-snapshot" } });
    const joint: Evidence = { ...source, accounts: [{ ...source.accounts[0], relationshipType: "JOINT" }, { ...source.accounts[0], userId: USER_B, relationshipType: "JOINT" }] };
    return { joint, manifest: await approvedManifest(joint, [USER_A, USER_B]) };
  }
  const approve = (value: unknown) => ({ manifestHash: sha256(value), actor: "synthetic-operator", reference: "synthetic-test-approval" });

  it("writes only identity, lets the trigger version advance, audits, and replays safely", async () => {
    const manifest = await approvedManifest();
    const before = await db.acatRecord.findUniqueOrThrow({ where: { id }, include: { assets: true } });
    const result = await applyManifest(manifest, source, approve(manifest), store);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].outcome).toBe("applied");
    const after = await db.acatRecord.findUniqueOrThrow({ where: { id }, include: { assets: true } });
    expect(after).toEqual({ ...before, cedarRidgeUserId: USER_A, identitySetIds: [USER_A], identityVersion: after.identityVersion });
    expect(await db.auditLog.count({ where: { acatRecordId: id } })).toBe(2);
    expect((await applyManifest(manifest, source, approve(manifest), store)).outcomes[0].outcome).toBe("noop");
    const verification = reconcile([manifest], await store.snapshot(), await loadApplications(db));
    expect(verification.outcomes.find((row) => row.recordId === id)?.status).toBe("backfill-link-needs-validation");
  });
  it("serializes competing approved applications without duplicate audits", async () => {
    const manifest = await approvedManifest();
    const results = await Promise.all([applyManifest(manifest, source, approve(manifest), store), applyManifest(manifest, source, approve(manifest), store)]);
    expect(results.map((result) => result.outcomes[0].outcome).sort()).toEqual(["applied", "noop"]);
    expect(await db.auditLog.count({ where: { acatRecordId: id } })).toBe(2);
  });
  it("accepts equivalent refreshed evidence and audits the snapshot actually validated", async () => {
    const manifest = await approvedManifest();
    await db.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { activeSnapshotId: "equivalent-refreshed-snapshot" } });
    await db.cedarRidgeClient.updateMany({ where: { cedarRidgeUserId: { in: [USER_A, USER_B] } }, data: { lastSeenSnapshotId: "equivalent-refreshed-snapshot" } });
    const result = await applyManifest(manifest, source, approve(manifest), store);
    expect(result.outcomes[0].outcome).toBe("applied");
    expect(result.outcomes[0].provenance).toMatchObject({ directorySnapshotId: "equivalent-refreshed-snapshot", directoryEvidenceHash: manifest.rows[0].directoryEvidenceHash });
    expect((await loadApplications(db, id))[0].directorySnapshotId).toBe("equivalent-refreshed-snapshot");
  });
  it("rolls back a real identity write if its audit cannot be committed", async () => {
    const manifest = await approvedManifest();
    const failingStore = {
      target: store.target, databaseName: store.databaseName, installationId: store.installationId,
      transaction: <T,>(fn: Parameters<PrismaBackfillStore["transaction"]>[0]) => store.transaction<T>((tx) => fn({ ...tx,
        appendAudit: async () => { throw new Error("AUDIT_WRITE_FAILED"); },
      }) as Promise<T>),
    };
    expect((await applyManifest(manifest, source, approve(manifest), failingStore)).outcomes[0].code).toBe("AUDIT_WRITE_FAILED");
    expect(await db.acatRecord.findUniqueOrThrow({ where: { id } })).toMatchObject({ cedarRidgeUserId: null, identityVersion: 0 });
    expect(await db.auditLog.count({ where: { acatRecordId: id } })).toBe(0);
  });
  it("refuses changed directory candidate facts and stale record decisions", async () => {
    const manifest = await approvedManifest();
    await db.cedarRidgeAccountMember.create({ data: { investmentAccountId: accountId, cedarRidgeUserId: USER_B, relationshipType: "JOINT", lastSeenSnapshotId: "backfill-test-snapshot" } });
    expect((await applyManifest(manifest, source, approve(manifest), store)).outcomes[0].code).toBe("PUBLISHED_DIRECTORY_EVIDENCE_CHANGED");
    await db.acatRecord.update({ where: { id }, data: { clientName: "Changed historical name" } });
    expect((await applyManifest(manifest, source, approve(manifest), store)).outcomes[0].code).toBe("RECORD_CHANGED_SINCE_REVIEW");
  });
  it("detects relink-away-and-back through the DB version and rejects undo", async () => {
    const manifest = await approvedManifest();
    await applyManifest(manifest, source, approve(manifest), store);
    const application = (await loadApplications(db, id))[0];
    const plan: UndoPlan = { version: 2, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", originalManifestHash: sha256(manifest), generatedAt: NOW, target: store.target, databaseName: store.databaseName, installationId: store.installationId,
      rows: [{ recordId: id, originalApplication: application, expected: (await store.snapshot()).records.find((row) => row.id === id)! }] };
    await setClients([USER_B]);
    await setClients([USER_A]);
    expect((await db.acatRecord.findUniqueOrThrow({ where: { id } })).identityVersion).toBeGreaterThan(application.afterVersion);
    expect((await undoPlan(plan, approve(plan), store)).outcomes[0].code).toBe("UNDO_CONFLICT");
  });
  it("undo preserves all business fields and cannot restore an older version number", async () => {
    const manifest = await approvedManifest();
    const before = await db.acatRecord.findUniqueOrThrow({ where: { id } });
    await applyManifest(manifest, source, approve(manifest), store);
    const plan: UndoPlan = { version: 2, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", originalManifestHash: sha256(manifest), generatedAt: NOW, target: store.target, databaseName: store.databaseName, installationId: store.installationId,
      rows: [{ recordId: id, originalApplication: (await loadApplications(db, id))[0], expected: (await store.snapshot()).records.find((row) => row.id === id)! }] };
    expect((await undoPlan(plan, approve(plan), store)).outcomes[0].outcome).toBe("undone");
    expect(await db.acatRecord.findUniqueOrThrow({ where: { id } })).toEqual({ ...before, identityVersion: 2 });
    expect(await db.auditLog.count({ where: { acatRecordId: id } })).toBe(4);
  });
  it("records individual exceptions and invalidates the disposition on restoration", async () => {
    const manifest = buildManifest(await store.snapshot(), source);
    manifest.rows = manifest.rows.filter((row) => row.expected.id === id);
    manifest.rows[0].decision = { kind: "exception", reviewer: "synthetic-operator", reviewedAt: NOW, reason: "Synthetic accepted exception" };
    const outcome = (await applyManifest(manifest, source, approve(manifest), store)).outcomes[0];
    expect(outcome.outcome).toBe("exception-recorded");
    expect(outcome.provenance).toMatchObject({ directorySnapshotId: null, directoryEvidenceHash: null });
    await db.acatRecord.update({ where: { id }, data: { deletedAt: null } });
    expect((await applyManifest(manifest, source, approve(manifest), store)).outcomes[0].code).toBe("APPLICATION_SUPERSEDED");
    expect(reconcile([manifest], await store.snapshot(), await loadApplications(db)).outcomes.find((row) => row.recordId === id)?.status).toBe("unresolved");
  });
  async function verifyThroughCli(manifest: Manifest, evidenceInput: Evidence = source) {
    const directory = mkdtempSync(join(tmpdir(), "identity-check-verify-test-"));
    const oldExit = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const manifestPath = join(directory, "manifest.json"), evidencePath = join(directory, "evidence.json"), out = join(directory, "verification.json");
      writeRestricted(manifestPath, manifest); writeRestricted(evidencePath, evidenceInput);
      await databaseCommand("verify", { target: store.target, "database-url-env": "BACKFILL_TEST_DATABASE_URL", manifests: manifestPath, "evidence-files": evidencePath, out });
      return JSON.parse(readFileSync(out, "utf8"));
    } finally { process.exitCode = oldExit; log.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
  }
  it("cannot report completed audited links after reviewed directory facts drift", async () => {
    const manifest = await approvedManifest();
    await applyManifest(manifest, source, approve(manifest), store);
    expect((await verifyThroughCli(manifest)).complete).toBe(true);
    await db.cedarRidgeClient.update({ where: { cedarRidgeUserId: USER_A }, data: { canonicalName: "Changed source name" } });
    const result = await verifyThroughCli(manifest);
    expect(result.complete).toBe(false);
    expect(result.outcomes[0].status).toBe("backfill-link-unverified");
  });
  it("cannot report completion with stale source health even when every row was audited", async () => {
    const manifest = await approvedManifest();
    await applyManifest(manifest, source, approve(manifest), store);
    await db.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { sourceHealth: "STALE" } });
    const result = await verifyThroughCli(manifest);
    expect(result.complete).toBe(false);
    expect(result.directory.health).toBe("STALE");
  });
  it("applies, verifies and undoes both joint holders while preserving the historical name and deleted business record", async () => {
    const { joint, manifest } = await jointFixture();
    const before = await db.acatRecord.findUniqueOrThrow({ where: { id }, include: { assets: true } });
    const results = await Promise.all([applyManifest(manifest, joint, approve(manifest), store), applyManifest(manifest, joint, approve(manifest), store)]);
    expect(results.map((result) => result.outcomes[0].outcome).sort()).toEqual(["applied", "noop"]);
    const application = (await loadApplications(db, id))[0];
    expect(application).toMatchObject({ oldUserIds: [], newUserIds: [USER_A, USER_B], oldUserId: null, newUserId: null });
    const after = await db.acatRecord.findUniqueOrThrow({ where: { id }, include: { assets: true } });
    expect(after).toEqual({ ...before, identitySetIds: [USER_A, USER_B], identityVersion: application.afterVersion });
    expect(application.afterVersion).toBeGreaterThan(application.beforeVersion);
    const snapshot = await store.snapshot();
    expect(snapshot.records[0]).toMatchObject({ cedarRidgeUserIds: [USER_A, USER_B], cedarRidgeUserId: null });
    expect(snapshot.records[0]).not.toHaveProperty("identitySetIds");
    expect((await verifyThroughCli(manifest, joint))).toMatchObject({ complete: true, total: 1, linkedPeople: 2, multiClientRecords: 1, deleted: 1 });
    const reordered = await setClients([USER_B, USER_A]);
    expect(reordered.identityVersion).toBe(application.afterVersion);
    const plan: UndoPlan = { version: 2, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", originalManifestHash: sha256(manifest), generatedAt: NOW,
      target: store.target, databaseName: store.databaseName, installationId: store.installationId, rows: [{ recordId: id, originalApplication: application, expected: snapshot.records[0] }] };
    expect((await undoPlan(plan, approve(plan), store)).outcomes[0].outcome).toBe("undone");
    expect(await db.acatRecordClient.count({ where: { acatRecordId: id } })).toBe(0);
    const undone = await db.acatRecord.findUniqueOrThrow({ where: { id }, include: { assets: true } });
    expect(undone).toEqual({ ...before, identityVersion: undone.identityVersion });
    expect(undone.identityVersion).toBeGreaterThan(application.afterVersion);
    expect((await undoPlan(plan, approve(plan), store)).outcomes[0].outcome).toBe("noop");
  });
  it("rolls back the entire joint set and trigger state if its provenance fails", async () => {
    const { joint, manifest } = await jointFixture();
    const failingStore = { target: store.target, databaseName: store.databaseName, installationId: store.installationId,
      transaction: <T,>(fn: Parameters<PrismaBackfillStore["transaction"]>[0]) => store.transaction<T>((tx) => fn({ ...tx,
        appendAudit: async () => { throw new Error("AUDIT_WRITE_FAILED"); },
      }) as Promise<T>),
    };
    expect((await applyManifest(manifest, joint, approve(manifest), failingStore)).outcomes[0].code).toBe("AUDIT_WRITE_FAILED");
    expect(await db.acatRecordClient.count({ where: { acatRecordId: id } })).toBe(0);
    expect(await db.acatRecord.findUniqueOrThrow({ where: { id } })).toMatchObject({ identitySetIds: [], cedarRidgeUserId: null, identityVersion: 0 });
  });
  it("rejects stale joint membership before apply and after an audited application", async () => {
    const { joint, manifest } = await jointFixture();
    await db.cedarRidgeAccountMember.updateMany({ where: { cedarRidgeUserId: USER_B }, data: { isCurrent: false } });
    expect((await applyManifest(manifest, joint, approve(manifest), store)).outcomes[0].code).toBe("PUBLISHED_DIRECTORY_EVIDENCE_CHANGED");
    await db.cedarRidgeAccountMember.updateMany({ where: { cedarRidgeUserId: USER_B }, data: { isCurrent: true } });
    expect((await applyManifest(manifest, joint, approve(manifest), store)).outcomes[0].outcome).toBe("applied");
    await db.cedarRidgeAccountMember.updateMany({ where: { cedarRidgeUserId: USER_B }, data: { relationshipType: "AUTHORIZED" } });
    expect((await verifyThroughCli(manifest, joint))).toMatchObject({ complete: false, outcomes: [{ status: "backfill-link-unverified" }] });
  });
  it("rejects joint undo after a later set edit away and back to the same two people", async () => {
    const { joint, manifest } = await jointFixture();
    await applyManifest(manifest, joint, approve(manifest), store);
    const application = (await loadApplications(db, id))[0];
    const plan: UndoPlan = { version: 2, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", originalManifestHash: sha256(manifest), generatedAt: NOW,
      target: store.target, databaseName: store.databaseName, installationId: store.installationId,
      rows: [{ recordId: id, originalApplication: application, expected: (await store.snapshot()).records[0] }] };
    await setClients([USER_A]);
    await setClients([USER_A, USER_B]);
    expect((await applyManifest(manifest, joint, approve(manifest), store)).outcomes[0].code).toBe("APPLICATION_SUPERSEDED");
    expect((await undoPlan(plan, approve(plan), store)).outcomes[0].code).toBe("UNDO_CONFLICT");
  });
});
