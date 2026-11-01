// @vitest-environment node
import { PrismaClient, type CedarRidgeDirectorySync } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { publishDirectorySnapshot, reserveDirectoryAttempt } from "@/lib/client-directory/sync";
import { parseDirectoryRows } from "@/lib/client-directory/source";
import { replaceAcatRecordClients } from "@/lib/client-directory/repository";
import { readLinkagePoint, readLinkageSnapshot } from "./repository";
import { TRANSFER_LINKAGE_MAX_MEMBERS_PER_ACCOUNT, TRANSFER_LINKAGE_MAX_RECORDS } from "./contract";
import { syntheticInputs, SYNTHETIC_PEOPLE, SYNTHETIC_TRANSFERS } from "./testing/fixtures";

const enabled = process.env.TRANSFER_LINKAGE_DATABASE_TEST === "1";
let original: CedarRidgeDirectorySync;
let observer: PrismaClient;
const prefix = "synthetic-linkage-";
const extraClients = new Set<string>();
function rows() {
  const inputs = syntheticInputs();
  return [
    { row_kind: "manifest", contract_version: 1, complete: true, source: "synthetic-linkage-test", source_as_of: null,
      source_health: "UNKNOWN", query_fingerprint: "b".repeat(64), expected_clients: 3, expected_accounts: 2, expected_memberships: 3 },
    ...SYNTHETIC_PEOPLE.map((id, i) => ({ row_kind: "client", cedar_ridge_user_id: id, canonical_name: `Synthetic Person ${i}`,
      eligibility: "ACTIVE", source: "synthetic-linkage-test" })),
    ...inputs.accounts.map((a) => ({ row_kind: "account", investment_account_id: a.investmentAccountId,
      custodian: "APEX", account_number: a.normalizedAccountNumber, account_status: a.status })),
    ...inputs.accounts.flatMap((a) => a.members.map((m) => ({ row_kind: "membership", investment_account_id: a.investmentAccountId,
      cedar_ridge_user_id: m.cedarRidgeUserId, relationship_type: m.relationshipType }))),
  ];
}
async function publish(sourceRows = rows()) {
  return publishDirectorySnapshot(await reserveDirectoryAttempt(), parseDirectoryRows(sourceRows));
}
async function record(suffix = "single", ids: readonly string[] = [SYNTHETIC_PEOPLE[0]]) {
  const result = await prisma.acatRecord.create({ data: { id: `${prefix}${suffix}`, clientName: "Synthetic Display",
    apexAccountId: suffix === "joint" ? "SYNTHETIC002" : "SYNTHETIC001", acatDate: "2026-09-01",
    status: "Submitted", transferWorkflow: "ACAT", acatTransferId: SYNTHETIC_TRANSFERS[0], direction: "IN", type: "FULL",
    lastUpdated: "preserved-synthetic-clock" } });
  if (ids.length) await prisma.$transaction((tx) => replaceAcatRecordClients(tx, { recordId: result.id,
    cedarRidgeUserIds: [...ids], expectedIdentityVersion: result.identityVersion }));
  return result.id;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function expectWaiter() {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
      AND wait_event_type = 'Lock' AND query LIKE '%CedarRidgeDirectorySync%'`;
    if (rows.length) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("Expected source read to wait for publication lock");
}

describe.skipIf(!enabled)("complete linkage evidence against isolated PostgreSQL16", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    const allowedPort = url.port === "15543" || (process.env.CI === "true" && url.port === "5432");
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || !allowedPort || url.pathname !== "/transfer_tracker_test") {
      throw new Error("Linkage DB tests require reserved localhost:15543/transfer_tracker_test (CI may use port5432)");
    }
    if (await prisma.acatRecord.count() || await prisma.cedarRidgeClient.count() || await prisma.cedarRidgeAccount.count()) {
      throw new Error("Linkage DB tests require an empty synthetic database; existing records will not be overwritten");
    }
    original = await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } });
    observer = new PrismaClient({ datasourceUrl: url.toString() });
    await observer.$connect();
  });
  beforeEach(() => {
    vi.stubEnv("TRANSFER_LINKAGE_ENVIRONMENT", "synthetic");
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "FETCH_SUCCESS");
    vi.stubEnv("CLIENT_DIRECTORY_MAX_AGE_SECONDS", "3600");
    vi.stubEnv("CLIENT_DIRECTORY_MAX_REMOVAL_PERCENT", "100");
  });
  afterEach(async () => {
    if (!original) return;
    await prisma.acatRecord.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.cedarRidgeAccountMember.deleteMany({ where: { cedarRidgeUserId: { in: [...SYNTHETIC_PEOPLE, ...extraClients] } } });
    await prisma.cedarRidgeAccount.deleteMany({ where: { investmentAccountId: { startsWith: "synthetic-investment-" } } });
    await prisma.cedarRidgeClient.deleteMany({ where: { cedarRidgeUserId: { in: [...SYNTHETIC_PEOPLE, ...extraClients] } } });
    extraClients.clear();
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: original });
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await Promise.all([prisma.$disconnect(), observer?.$disconnect()]); });

  it("reads authoritative single/joint sets with matching point proof and unchanged business records", async () => {
    await publish(); const first = await record(); await record("joint", SYNTHETIC_PEOPLE.slice(1));
    const before = await prisma.acatRecord.findMany({ orderBy: { id: "asc" } });
    const snapshot = await readLinkageSnapshot();
    expect(snapshot).toMatchObject({ complete: true, recordCount: 2, source: { installationId: original.installationId }, directory: { health: "FRESH", freshnessBasis: "FETCH_SUCCESS", sourceAsOf: null } });
    expect(snapshot.records.map((r) => r.cedarRidgeUserIds.length).sort()).toEqual([1, 2]);
    expect(snapshot.records.every((r) => r.receivingAccount.verification === "VERIFIED")).toBe(true);
    expect((await readLinkagePoint(first)).record).toEqual(snapshot.records.find((r) => r.recordId === first));
    expect(await prisma.acatRecord.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });

  it("accounts for all statuses/deleted/unlinked rows, and case-insensitive duplicate UUIDs", async () => {
    await publish();
    for (const status of ["Completed", "Canceled", "Purged", "Rejected"] as const) {
      const id = await record(status, []);
      await prisma.acatRecord.update({ where: { id }, data: { status, deletedAt: status === "Completed" ? new Date() : null,
        acatTransferId: SYNTHETIC_TRANSFERS[0].toUpperCase() } });
    }
    const snapshot = await readLinkageSnapshot();
    expect(snapshot.recordCount).toBe(4);
    expect(snapshot.records.every((r) => r.acatTransferId === SYNTHETIC_TRANSFERS[0] && r.cedarRidgeUserIds.length === 0)).toBe(true);
    expect((await readLinkagePoint(`${prefix}Completed`)).outcome).toBe("DELETED");
    expect(await readLinkagePoint("synthetic-missing")).toMatchObject({ complete: false, outcome: "MISSING", record: null });
  });

  it("detects identity and account-membership changes while lastUpdated is preserved", async () => {
    await publish(); const id = await record("single", []);
    const first = (await readLinkagePoint(id)).record!;
    await prisma.$transaction((tx) => replaceAcatRecordClients(tx, { recordId: id, cedarRidgeUserIds: [SYNTHETIC_PEOPLE[0]], expectedIdentityVersion: first.identityVersion }));
    const linked = (await readLinkagePoint(id)).record!;
    expect(linked.identityVersion).toBeGreaterThan(first.identityVersion);
    expect(linked.recordEvidenceDigest).not.toBe(first.recordEvidenceDigest);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "CedarRidgeDirectorySync" WHERE id = 'global' FOR UPDATE`;
      await tx.cedarRidgeAccountMember.update({ where: { investmentAccountId_cedarRidgeUserId: {
        investmentAccountId: "synthetic-investment-single", cedarRidgeUserId: SYNTHETIC_PEOPLE[0] } }, data: { relationshipType: "JOINT" } });
    });
    const changed = (await readLinkagePoint(id)).record!;
    expect(changed.identityVersion).toBe(linked.identityVersion);
    expect(changed.recordEvidenceDigest).toBe(linked.recordEvidenceDigest);
    expect(changed.accountEvidenceDigest).not.toBe(linked.accountEvidenceDigest);
    expect((await prisma.acatRecord.findUniqueOrThrow({ where: { id } })).lastUpdated).toBe("preserved-synthetic-clock");
  });

  it("equivalent successful publication preserves facts and later failure refuses verification", async () => {
    await publish(); await record(); const before = await readLinkageSnapshot();
    const republished = rows();
    // A source metadata change creates a new publication without changing holder facts.
    republished[0] = { ...republished[0], source_health: "FRESH" };
    await publish(republished);
    const after = await readLinkageSnapshot();
    expect(after.directory.snapshotId).not.toBe(before.directory.snapshotId);
    expect(after.snapshotDigest).toBe(before.snapshotDigest);
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { lastErrorCode: "SYNTHETIC_FAILURE" } });
    const failed = await readLinkageSnapshot();
    expect(failed).toMatchObject({ complete: true, recordCount: 1, directory: { health: "UNAVAILABLE" } });
    expect(failed.records[0].receivingAccount.verification).toBe("SOURCE_UNAVAILABLE");
    expect(failed.snapshotDigest).toBe(before.snapshotDigest);
  });

  it("reports empty populations and refuses full snapshots above capacity without affecting point reads", async () => {
    await publish(); expect((await readLinkageSnapshot()).recordCount).toBe(0);
    await prisma.acatRecord.createMany({ data: Array.from({ length: TRANSFER_LINKAGE_MAX_RECORDS + 1 }, (_, index) => ({
      id: `${prefix}capacity-${String(index).padStart(5, "0")}`, clientName: "Synthetic Capacity", apexAccountId: "",
      acatDate: "2026-09-01", lastUpdated: "synthetic-clock" })) });
    await expect(readLinkageSnapshot()).rejects.toThrow("SNAPSHOT_OVERFLOW");
    expect((await readLinkagePoint(`${prefix}capacity-00000`)).outcome).toBe("FOUND");
  });

  it("fails closed during a publication race and retries with one coherent new publication", async () => {
    await publish(); await record();
    const locked = deferred(); const release = deferred();
    const publisher = observer.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "CedarRidgeDirectorySync" WHERE id = 'global' FOR UPDATE`;
      await tx.cedarRidgeAccount.update({ where: { investmentAccountId: "synthetic-investment-single" }, data: { status: "CLOSED" } });
      await tx.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { publishedGeneration: { increment: 1 } } });
      locked.resolve(); await release.promise;
    }, { timeout: 10_000 });
    await locked.promise;
    const reader = readLinkageSnapshot().then((result) => ({ result }), (error: unknown) => ({ error }));
    try { await expectWaiter(); } finally { release.resolve(); }
    await publisher;
    const raced = await reader;
    // PostgreSQL repeatable-read locking sees the changed singleton and rejects
    // the stale transaction rather than mixing new account facts with old state.
    expect(raced).toHaveProperty("error");
    const retry = await readLinkageSnapshot();
    expect(retry.records[0].receivingAccount).toMatchObject({ status: "CLOSED", verification: "HISTORICAL" });
  });

  it("refuses account evidence truncation instead of calling a partial holder set complete", async () => {
    await publish(); await record();
    const state = await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } });
    for (let i = 0; i < TRANSFER_LINKAGE_MAX_MEMBERS_PER_ACCOUNT; i++) extraClients.add(`user-44444444-4444-4444-8444-${String(i).padStart(12, "0")}`);
    await prisma.cedarRidgeClient.createMany({ data: [...extraClients].map((cedarRidgeUserId) => ({ cedarRidgeUserId,
      canonicalName: "Synthetic Capacity", normalizedName: "synthetic capacity", eligibility: "ACTIVE",
      source: "synthetic-linkage-test", lastSeenSnapshotId: state.activeSnapshotId! })) });
    await prisma.cedarRidgeAccountMember.createMany({ data: [...extraClients].map((cedarRidgeUserId) => ({ cedarRidgeUserId,
      investmentAccountId: "synthetic-investment-single", relationshipType: "JOINT", lastSeenSnapshotId: state.activeSnapshotId! })) });
    await expect(readLinkageSnapshot()).rejects.toThrow("ACCOUNT_EVIDENCE_OVERFLOW");
    await expect(readLinkagePoint(`${prefix}single`)).rejects.toThrow("ACCOUNT_EVIDENCE_OVERFLOW");
  });
});
