// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { CedarRidgeDirectorySync } from "@prisma/client";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { POST as createAcat } from "@/app/api/acats/route";
import { PATCH as patchAcat } from "@/app/api/acats/[id]/route";
import { PUT as relink } from "@/app/api/acats/[id]/client-identity/route";
import { POST as search } from "@/app/api/clients/search/route";
import { GET as status } from "@/app/api/clients/status/route";
import { replaceAcatRecordClients } from "./client-directory";

const authState = vi.hoisted(() => ({ session: { user: { email: "identity-test@example.test", role: "USER" } } as { user: { email: string; role: string } } | null }));
vi.mock("@/lib/auth", () => ({ auth: async () => {
  // Real auth also reads the DB. This catches moving auth inside a transaction
  // where it would wait for another pool connection (suite also runs with one).
  await prisma.$queryRaw`SELECT 1`;
  return authState.session;
} }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const enabled = process.env.ACAT_IDENTITY_DATABASE_TEST === "1";
const prefix = `identity-api-${randomUUID()}`;
const userA = `user-${randomUUID()}`;
const userB = `user-${randomUUID()}`;
const accountId = `${prefix}-account`;
const accountNumber = `SYNTH-${randomUUID()}`.toUpperCase();
const createdIds: string[] = [];
let originalSync: CedarRidgeDirectorySync;

function request(path: string, body: unknown, method = "POST") {
  return new NextRequest(`http://localhost${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function makeRecord(overrides: Record<string, unknown> = {}) {
  const { cedarRidgeUserId, cedarRidgeUserIds, ...business } = overrides;
  const record = await prisma.acatRecord.create({ data: {
    id: `${prefix}-${randomUUID()}`, clientName: "Historical Display", apexAccountId: accountNumber,
    acatDate: "2025-01-01", lastUpdated: "2025-01-02T00:00:00.000Z", ...business,
  } });
  createdIds.push(record.id);
  const ids = Array.isArray(cedarRidgeUserIds) ? cedarRidgeUserIds as string[] : typeof cedarRidgeUserId === "string" ? [cedarRidgeUserId] : [];
  if (ids.length) await prisma.$transaction((tx) => replaceAcatRecordClients(tx, {
    recordId: record.id, cedarRidgeUserIds: ids, expectedIdentityVersion: record.identityVersion,
  }));
  return prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } });
}
async function create(body: Record<string, unknown>) {
  const response = await createAcat(request("/api/acats", body));
  const payload = await response.json();
  if (response.status === 201) createdIds.push(payload.id);
  return { response, payload };
}
async function link(id: string, body: Record<string, unknown> = {}) {
  return relink(request(`/api/acats/${id}/client-identity`, {
    cedarRidgeUserId: userA, expectedIdentityVersion: 0, reason: "Synthetic operator review", ...body,
  }, "PUT"), params(id));
}

describe.skipIf(!enabled)("Cedar Ridge identity API against PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/transfer_tracker_test") {
      throw new Error("Identity tests require an explicit localhost transfer_tracker_test database");
    }
    originalSync = await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } });
    for (const [id, name] of [[userA, "Synthetic Client Alpha"], [userB, "Synthetic Client Beta"]]) {
      await prisma.cedarRidgeClient.create({ data: { cedarRidgeUserId: id, canonicalName: name,
        normalizedName: name.toLowerCase(), eligibility: "ACTIVE", source: "synthetic", lastSeenSnapshotId: prefix } });
    }
    await prisma.cedarRidgeAccount.create({ data: { investmentAccountId: accountId, custodian: "APEX",
      accountNumber, normalizedAccountNumber: accountNumber, lastSeenSnapshotId: prefix } });
    await prisma.cedarRidgeAccountMember.createMany({ data: [userA, userB].map((id) => ({
      investmentAccountId: accountId, cedarRidgeUserId: id, relationshipType: "JOINT", lastSeenSnapshotId: prefix,
    })) });
  });

  beforeEach(async () => {
    authState.session = { user: { email: "identity-test@example.test", role: "USER" } };
    vi.stubEnv("CLIENT_IDENTITY_ENABLED", "true");
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "UPSTREAM_VERIFIED");
    vi.stubEnv("CLIENT_IDENTITY_PENDING_ACCOUNT_POLICY", "PENDING_ACCOUNT_OPENING_ONLY");
    vi.stubEnv("CLIENT_DIRECTORY_MAX_AGE_SECONDS", "3600");
    vi.stubEnv("CLIENT_DIRECTORY_SOURCE_MAX_AGE_SECONDS", "3600");
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: {
      activeSnapshotId: prefix, lastSuccessAt: new Date(), sourceAsOf: new Date(), sourceHealth: "FRESH", lastErrorCode: null,
    } });
  });

  afterAll(async () => {
    if (!originalSync) return;
    await prisma.auditLog.deleteMany({ where: { acatRecordId: { in: createdIds } } });
    await prisma.acatRecord.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.cedarRidgeAccountMember.deleteMany({ where: { investmentAccountId: accountId } });
    await prisma.cedarRidgeAccount.delete({ where: { investmentAccountId: accountId } });
    await prisma.cedarRidgeClient.deleteMany({ where: { cedarRidgeUserId: { in: [userA, userB] } } });
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: originalSync });
    vi.unstubAllEnvs();
    await prisma.$disconnect();
  });

  it("restricts directory and relink endpoints to current ops roles", async () => {
    authState.session = null;
    expect((await search(request("/api/clients/search", { query: "Synthetic" }))).status).toBe(401);
    expect((await status()).status).toBe(401);
    authState.session = { user: { email: "advisor@example.test", role: "ADVISOR" } };
    expect((await search(request("/api/clients/search", { query: "Synthetic" }))).status).toBe(403);
    expect((await link("missing")).status).toBe(403);
  });

  it("returns bounded masked search results and safe no-store health", async () => {
    const response = await search(request("/api/clients/search", { query: "Synthetic Client", limit: 1 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const result = await response.json();
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(JSON.stringify(result)).not.toContain(accountNumber);
    expect(result.items[0].accountHints[0].relationshipType).toBe("JOINT");
    expect((await (await status()).json()).writeEligible).toBe(true);
    expect((await search(request("/api/clients/search", { query: "S" }))).status).toBe(400);
  });

  it("requires selection after cutover and derives the name from the directory", async () => {
    expect((await create({ clientName: "Typed Person", apexAccountId: accountNumber })).response.status).toBe(400);
    const { response, payload } = await create({ cedarRidgeUserId: userA, clientName: "Spoofed Person", apexAccountId: accountNumber });
    expect(response.status).toBe(201);
    expect(payload.clientName).toBe("Synthetic Client Alpha");
    expect(payload.cedarRidgeUserId).toBe(userA);
    expect(payload.identityVersion).toBeGreaterThan(0);
    expect(await prisma.auditLog.count({ where: { acatRecordId: payload.id, action: "identity-create" } })).toBe(1);
  });

  it("audits accepted fetch freshness without inventing an upstream watermark", async () => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "FETCH_SUCCESS");
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { sourceHealth: "UNKNOWN", sourceAsOf: null } });
    expect(await (await status()).json()).toMatchObject({ health: "FRESH", freshnessBasis: "FETCH_SUCCESS", sourceAsOf: null });
    const created = await create({ cedarRidgeUserId: userA, apexAccountId: accountNumber });
    expect(created.response.status).toBe(201);
    const createAudit = await prisma.auditLog.findFirstOrThrow({ where: { acatRecordId: created.payload.id, action: "identity-create-provenance" } });
    expect(JSON.parse(createAudit.newValue!)).toMatchObject({ freshnessBasis: "FETCH_SUCCESS", snapshotId: prefix });
    const record = await makeRecord();
    expect((await link(record.id)).status).toBe(200);
    const linkAudit = await prisma.auditLog.findFirstOrThrow({ where: { acatRecordId: record.id, action: "identity-relink-provenance" } });
    expect(JSON.parse(linkAudit.newValue!)).toMatchObject({ freshnessBasis: "FETCH_SUCCESS", snapshotId: prefix });
    expect(await prisma.cedarRidgeDirectorySync.findUniqueOrThrow({ where: { id: "global" } })).toMatchObject({ sourceHealth: "UNKNOWN", sourceAsOf: null });
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { lastSuccessAt: new Date(Date.now() - 3_601_000) } });
    expect((await create({ cedarRidgeUserId: userA, apexAccountId: accountNumber })).response.status).toBe(503);
  });

  it("rejects unrelated or masked accounts and unknown users without creating records", async () => {
    for (const body of [
      { cedarRidgeUserId: userA, apexAccountId: "UNRELATED" },
      { cedarRidgeUserId: userA, apexAccountId: `••••${accountNumber.slice(-4)}` },
      { cedarRidgeUserId: `user-${randomUUID()}`, apexAccountId: accountNumber },
    ]) expect((await create(body)).response.status).toBe(422);
  });

  it("allows a verified pending client without an account and blocks moving out of that status", async () => {
    expect((await create({ cedarRidgeUserId: userA })).response.status).toBe(422);
    const { response, payload } = await create({ cedarRidgeUserId: userA, status: "PendingAccountOpening" });
    expect(response.status).toBe(201);
    expect(payload.apexAccountId).toBe("");
    const rejected = await patchAcat(request(`/api/acats/${payload.id}`, { status: "Submitted" }, "PATCH"), params(payload.id));
    expect(rejected.status).toBe(422);
    const accepted = await patchAcat(request(`/api/acats/${payload.id}`, { status: "Submitted", apexAccountId: accountNumber, expectedIdentityVersion: payload.identityVersion }, "PATCH"), params(payload.id));
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).identityVersion).toBeGreaterThan(payload.identityVersion);
  });

  it("retains legacy creation before cutover but validates any supplied identity", async () => {
    vi.stubEnv("CLIENT_IDENTITY_ENABLED", "false");
    const legacy = await create({ clientName: "Legacy Synthetic", apexAccountId: "LEGACY" });
    expect(legacy.response.status).toBe(400);
    expect(legacy.payload.code).toBe("IDENTITY_REQUIRED");
    expect(await prisma.acatRecord.count({ where: { clientName: "Legacy Synthetic", apexAccountId: "LEGACY" } })).toBe(0);
    expect((await create({ cedarRidgeUserId: userA, apexAccountId: "UNRELATED" })).response.status).toBe(422);
  });

  it("links without renaming or changing business time and treats repeated requests as no-ops", async () => {
    const record = await makeRecord();
    const response = await link(record.id);
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.clientName).toBe(record.clientName);
    expect(updated.lastUpdated).toBe(record.lastUpdated);
    expect(updated.identityVersion).toBe(1);
    expect((await link(record.id)).status).toBe(409);
    const repeated = await link(record.id, { expectedIdentityVersion: 1 });
    expect((await repeated.json()).identityVersion).toBe(1);
    expect(await prisma.auditLog.count({ where: { acatRecordId: record.id, action: "identity-relink-provenance" } })).toBe(1);
  });

  it("requires mapping acknowledgement only when the saved name actually changes", async () => {
    const record = await makeRecord({ mappingAccountId: randomUUID(), mappingAccountSummary: { synthetic: true } });
    expect((await link(record.id, { replaceDisplayName: true })).status).toBe(400);
    expect((await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } })).identityVersion).toBe(0);
    const accepted = await link(record.id, { replaceDisplayName: true, acknowledgeMappingInvalidation: true });
    const updated = await accepted.json();
    expect(accepted.status).toBe(200);
    expect(updated.mappingAccountId).toBeNull();
    expect(updated.clientName).toBe("Synthetic Client Alpha");
    expect(updated.identityVersion).toBeGreaterThan(record.identityVersion);
  });

  it("allows only one concurrent correction with the same expected version", async () => {
    const record = await makeRecord();
    const results = await Promise.all([link(record.id), link(record.id, { cedarRidgeUserId: userB })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } })).identityVersion).toBe(1);
  });

  it("blocks independent linked-name edits and versionless account edits", async () => {
    const record = await makeRecord({ cedarRidgeUserId: userA });
    for (const [body, expected] of [
      [{ clientName: "Other Person", expectedIdentityVersion: record.identityVersion }, 400],
      [{ apexAccountId: "UNRELATED" }, 409],
      [{ apexAccountId: "UNRELATED", expectedIdentityVersion: record.identityVersion }, 422],
    ] as const) {
      expect((await patchAcat(request(`/api/acats/${record.id}`, body, "PATCH"), params(record.id))).status).toBe(expected);
    }
    expect((await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } })).identityVersion).toBe(record.identityVersion);
  });

  it("fails closed on stale source for identity writes while allowing operational edits", async () => {
    const record = await makeRecord({ cedarRidgeUserId: userA });
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { sourceHealth: "STALE" } });
    const failed = await create({ cedarRidgeUserId: userA, apexAccountId: accountNumber });
    expect(failed.response.status).toBe(503);
    expect(failed.payload.code).toBe("DIRECTORY_STALE");
    const notes = await patchAcat(request(`/api/acats/${record.id}`, { notes: "Synthetic operational update" }, "PATCH"), params(record.id));
    expect(notes.status).toBe(200);
    expect((await notes.json()).identityVersion).toBe(record.identityVersion);
  });

  it("resolves a newly entered contra on the existing transaction connection", async () => {
    const record = await makeRecord({ cedarRidgeUserId: userA });
    const name = `${prefix}-new-contra`;
    try {
      const response = await patchAcat(request(`/api/acats/${record.id}`, { transferringContra: name }, "PATCH"), params(record.id));
      expect(response.status).toBe(200);
      expect((await response.json()).custodianName).toBe(name);
    } finally {
      await prisma.acatRecord.update({ where: { id: record.id }, data: { custodianId: null } });
      await prisma.custodian.deleteMany({ where: { name } });
    }
  });

  it("preserves ordinary updates when the best-effort fee lookup has a SQL failure", async () => {
    const custodian = await prisma.custodian.create({ data: { name: `${prefix}-fee-failure` } });
    const record = await makeRecord({ custodianId: custodian.id, cedarRidgeUserId: userA });
    // This isolated test DB suite runs serially. Force a real PostgreSQL error,
    // rather than a JS mock that cannot reproduce an aborted transaction.
    await prisma.$executeRaw`ALTER TABLE "CustodianFee" RENAME TO "CustodianFee_identity_test"`;
    try {
      const response = await patchAcat(request(`/api/acats/${record.id}`, { status: "Completed", notes: "Synthetic fee lookup failure" }, "PATCH"), params(record.id));
      expect(response.status).toBe(200);
      expect((await response.json()).status).toBe("Completed");
    } finally {
      await prisma.$executeRaw`ALTER TABLE "CustodianFee_identity_test" RENAME TO "CustodianFee"`;
      await prisma.acatRecord.update({ where: { id: record.id }, data: { custodianId: null } });
      await prisma.custodian.delete({ where: { id: custodian.id } });
    }
  });

  it("creates a complete joint set, derives both names, and hides the private set cache", async () => {
    const { response, payload } = await create({ cedarRidgeUserIds: [userB, userA], clientName: "Spoofed household", apexAccountId: accountNumber });
    expect(response.status).toBe(201);
    expect(payload.cedarRidgeUserId).toBeNull();
    expect(payload.cedarRidgeUserIds).toEqual([userA, userB].sort());
    expect(payload.linkedClients.map((c: { displayName: string }) => c.displayName).sort()).toEqual(["Synthetic Client Alpha", "Synthetic Client Beta"]);
    expect(payload.clientName.split(" & ").sort()).toEqual(["Synthetic Client Alpha", "Synthetic Client Beta"]);
    expect(payload).not.toHaveProperty("identitySetIds");
    expect(payload).not.toHaveProperty("clientLinks");
    expect(await prisma.acatRecordClient.count({ where: { acatRecordId: payload.id } })).toBe(2);
  });

  it("links both holders atomically while preserving every business field and handles reordered replay", async () => {
    const record = await makeRecord();
    const response = await relink(request(`/api/acats/${record.id}/client-identity`, {
      cedarRidgeUserIds: [userB, userA], expectedIdentityVersion: record.identityVersion, reason: "Reviewed both joint owners",
    }, "PUT"), params(record.id));
    expect(response.status).toBe(200);
    const linked = await response.json();
    const after = await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } });
    const business = (row: typeof record) => Object.fromEntries(Object.entries(row).filter(([key]) => !["cedarRidgeUserId", "identityVersion", "identitySetIds"].includes(key)));
    expect(business(after)).toEqual(business(record));
    const replay = await relink(request(`/api/acats/${record.id}/client-identity`, {
      cedarRidgeUserIds: [userA, userB], expectedIdentityVersion: linked.identityVersion, reason: "Same reviewed set",
    }, "PUT"), params(record.id));
    expect((await replay.json()).identityVersion).toBe(linked.identityVersion);
    const audits = await prisma.auditLog.findMany({ where: { acatRecordId: record.id, action: "identity-relink-provenance" } });
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].newValue!)).toMatchObject({ oldUserIds: [], newUserIds: [userA, userB].sort(), afterVersion: linked.identityVersion });
  });

  it("rejects a stale scalar form without removing another joint holder", async () => {
    const record = await makeRecord({ cedarRidgeUserIds: [userA, userB] });
    expect((await link(record.id, { expectedIdentityVersion: record.identityVersion })).status).toBe(409);
    expect(await prisma.acatRecordClient.count({ where: { acatRecordId: record.id } })).toBe(2);
    expect((await prisma.acatRecord.findUniqueOrThrow({ where: { id: record.id } })).identityVersion).toBe(record.identityVersion);
  });

  it("records full-set source provenance when an ordinary PATCH changes linked identity fields", async () => {
    const record = await makeRecord({ cedarRidgeUserIds: [userA, userB] });
    const response = await patchAcat(request(`/api/acats/${record.id}`, {
      acatTransferId: "synthetic-reviewed-transfer", expectedIdentityVersion: record.identityVersion,
    }, "PATCH"), params(record.id));
    expect(response.status).toBe(200);
    const updated = await response.json();
    const proof = await prisma.auditLog.findFirstOrThrow({ where: {
      acatRecordId: record.id, action: "identity-update-provenance",
    } });
    expect(JSON.parse(proof.newValue!)).toMatchObject({
      cedarRidgeUserIds: [userA, userB].sort(), snapshotId: prefix,
      freshnessBasis: "UPSTREAM_VERIFIED", beforeVersion: record.identityVersion,
      afterVersion: updated.identityVersion,
    });
    expect(JSON.parse(proof.newValue!).evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(updated.identityVersion).toBeGreaterThan(record.identityVersion);
  });

  it("enforces joint identity on generic PATCH even though the scalar projection is null", async () => {
    const record = await makeRecord({ cedarRidgeUserIds: [userA, userB] });
    expect(record.cedarRidgeUserId).toBeNull();
    for (const [body, expected] of [
      [{ clientName: "Unreviewed replacement", expectedIdentityVersion: record.identityVersion }, 400],
      [{ apexAccountId: "UNRELATED" }, 409],
      [{ apexAccountId: "UNRELATED", expectedIdentityVersion: record.identityVersion }, 422],
    ] as const) expect((await patchAcat(request(`/api/acats/${record.id}`, body, "PATCH"), params(record.id))).status).toBe(expected);
    await prisma.cedarRidgeDirectorySync.update({ where: { id: "global" }, data: { sourceHealth: "STALE" } });
    const response = await patchAcat(request(`/api/acats/${record.id}`, { notes: "Joint operational edit during source outage" }, "PATCH"), params(record.id));
    expect(response.status).toBe(200);
    expect((await response.json()).cedarRidgeUserIds).toEqual([userA, userB].sort());
  });

  it("rejects duplicate, unrelated and accountless joint selections without writes", async () => {
    for (const body of [
      { cedarRidgeUserIds: [userA, userA], apexAccountId: accountNumber },
      { cedarRidgeUserIds: [userA, userB], status: "PendingAccountOpening" },
      { cedarRidgeUserIds: [userA, `user-${randomUUID()}`], apexAccountId: accountNumber },
    ]) expect((await create(body)).response.status).toBeGreaterThanOrEqual(400);
  });

  it("allows only one concurrent deliberate joint-set replacement", async () => {
    const record = await makeRecord({ cedarRidgeUserIds: [userA, userB] });
    const results = await Promise.all([userA, userB].map((id) => relink(request(`/api/acats/${record.id}/client-identity`, {
      cedarRidgeUserIds: [id], expectedIdentityVersion: record.identityVersion, reason: "Explicit reviewed removal",
    }, "PUT"), params(record.id))));
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await prisma.acatRecordClient.count({ where: { acatRecordId: record.id } })).toBe(1);
  });
});
