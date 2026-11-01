// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient, type CedarRidgeDirectorySync } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAcatRecordClients, getDirectoryInstallationId, getDirectoryStatus, lockDirectory, readBackfillDirectoryEvidence,
  replaceAcatRecordClients, resolveClientIdentities, resolveClientIdentity, searchClients } from "./repository";
import { parseDirectoryRows, type DirectorySnapshot } from "./source";
import { publishDirectorySnapshot, recordDirectoryFailure, reserveDirectoryAttempt } from "./sync";
import { alice, bob, directoryRows } from "./test-fixtures";

// Run separately from other identity DB suites: a snapshot is intentionally a
// global publication. Only an empty, explicit localhost test directory is used.
const enabled = process.env.ACAT_DIRECTORY_DATABASE_TEST === "1";
const clientIds = new Set<string>();
const accountIds = new Set<string>();
const recordIds = new Set<string>();
let originalState: CedarRidgeDirectorySync;
let observer: PrismaClient;

function track(snapshot: DirectorySnapshot) {
  snapshot.clients.forEach((c) => clientIds.add(c.cedarRidgeUserId));
  snapshot.accounts.forEach((a) => accountIds.add(a.investmentAccountId));
  return snapshot;
}
async function publish(rows = directoryRows()) {
  const snapshot = track(parseDirectoryRows(rows));
  const generation = await reserveDirectoryAttempt();
  const result = await publishDirectorySnapshot(generation, snapshot);
  return { snapshot, generation, result };
}
function jointRows() {
  const rows = directoryRows();
  rows.forEach((row) => { if (row.row_kind === "membership") row.relationship_type = "JOINT"; });
  rows.find((row) => row.row_kind === "client" && row.cedar_ridge_user_id === bob)!.canonical_name = "Bea Example";
  return rows;
}
async function createRecord() {
  const id = `synthetic-identity-${randomUUID()}`; recordIds.add(id);
  return prisma.acatRecord.create({ data: { id, clientName: "Historical display", apexAccountId: "001ABC12",
    acatDate: "2026-09-01", lastUpdated: "synthetic-business-clock", identityVersion: 99, identitySetIds: [alice] } });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function expectPublicationWaiter(table = "CedarRidgeDirectorySync") {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const waiting = await observer.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND query LIKE ${`%${table}%`}
    `;
    if (waiting.length) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("Expected a competing writer to wait for the held lock");
}

describe.skipIf(!enabled)("client identity directory against PostgreSQL 16", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/transfer_tracker_test") {
      throw new Error("Directory tests require an explicit localhost transfer_tracker_test database");
    }
    if (await prisma.cedarRidgeClient.count() || await prisma.cedarRidgeAccount.count()) {
      throw new Error("Directory tests require an empty directory; no existing rows will be overwritten");
    }
    originalState = await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } });
    url.searchParams.set("connection_limit", "1");
    observer = new PrismaClient({ datasourceUrl: url.toString() });
    await observer.$connect();
  });
  beforeEach(() => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "UPSTREAM_VERIFIED");
    vi.stubEnv("CLIENT_SEARCH_CRM_ONLY", "false");
    vi.stubEnv("CLIENT_IDENTITY_ENABLED", "true"); vi.stubEnv("CLIENT_DIRECTORY_MAX_AGE_SECONDS", "3600");
    vi.stubEnv("CLIENT_DIRECTORY_SOURCE_MAX_AGE_SECONDS", "7200"); vi.stubEnv("CLIENT_DIRECTORY_MAX_REMOVAL_PERCENT", "100");
  });
  afterEach(async () => {
    if (!originalState) return;
    await prisma.acatRecord.deleteMany({ where: { id: { in: [...recordIds] } } });
    await prisma.cedarRidgeAccountMember.deleteMany({ where: { investmentAccountId: { in: [...accountIds] } } });
    await prisma.cedarRidgeAccount.deleteMany({ where: { investmentAccountId: { in: [...accountIds] } } });
    await prisma.cedarRidgeClient.deleteMany({ where: { cedarRidgeUserId: { in: [...clientIds] } } });
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: originalState });
    recordIds.clear(); accountIds.clear(); clientIds.clear(); vi.unstubAllEnvs();
  });
  afterAll(async () => { await Promise.all([prisma.$disconnect(), observer?.$disconnect()]); });

  it("keeps the installation binding stable across attempts and publications without exposing it in status", async () => {
    const installationId = await getDirectoryInstallationId();
    expect(installationId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    await publish();
    await reserveDirectoryAttempt();
    expect(await getDirectoryInstallationId()).toBe(installationId);
    expect(await getDirectoryStatus()).not.toHaveProperty("installationId");
  });

  it("fences pre-upgrade fetches and pauses identity validation until a new post-upgrade publication", async () => {
    const { snapshot } = await publish(jointRows());
    const record = await createRecord();
    await prisma.$transaction((tx) => replaceAcatRecordClients(tx, {
      recordId: record.id, cedarRidgeUserIds: [alice, bob], expectedIdentityVersion: 0,
    }));
    const inflight = await reserveDirectoryAttempt();
    const before = await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } });
    // Exercise the actual migration's first statement, not a mirrored pause.
    // Full schema replay (including legacy seeding) is a separate release check.
    const migration = readFileSync(new URL("../../../prisma/migrations/20260925170000_acat_record_clients/migration.sql", import.meta.url), "utf8");
    const startMarker = "DO $acat_joint_upgrade_pause$";
    const endMarker = "$acat_joint_upgrade_pause$;";
    const start = migration.indexOf(startMarker);
    const end = migration.indexOf(endMarker, start + startMarker.length);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(migration.slice(0, start).split("\n").map((line) => line.trim())
      .filter((line) => line && !line.startsWith("--"))).toEqual(["BEGIN;"]);
    const pause = migration.slice(start, end + endMarker.length);
    const writerEntered = deferred(); const releaseWriter = deferred();
    const writer = prisma.$transaction(async (tx) => {
      await lockDirectory(tx); writerEntered.resolve(); await releaseWriter.promise;
    });
    await writerEntered.promise;
    const pausing = Promise.resolve(prisma.$executeRawUnsafe(pause));
    try { await expectPublicationWaiter(); }
    finally { releaseWriter.resolve(); await writer; }
    await pausing;
    expect(await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } })).toEqual({
      ...before, attemptGeneration: before.attemptGeneration + 1, lastErrorCode: "JOINT_UPGRADE_PAUSED",
    });
    expect(await publishDirectorySnapshot(inflight, snapshot)).toMatchObject({ status: "superseded" });
    await recordDirectoryFailure(inflight, "SOURCE_HTTP_ERROR");
    expect((await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } })).lastErrorCode).toBe("JOINT_UPGRADE_PAUSED");
    vi.stubEnv("CLIENT_IDENTITY_ENABLED", "false");
    expect(await getDirectoryStatus()).toMatchObject({ health: "UNAVAILABLE", writeEligible: false });
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      await expect(resolveClientIdentity(tx, { cedarRidgeUserId: alice, apexAccountId: "001ABC12" })).rejects.toMatchObject({ code: "DIRECTORY_UNAVAILABLE" });
      await expect(resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12" })).rejects.toMatchObject({ code: "DIRECTORY_UNAVAILABLE" });
      await tx.acatRecord.update({ where: { id: record.id }, data: { notes: "Operational edits remain available" } });
      expect((await getAcatRecordClients(tx, record.id)).cedarRidgeUserIds).toEqual([alice, bob]);
    });
    const afterCutover = await reserveDirectoryAttempt();
    expect(await publishDirectorySnapshot(afterCutover, snapshot)).toMatchObject({ status: "published" });
    expect(await getDirectoryStatus()).toMatchObject({ enabled: false, health: "FRESH", writeEligible: false });
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      expect((await resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12" })).cedarRidgeUserIds).toEqual([alice, bob]);
    });
  });

  it("owns version increments for direct SQL/legacy writers without changing business timestamps", async () => {
    await publish();
    const id = `synthetic-identity-${randomUUID()}`; recordIds.add(id);
    const originalUpdated = "2026-09-01T13:00:00.000Z";
    const row = await prisma.acatRecord.create({ data: {
      id, clientName: "Original Example", apexAccountId: "001ABC12", acatDate: "2026-09-01",
      lastUpdated: originalUpdated, identityVersion: 999,
    } });
    expect(row.identityVersion).toBe(0);
    await prisma.$executeRaw`UPDATE "AcatRecord" SET "notes" = 'synthetic', "identityVersion" = 999 WHERE "id" = ${id}`;
    expect((await prisma.acatRecord.findUniqueOrThrow({ where: { id } })).identityVersion).toBe(0);
    await prisma.$executeRaw`UPDATE "AcatRecord" SET "clientName" = 'Renamed Example' WHERE "id" = ${id}`;
    await prisma.$executeRaw`UPDATE "AcatRecord" SET "apexAccountId" = 'CHANGED' WHERE "id" = ${id}`;
    await prisma.$executeRaw`UPDATE "AcatRecord" SET "acatTransferId" = 'synthetic-transfer' WHERE "id" = ${id}`;
    await expect(prisma.$executeRaw`UPDATE "AcatRecord" SET "cedar_ridge_user_id" = ${alice}, "identityVersion" = 0 WHERE "id" = ${id}`).rejects.toThrow();
    await prisma.acatRecordClient.create({ data: { acatRecordId: id, cedarRidgeUserId: alice } });
    expect((await prisma.acatRecord.findUniqueOrThrow({ where: { id } })).identityVersion).toBe(4);
    await prisma.acatRecordClient.deleteMany({ where: { acatRecordId: id } });
    await prisma.$executeRaw`UPDATE "AcatRecord" SET "apexAccountId" = '001ABC12' WHERE "id" = ${id}`;
    await prisma.$executeRaw`UPDATE "AcatRecord" SET "identityVersion" = 0 WHERE "id" = ${id}`;
    expect(await prisma.acatRecord.findUniqueOrThrow({ where: { id } })).toMatchObject({ identityVersion: 6, lastUpdated: originalUpdated });
    // Undoing a previous identity does not undo the version history.
    await prisma.acatRecordClient.create({ data: { acatRecordId: id, cedarRidgeUserId: alice } });
    expect((await prisma.acatRecord.findUniqueOrThrow({ where: { id } })).identityVersion).toBe(7);
    await expect(prisma.cedarRidgeClient.delete({ where: { cedarRidgeUserId: alice } })).rejects.toThrow();
    await expect(prisma.acatRecord.update({ where: { id }, data: { cedarRidgeUserId: "user-99999999-9999-4999-8999-999999999999" } })).rejects.toThrow();
  });

  it("links the complete joint set in deterministic order without choosing a primary or changing business fields", async () => {
    await publish(jointRows()); const record = await createRecord();
    expect(record).toMatchObject({ identityVersion: 0, identitySetIds: [], cedarRidgeUserId: null });
    const updated = await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      const resolved = await resolveClientIdentities(tx, { cedarRidgeUserIds: [bob, alice], apexAccountId: " 001abc12 " });
      expect(resolved).toMatchObject({ cedarRidgeUserIds: [alice, bob], canonicalName: "Alex Example & Bea Example", freshnessBasis: "UPSTREAM_VERIFIED" });
      expect(resolved.clients.map((client) => client.relationshipType)).toEqual(["JOINT", "JOINT"]);
      expect((await resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12" })).evidenceDigest).toBe(resolved.evidenceDigest);
      return replaceAcatRecordClients(tx, { recordId: record.id, cedarRidgeUserIds: resolved.cedarRidgeUserIds, expectedIdentityVersion: 0 });
    });
    expect(updated).toMatchObject({ cedarRidgeUserIds: [alice, bob], cedarRidgeUserId: null });
    expect(updated.identityVersion).toBeGreaterThan(0);
    expect(await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      identitySetIds: [alice, bob], clientName: "Historical display", lastUpdated: "synthetic-business-clock" });
    expect(await getAcatRecordClients(prisma, record.id)).toEqual({ cedarRidgeUserIds: [alice, bob],
      linkedClients: [{ cedarRidgeUserId: alice, displayName: "Alex Example" }, { cedarRidgeUserId: bob, displayName: "Bea Example" }] });
  });

  it("makes order-only sets a no-op and owns singleton projection and empty-set undo", async () => {
    await publish(jointRows()); const record = await createRecord();
    const set = (cedarRidgeUserIds: string[], expectedIdentityVersion: number) => prisma.$transaction((tx) =>
      replaceAcatRecordClients(tx, { recordId: record.id, cedarRidgeUserIds, expectedIdentityVersion }));
    const single = await set([alice], 0); expect(single.cedarRidgeUserId).toBe(alice);
    const joint = await set([bob, alice], single.identityVersion); expect(joint.cedarRidgeUserId).toBeNull();
    expect(await set([alice, bob], joint.identityVersion)).toEqual(joint);
    const renamedSet = await set([bob], joint.identityVersion); expect(renamedSet.cedarRidgeUserId).toBe(bob);
    expect(renamedSet.identityVersion).toBeGreaterThan(joint.identityVersion);
    const undo = await set([], renamedSet.identityVersion); expect(undo.cedarRidgeUserId).toBeNull();
    expect(undo.cedarRidgeUserIds).toEqual([]); expect(undo.identityVersion).toBeGreaterThan(renamedSet.identityVersion);
    expect(await set([], undo.identityVersion)).toEqual(undo);
  });

  it("prevents direct SQL from resetting joint version/cache or assigning an arbitrary scalar primary", async () => {
    await publish(jointRows()); const record = await createRecord();
    await prisma.acatRecordClient.createMany({ data: [alice, bob].map((cedarRidgeUserId) => ({ acatRecordId: record.id, cedarRidgeUserId })) });
    const joint = await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } });
    await prisma.$executeRaw`UPDATE "AcatRecord" SET "identityVersion" = 0, "_identity_set_ids" = ARRAY[]::text[] WHERE id=${record.id}`;
    expect(await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      identityVersion: joint.identityVersion, identitySetIds: [alice, bob], cedarRidgeUserId: null });
    await expect(prisma.acatRecord.update({ where: { id: record.id }, data: { cedarRidgeUserId: alice } })).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE "AcatRecordClient" SET "cedar_ridge_user_id"=${alice} WHERE "acatRecordId"=${record.id} AND "cedar_ridge_user_id"=${bob}`).rejects.toThrow("ACAT_LINK_KEYS_IMMUTABLE");
    await expect(prisma.$executeRaw`TRUNCATE "AcatRecordClient"`).rejects.toThrow("ACAT_LINK_TRUNCATE_FORBIDDEN");
    await prisma.$executeRaw`UPDATE "AcatRecordClient" SET "cedar_ridge_user_id"="cedar_ridge_user_id" WHERE "acatRecordId"=${record.id}`;
    expect((await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } })).identityVersion).toBe(joint.identityVersion);
    await expect(prisma.cedarRidgeClient.delete({ where: { cedarRidgeUserId: bob } })).rejects.toThrow();
    await prisma.acatRecordClient.delete({ where: { acatRecordId_cedarRidgeUserId: { acatRecordId: record.id, cedarRidgeUserId: alice } } });
    const single = await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(single).toMatchObject({ cedarRidgeUserId: bob, identitySetIds: [bob] });
    expect(single.identityVersion).toBeGreaterThan(joint.identityVersion);
  });

  it("requires complete all-JOINT membership, rejects unrelated/partial/no-account sets, and retains singleton pending policy", async () => {
    const charlie = "user-33333333-3333-4333-8333-333333333333";
    const rows = jointRows(); rows[0].expected_clients = 3; rows[0].expected_memberships = 3;
    rows.push({ row_kind: "client", cedar_ridge_user_id: charlie, canonical_name: "Charlie Example", eligibility: "ACTIVE", source: "synthetic" });
    rows.push({ row_kind: "membership", cedar_ridge_user_id: charlie, investment_account_id: "synthetic-directory-account", relationship_type: "JOINT" });
    await publish(rows);
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      await expect(resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12" })).rejects.toMatchObject({ code: "ACCOUNT_NOT_LINKED" });
      await expect(resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "", allowPendingAccount: true })).rejects.toMatchObject({ code: "ACCOUNT_NOT_LINKED" });
      await expect(resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob, "user-99999999-9999-4999-8999-999999999999"], apexAccountId: "001ABC12" })).rejects.toMatchObject({ code: "ACCOUNT_NOT_LINKED" });
      await expect(resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, alice], apexAccountId: "001ABC12" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect((await resolveClientIdentities(tx, { cedarRidgeUserIds: [alice], apexAccountId: "", allowPendingAccount: true })).clients[0].investmentAccountId).toBeNull();
      expect((await resolveClientIdentities(tx, { cedarRidgeUserIds: [charlie, bob, alice], apexAccountId: "001ABC12" })).cedarRidgeUserIds).toEqual([alice, bob, charlie]);
    });
    const mixed = jointRows(); mixed.find((row) => row.row_kind === "membership")!.relationship_type = "PRIMARY";
    await publish(mixed);
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      await expect(resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12" })).rejects.toMatchObject({ code: "ACCOUNT_NOT_LINKED" });
    });
  });

  it("requires explicit historical permission for closed joint accounts and fresh evidence for every linked set", async () => {
    const rows = jointRows(); rows.find((row) => row.row_kind === "account")!.account_status = "CLOSED";
    await publish(rows);
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      await expect(resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12" })).rejects.toMatchObject({ code: "ACCOUNT_NOT_LINKED" });
      expect((await resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12", allowHistoricalAccount: true })).clients).toHaveLength(2);
    });
    await recordDirectoryFailure(await reserveDirectoryAttempt(), "SOURCE_HTTP_ERROR");
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      await expect(resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12", allowHistoricalAccount: true })).rejects.toMatchObject({ code: "DIRECTORY_UNAVAILABLE" });
    });
  });

  it("serializes simultaneous client-set replacements and rejects the stale version", async () => {
    await publish(jointRows()); const record = await createRecord();
    const results = await Promise.allSettled([[alice], [alice, bob]].map((cedarRidgeUserIds) =>
      prisma.$transaction((tx) => replaceAcatRecordClients(tx, { recordId: record.id, cedarRidgeUserIds, expectedIdentityVersion: 0 }))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "IDENTITY_CONFLICT", httpStatus: 409 });
    const saved = await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(saved.identitySetIds).toEqual((await getAcatRecordClients(prisma, record.id)).cedarRidgeUserIds);
  });

  it("recomputes the full set after a direct SQL link insertion waits on another committed link", async () => {
    await publish(jointRows()); const record = await createRecord();
    const held = deferred(); const release = deferred();
    const first = prisma.$transaction(async (tx) => {
      await tx.acatRecordClient.create({ data: { acatRecordId: record.id, cedarRidgeUserId: alice } });
      held.resolve(); await release.promise;
    });
    await held.promise;
    // Prisma promises are lazy; assimilate it now so the competing INSERT is
    // actually executing while pg_stat_activity observes its lock wait.
    const second = Promise.resolve(prisma.acatRecordClient.create({ data: { acatRecordId: record.id, cedarRidgeUserId: bob } }));
    try { await expectPublicationWaiter("AcatRecordClient"); } finally { release.resolve(); }
    await first; await second;
    expect(await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } }))
      .toMatchObject({ identitySetIds: [alice, bob], identityVersion: 2, cedarRidgeUserId: null });
  });

  it("keeps joint-set validation and commit ahead of a waiting directory publication", async () => {
    await publish(jointRows()); const record = await createRecord();
    const generation = await reserveDirectoryAttempt();
    const changed = jointRows(); changed[2].canonical_name = "Changed Bea Example";
    const next = track(parseDirectoryRows(changed));
    const held = deferred(); const release = deferred();
    const writer = prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      await resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12" });
      await replaceAcatRecordClients(tx, { recordId: record.id, cedarRidgeUserIds: [alice, bob], expectedIdentityVersion: 0 });
      held.resolve(); await release.promise;
      expect((await resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12" })).canonicalName).toBe("Alex Example & Bea Example");
    });
    await held.promise;
    const publisher = publishDirectorySnapshot(generation, next);
    try { await expectPublicationWaiter(); } finally { release.resolve(); }
    await writer; expect((await publisher).status).toBe("published");
    expect((await getAcatRecordClients(prisma, record.id)).linkedClients[1].displayName).toBe("Changed Bea Example");
  });

  it("rolls back link/version changes together when a later identity audit step fails", async () => {
    await publish(jointRows()); const record = await createRecord();
    await expect(prisma.$transaction(async (tx) => {
      await replaceAcatRecordClients(tx, { recordId: record.id, cedarRidgeUserIds: [alice, bob], expectedIdentityVersion: 0 });
      throw new Error("synthetic-audit-failure");
    })).rejects.toThrow("synthetic-audit-failure");
    expect(await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({ identityVersion: 0, identitySetIds: [], cedarRidgeUserId: null });
    expect((await getAcatRecordClients(prisma, record.id)).cedarRidgeUserIds).toEqual([]);
  });

  it("returns both duplicate-name joint members and checks account membership independently of the UI flag", async () => {
    await publish();
    const response = await searchClients(" Alex ", 1);
    expect(response.items).toHaveLength(1); expect(response.hasMore).toBe(true);
    expect(response.items[0].accountHints[0].maskedAccountNumber).toBe("••••bC12");
    expect(JSON.stringify(response)).not.toContain("001AbC12");
    expect((await searchClients("Alex", 2)).items.map((c) => c.cedarRidgeUserId)).toEqual([alice, bob]);
    vi.stubEnv("CLIENT_IDENTITY_ENABLED", "false");
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      expect((await resolveClientIdentity(tx, { cedarRidgeUserId: bob, apexAccountId: "001abc12" })).canonicalName).toBe("Alex Example");
      await expect(resolveClientIdentity(tx, { cedarRidgeUserId: bob, apexAccountId: "UNRELATED" })).rejects.toMatchObject({ code: "ACCOUNT_NOT_LINKED", httpStatus: 422 });
      await expect(resolveClientIdentity(tx, { cedarRidgeUserId: "user-99999999-9999-4999-8999-999999999999", apexAccountId: "001abc12" })).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });
      await expect(resolveClientIdentity(tx, { cedarRidgeUserId: bob, apexAccountId: "" })).rejects.toMatchObject({ code: "ACCOUNT_NOT_LINKED" });
      expect((await resolveClientIdentity(tx, { cedarRidgeUserId: bob, apexAccountId: "", allowPendingAccount: true })).investmentAccountId).toBeNull();
    });
  });

  it("filters search by exact CRM stages before limiting results and calculating hasMore", async () => {
    const excludedStages = [null, "", "Prospect", "Investor", "Dormant", "client", "Lost client", " Client "];
    const extraClients = excludedStages.map((crmStage, index) => ({
      cedarRidgeUserId: `user-33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
      crmStage, canonicalName: `Alex A excluded ${index}`,
    }));
    const rows = directoryRows();
    rows[0].expected_clients = 2 + extraClients.length;
    rows[1].canonical_name = "Alex Y Client"; rows[2].canonical_name = "Alex Z Lost Client";
    rows.push(...extraClients.map((client) => ({ row_kind: "client", cedar_ridge_user_id: client.cedarRidgeUserId,
      canonical_name: client.canonicalName, eligibility: "ACTIVE", source: "synthetic" })));
    await publish(rows);
    await prisma.cedarRidgeClient.update({ where: { cedarRidgeUserId: alice }, data: { crmStage: "Client" } });
    await prisma.cedarRidgeClient.update({ where: { cedarRidgeUserId: bob }, data: { crmStage: "Lost Client" } });
    for (const client of extraClients) await prisma.cedarRidgeClient.update({
      where: { cedarRidgeUserId: client.cedarRidgeUserId }, data: { crmStage: client.crmStage },
    });

    vi.stubEnv("CLIENT_SEARCH_CRM_ONLY", "true");
    const first = await searchClients("Alex", 1);
    expect(first.items.map((client) => client.cedarRidgeUserId)).toEqual([alice]);
    expect(first.hasMore).toBe(true);
    const complete = await searchClients("Alex", 2);
    expect(complete.items.map((client) => client.cedarRidgeUserId)).toEqual([alice, bob]);
    expect(complete.hasMore).toBe(false);
    expect((await searchClients("excluded")).items).toEqual([]);

    vi.stubEnv("CLIENT_SEARCH_CRM_ONLY", "false");
    const legacy = await searchClients("Alex");
    expect(legacy.items).toHaveLength(2 + extraClients.length);
    expect(legacy.items.slice(-2).map((client) => client.cedarRidgeUserId)).toEqual([alice, bob]);
    expect(legacy.hasMore).toBe(false);
  });

  it("retains the existing eligibility and current-snapshot guards with CRM filtering enabled", async () => {
    await publish();
    vi.stubEnv("CLIENT_SEARCH_CRM_ONLY", "true");
    await prisma.cedarRidgeClient.update({ where: { cedarRidgeUserId: alice }, data: { crmStage: "Client", eligibility: "INACTIVE" } });
    await prisma.cedarRidgeClient.update({ where: { cedarRidgeUserId: bob }, data: { crmStage: "Lost Client", lastSeenSnapshotId: "synthetic-older-snapshot" } });
    expect((await searchClients("Alex")).items).toEqual([]);
  });

  it("keeps a hidden linked person resolvable and preserves complete existing joint identities", async () => {
    await publish(jointRows()); const record = await createRecord();
    await prisma.$transaction((tx) => replaceAcatRecordClients(tx, {
      recordId: record.id, cedarRidgeUserIds: [alice, bob], expectedIdentityVersion: 0,
    }));
    await prisma.cedarRidgeClient.update({ where: { cedarRidgeUserId: alice }, data: { crmStage: "Client" } });
    await prisma.cedarRidgeClient.update({ where: { cedarRidgeUserId: bob }, data: { crmStage: "Prospect" } });
    const before = await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } });
    const beforeLinks = await getAcatRecordClients(prisma, record.id);
    vi.stubEnv("CLIENT_SEARCH_CRM_ONLY", "true");
    expect((await searchClients("Bea")).items).toEqual([]);
    expect((await searchClients("Alex")).items.map((client) => client.cedarRidgeUserId)).toEqual([alice]);
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      expect((await resolveClientIdentity(tx, { cedarRidgeUserId: bob, apexAccountId: "001ABC12" })).cedarRidgeUserId).toBe(bob);
      expect((await resolveClientIdentity(tx, { cedarRidgeUserId: bob, apexAccountId: "", allowPendingAccount: true })).investmentAccountId).toBeNull();
      expect((await resolveClientIdentities(tx, { cedarRidgeUserIds: [alice, bob], apexAccountId: "001ABC12" })).cedarRidgeUserIds).toEqual([alice, bob]);
    });
    expect(await getAcatRecordClients(prisma, record.id)).toEqual(beforeLinks);
    expect(await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } })).toEqual(before);
  });

  it("retains removed people/accounts/members as historical evidence, never silently eligible for new transfers", async () => {
    await publish();
    const rows = directoryRows();
    rows[0].expected_clients = 1; rows[0].expected_memberships = 1;
    const reduced = rows.filter((r) => r.cedar_ridge_user_id !== bob);
    reduced.forEach((r) => { if (r.investment_account_id) r.investment_account_id = "synthetic-replacement-account"; });
    reduced.find((r) => r.row_kind === "account")!.account_number = "NEW00123";
    await publish(reduced);
    expect(await prisma.cedarRidgeClient.count()).toBe(2);
    expect(await prisma.cedarRidgeAccountMember.count()).toBe(3);
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      await expect(resolveClientIdentity(tx, { cedarRidgeUserId: bob, apexAccountId: "001ABC12" })).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });
      expect((await resolveClientIdentity(tx, { cedarRidgeUserId: bob, apexAccountId: "001ABC12", allowHistoricalAccount: true })).cedarRidgeUserId).toBe(bob);
      const evidence = await readBackfillDirectoryEvidence(tx, { accountNumber: "001ABC12", candidateUserIds: [bob] });
      expect(evidence.accounts[0].isCurrent).toBe(false);
      expect(evidence.accounts[0].members).toHaveLength(2);
      expect(evidence.clients[0].presentInSnapshot).toBe(false);
    });
  });

  it("rolls back every row and the publication marker when a retained account-number collision occurs", async () => {
    const initial = await publish();
    const rows = directoryRows(); rows[1].canonical_name = "Must Not Commit";
    rows.forEach((r) => { if (r.investment_account_id) r.investment_account_id = "synthetic-collision-account"; });
    const snapshot = track(parseDirectoryRows(rows));
    await expect(publishDirectorySnapshot(await reserveDirectoryAttempt(), snapshot)).rejects.toThrow();
    expect((await prisma.cedarRidgeClient.findUniqueOrThrow({ where: { cedarRidgeUserId: alice } })).canonicalName).toBe("Alex Example");
    expect((await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } })).activeSnapshotId).toBe(initial.snapshot.digest);
    expect(await prisma.cedarRidgeAccount.count()).toBe(1);
  });

  it("fences overlapping attempts and prevents an older failure from replacing newer health", async () => {
    const old = await reserveDirectoryAttempt(); const newer = await reserveDirectoryAttempt();
    const snapshot = track(parseDirectoryRows(directoryRows()));
    expect((await publishDirectorySnapshot(newer, snapshot)).status).toBe("published");
    expect((await publishDirectorySnapshot(old, snapshot)).status).toBe("superseded");
    await recordDirectoryFailure(old, "SOURCE_HTTP_ERROR");
    expect((await getDirectoryStatus()).health).toBe("FRESH");
    const newest = await reserveDirectoryAttempt();
    await recordDirectoryFailure(newest, "SOURCE_HTTP_ERROR");
    expect((await getDirectoryStatus()).health).toBe("UNAVAILABLE");
    expect((await publishDirectorySnapshot(newer, snapshot)).status).toBe("superseded");
    expect((await getDirectoryStatus()).health).toBe("UNAVAILABLE");
  });

  it("serializes publication behind a validating identity transaction", async () => {
    const initial = await publish();
    const generation = await reserveDirectoryAttempt();
    const rows = directoryRows(); rows[1].canonical_name = "Updated Example";
    const next = track(parseDirectoryRows(rows));
    const held = deferred(); const release = deferred();
    const writer = prisma.$transaction(async (tx) => {
      await lockDirectory(tx); held.resolve();
      const identity = await resolveClientIdentity(tx, { cedarRidgeUserId: alice, apexAccountId: "001ABC12" });
      await release.promise;
      expect(identity.snapshotId).toBe(initial.snapshot.digest);
      expect((await resolveClientIdentity(tx, { cedarRidgeUserId: alice, apexAccountId: "001ABC12" })).canonicalName).toBe("Alex Example");
    });
    await held.promise;
    const publisher = publishDirectorySnapshot(generation, next);
    try { await expectPublicationWaiter(); } finally { release.resolve(); }
    await writer; expect((await publisher).status).toBe("published");
    expect((await prisma.cedarRidgeClient.findUniqueOrThrow({ where: { cedarRidgeUserId: alice } })).canonicalName).toBe("Updated Example");
  });

  it("preserves last-good data on stale health and allows the lock itself during an outage", async () => {
    await publish(); await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { sourceAsOf: new Date(Date.now() - 10_000_000) } });
    await prisma.$transaction(async (tx) => {
      await expect(lockDirectory(tx)).resolves.toBeUndefined();
      await expect(resolveClientIdentity(tx, { cedarRidgeUserId: alice, apexAccountId: "001ABC12" })).rejects.toMatchObject({ code: "DIRECTORY_STALE", httpStatus: 503 });
    });
    expect((await searchClients("Alex")).directory.health).toBe("STALE");
    expect(await prisma.cedarRidgeClient.count()).toBe(2);
  });

  it.each(["UPSTREAM_VERIFIED", "FETCH_SUCCESS"])("rejects removals beyond the reviewed threshold and source-as-of regression under %s", async (policy) => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", policy);
    const initial = await publish(); vi.stubEnv("CLIENT_DIRECTORY_MAX_REMOVAL_PERCENT", "0");
    const rows = directoryRows(); rows[0].expected_clients = 1; rows[0].expected_memberships = 1;
    const reduced = track(parseDirectoryRows(rows.filter((r) => r.cedar_ridge_user_id !== bob)));
    await expect(publishDirectorySnapshot(await reserveDirectoryAttempt(), reduced)).rejects.toThrow("SOURCE_REMOVAL_LIMIT_EXCEEDED");
    const regressed = track(parseDirectoryRows(directoryRows(new Date(new Date(initial.snapshot.sourceAsOf!).getTime() - 1000).toISOString())));
    await expect(publishDirectorySnapshot(await reserveDirectoryAttempt(), regressed)).rejects.toThrow("SOURCE_AS_OF_REGRESSED");
    expect((await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } })).activeSnapshotId).toBe(initial.snapshot.digest);
  });

  it("publishes unknown source metadata under fetch policy without synthesizing health or a watermark", async () => {
    await publish(); // Existing verified watermark may legitimately become unknown under the explicit policy.
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "FETCH_SUCCESS");
    vi.stubEnv("CLIENT_DIRECTORY_SOURCE_MAX_AGE_SECONDS", "");
    const rows = directoryRows(); rows[0].source_health = "UNKNOWN"; rows[0].source_as_of = null;
    const result = await publish(rows);
    expect(result.result.status).toBe("published");
    expect(await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } }))
      .toMatchObject({ sourceAsOf: null, sourceHealth: "UNKNOWN", activeSnapshotId: result.snapshot.digest });
    expect(await getDirectoryStatus()).toMatchObject({ health: "FRESH", sourceAsOf: null, freshnessBasis: "FETCH_SUCCESS", writeEligible: true });
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      expect(await resolveClientIdentity(tx, { cedarRidgeUserId: alice, apexAccountId: "001ABC12" })).toMatchObject({ freshnessBasis: "FETCH_SUCCESS" });
      expect(await readBackfillDirectoryEvidence(tx, { accountNumber: "001ABC12", candidateUserIds: [alice] })).toMatchObject({ freshnessBasis: "FETCH_SUCCESS" });
    });
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "UPSTREAM_VERIFIED");
    expect(await getDirectoryStatus()).toMatchObject({ health: "UNKNOWN", writeEligible: false });
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "FETCH_SUCCESS");
    await recordDirectoryFailure(await reserveDirectoryAttempt(), "SOURCE_HTTP_ERROR");
    expect(await getDirectoryStatus()).toMatchObject({ health: "UNAVAILABLE", writeEligible: false });
    expect(await prisma.cedarRidgeClient.count()).toBe(2);
  });

  it("keeps last-good fetch data when a later source is explicitly stale and blocks expired cache", async () => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "FETCH_SUCCESS");
    const rows = directoryRows(); rows[0].source_health = "UNKNOWN"; rows[0].source_as_of = null;
    const initial = await publish(rows);
    rows[0].source_health = "STALE";
    await expect(publishDirectorySnapshot(await reserveDirectoryAttempt(), track(parseDirectoryRows(rows)))).rejects.toThrow("SOURCE_STALE");
    expect((await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } })).activeSnapshotId).toBe(initial.snapshot.digest);
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { lastSuccessAt: new Date(Date.now() - 3_600_001) } });
    await prisma.$transaction(async (tx) => {
      await lockDirectory(tx);
      await expect(resolveClientIdentity(tx, { cedarRidgeUserId: alice, apexAccountId: "001ABC12" })).rejects.toMatchObject({ code: "DIRECTORY_STALE" });
    });
  });

  it("publishes a realistic full population within the request transaction budget", async () => {
    const rows = directoryRows().slice(0, 1);
    rows[0].expected_clients = 4000; rows[0].expected_accounts = 500; rows[0].expected_memberships = 4000;
    for (let i = 0; i < 4000; i++) {
      const id = `user-00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      rows.push({ row_kind: "client", cedar_ridge_user_id: id, canonical_name: `Synthetic Person ${i}`, eligibility: "ACTIVE", source: "synthetic" });
      rows.push({ row_kind: "membership", cedar_ridge_user_id: id, investment_account_id: `synthetic-volume-${i % 500}`, relationship_type: "JOINT" });
    }
    for (let i = 0; i < 500; i++) rows.push({ row_kind: "account", investment_account_id: `synthetic-volume-${i}`, custodian: "APEX", account_number: `SYN${String(i).padStart(8, "0")}` });
    const start = Date.now(); const result = await publish(rows);
    expect(result.result.status).toBe("published"); expect(Date.now() - start).toBeLessThan(15_000);
    expect(await prisma.cedarRidgeClient.count()).toBe(4000);
    expect(await prisma.cedarRidgeAccountMember.count()).toBe(4000);
  }, 20_000);
});
