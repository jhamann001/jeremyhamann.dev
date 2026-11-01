// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { createOpaqueToken } from "./crypto";
import { canUseMcp, lockMcpUser, revokeUserMcpCredentials } from "./user-access";
import { validateMcpBearerToken } from "./access-token";
import { refreshAccessToken } from "./oauth";
import { PATCH } from "@/app/api/admin/users/route";

vi.mock("@/lib/auth-helpers", () => ({
  requireAdmin: async () => ({ email: "synthetic-admin@example.test" }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Opt-in outside CI; this test refuses remote or non-test databases.
const enabled = process.env.ACAT_SECURITY_DATABASE_TEST === "1";
const userIds: string[] = [];
const clientIds: string[] = [];
let originalSettings: { enabled: boolean } | null;
let lockObserver: PrismaClient | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function makeFixture() {
  const suffix = randomUUID();
  const user = await prisma.allowedUser.create({ data: {
    email: `security-${suffix}@example.test`, role: "USER", active: true, mcpEnabled: true,
  } });
  userIds.push(user.id);
  const client = await prisma.mcpOAuthClient.create({ data: {
    clientId: `security-${suffix}`, redirectUris: ["http://localhost/callback"], scopes: [],
  } });
  clientIds.push(client.id);
  const expiresAt = new Date(Date.now() + 60_000);
  const connection = await prisma.mcpConnection.create({ data: {
    userEmail: user.email, clientId: client.id, scopes: [], expiresAt,
  } });
  const pat = createOpaqueToken("mcp_pat");
  const access = createOpaqueToken("acat_at");
  const refresh = createOpaqueToken("acat_rt");
  const code = createOpaqueToken("acat_code");
  const patRow = await prisma.mcpPersonalToken.create({ data: {
    tokenHash: pat.hash, prefix: pat.publicPrefix, lastFour: pat.lastFour,
    name: "Synthetic security test", userEmail: user.email, scopes: [],
  } });
  await prisma.mcpAccessToken.create({ data: {
    tokenHash: access.hash, prefix: access.publicPrefix, lastFour: access.lastFour,
    connectionId: connection.id, scopes: [], expiresAt,
  } });
  await prisma.mcpRefreshToken.create({ data: {
    tokenHash: refresh.hash, prefix: refresh.publicPrefix, lastFour: refresh.lastFour,
    connectionId: connection.id, expiresAt,
  } });
  await prisma.mcpOAuthAuthorizationCode.create({ data: {
    codeHash: code.hash, clientId: client.id, userEmail: user.email,
    redirectUri: "http://localhost/callback", scopes: [], codeChallenge: "synthetic", expiresAt,
  } });
  return { user, pat, patRow, access, refresh, client, connection };
}

async function updateRole(id: string, role: "USER" | "ADVISOR") {
  return PATCH(new NextRequest("http://localhost/api/admin/users", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, role }),
  }));
}

async function expectUserLockWaiter(count = 1) {
  // Observe PostgreSQL's lock state instead of assuming a fixed sleep proves
  // the second transaction is actually waiting on the user row.
  if (!lockObserver) throw new Error("Security database lock observer is not initialized");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const waiting = await lockObserver.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%AllowedUser%'
    `;
    if (waiting.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected a transaction waiting for the synthetic user lock");
}

describe.skipIf(!enabled)("MCP privilege revocation against PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["localhost", "127.0.0.1"].includes(url.hostname) ||
        !["/acat_security_test", "/transfer_tracker_test"].includes(url.pathname)) {
      throw new Error("Security database tests require an explicit localhost test database");
    }
    // The holder and two waiting refresh transactions can fill the app's
    // three-connection CI pool. Observation must not need a fourth connection
    // from that same pool before it lets the holder release its lock.
    url.searchParams.set("connection_limit", "1");
    lockObserver = new PrismaClient({ datasourceUrl: url.toString() });
    await lockObserver.$connect();
    vi.stubEnv("MCP_ENABLED", "1");
    vi.stubEnv("MCP_TOKEN_PEPPER", "synthetic-security-test-pepper");
    originalSettings = await prisma.mcpSettings.findUnique({ where: { id: "global" } });
    await prisma.mcpSettings.upsert({
      where: { id: "global" }, create: { id: "global", enabled: true }, update: { enabled: true },
    });
  });

  afterEach(async () => {
    // Exact fixture identifiers only; never remove unrelated data.
    for (const id of userIds.splice(0)) await prisma.allowedUser.delete({ where: { id } });
    for (const id of clientIds.splice(0)) await prisma.mcpOAuthClient.delete({ where: { id } });
  });
  afterAll(async () => {
    try {
      if (originalSettings) {
        await prisma.mcpSettings.update({ where: { id: "global" }, data: { enabled: originalSettings.enabled } });
      } else if (originalSettings === null) {
        await prisma.mcpSettings.delete({ where: { id: "global" } });
      }
    } finally {
      vi.unstubAllEnvs();
      await Promise.all([prisma.$disconnect(), lockObserver?.$disconnect()]);
    }
  });

  it("admin demotion permanently revokes PATs, OAuth families, and pending grants", async () => {
    const { user, pat, access } = await makeFixture();
    expect((await validateMcpBearerToken(`Bearer ${pat.token}`)).role).toBe("USER");
    expect((await validateMcpBearerToken(`Bearer ${access.token}`)).role).toBe("USER");
    expect((await updateRole(user.id, "ADVISOR")).status).toBe(200);
    expect(await prisma.mcpPersonalToken.count({ where: { userEmail: user.email, revokedAt: null } })).toBe(0);
    expect(await prisma.mcpConnection.count({ where: { userEmail: user.email, revokedAt: null } })).toBe(0);
    expect(await prisma.mcpAccessToken.count({ where: { connection: { userEmail: user.email }, revokedAt: null } })).toBe(0);
    expect(await prisma.mcpRefreshToken.count({ where: { connection: { userEmail: user.email }, revokedAt: null } })).toBe(0);
    expect(await prisma.mcpOAuthAuthorizationCode.count({ where: { userEmail: user.email, consumedAt: null } })).toBe(0);
    expect((await updateRole(user.id, "USER")).status).toBe(200);
    await expect(validateMcpBearerToken(`Bearer ${pat.token}`)).rejects.toThrow("Invalid bearer token");
    await expect(validateMcpBearerToken(`Bearer ${access.token}`)).rejects.toThrow("Invalid bearer token");
  });

  it("uses the live role even if an out-of-band update omitted credential revocation", async () => {
    const { user, pat, access } = await makeFixture();
    await prisma.allowedUser.update({ where: { id: user.id }, data: { role: "ADVISOR" } });
    await expect(validateMcpBearerToken(`Bearer ${pat.token}`)).rejects.toThrow("Invalid bearer token");
    await expect(validateMcpBearerToken(`Bearer ${access.token}`)).rejects.toThrow("Invalid bearer token");
  });

  it("rolls back privilege changes together with revocations on transaction failure", async () => {
    const { user, pat } = await makeFixture();
    await expect(prisma.$transaction(async (tx) => {
      await lockMcpUser(tx, user.email);
      await tx.allowedUser.update({ where: { id: user.id }, data: { role: "ADVISOR" } });
      await revokeUserMcpCredentials(tx, user.email);
      throw new Error("synthetic rollback");
    })).rejects.toThrow("synthetic rollback");
    expect((await prisma.allowedUser.findUniqueOrThrow({ where: { id: user.id } })).role).toBe("USER");
    expect((await validateMcpBearerToken(`Bearer ${pat.token}`)).role).toBe("USER");
  });

  it("revokes a credential issued just before a concurrent demotion", async () => {
    const { user } = await makeFixture();
    const locked = deferred();
    const release = deferred();
    const token = createOpaqueToken("mcp_pat");
    const issuance = prisma.$transaction(async (tx) => {
      expect(canUseMcp(await lockMcpUser(tx, user.email))).toBe(true);
      locked.resolve();
      await release.promise;
      return tx.mcpPersonalToken.create({ data: {
        tokenHash: token.hash, prefix: token.publicPrefix, lastFour: token.lastFour,
        name: "Synthetic concurrent issuance", userEmail: user.email, scopes: [],
      } });
    }, { timeout: 10_000 });
    await locked.promise;
    const demotion = updateRole(user.id, "ADVISOR");
    const settled = Promise.allSettled([issuance, demotion]);
    try { await expectUserLockWaiter(); } finally {
      release.resolve();
      await settled;
    }
    const issued = await issuance;
    expect((await demotion).status).toBe(200);
    expect((await prisma.mcpPersonalToken.findUniqueOrThrow({ where: { id: issued.id } })).revokedAt).not.toBeNull();
  });

  it("denies issuance queued behind a concurrent demotion", async () => {
    const { user } = await makeFixture();
    const locked = deferred();
    const release = deferred();
    const demotion = prisma.$transaction(async (tx) => {
      await lockMcpUser(tx, user.email);
      await tx.allowedUser.update({ where: { id: user.id }, data: { role: "ADVISOR" } });
      await revokeUserMcpCredentials(tx, user.email);
      locked.resolve();
      await release.promise;
    }, { timeout: 10_000 });
    await locked.promise;
    const issuanceAllowed = prisma.$transaction(async (tx) => canUseMcp(await lockMcpUser(tx, user.email)));
    const settled = Promise.allSettled([demotion, issuanceAllowed]);
    try { await expectUserLockWaiter(); } finally {
      release.resolve();
      await settled;
    }
    await demotion;
    expect(await issuanceAllowed).toBe(false);
  });

  it("commits family revocation when concurrent callers reuse the same refresh token", async () => {
    const { user, refresh, client, connection } = await makeFixture();
    const locked = deferred();
    const release = deferred();
    const hold = prisma.$transaction(async (tx) => {
      await lockMcpUser(tx, user.email);
      locked.resolve();
      await release.promise;
    }, { timeout: 10_000 });
    await locked.promise;
    const input = { refreshToken: refresh.token, clientId: client.clientId };
    const callers = Promise.allSettled([refreshAccessToken(input), refreshAccessToken(input)]);
    const settled = Promise.allSettled([hold, callers]);
    // Both callers read the unrotated token before either acquires the lock.
    try { await expectUserLockWaiter(2); } finally {
      release.resolve();
      await settled;
    }
    await hold;
    const results = await callers;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await prisma.mcpConnection.findUniqueOrThrow({ where: { id: connection.id } })).revokedAt).not.toBeNull();
    const winner = results.find((r) => r.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("Expected one initial refresh success");
    await expect(validateMcpBearerToken(`Bearer ${winner.value.access_token}`)).rejects.toThrow("Invalid bearer token");
  });
});
