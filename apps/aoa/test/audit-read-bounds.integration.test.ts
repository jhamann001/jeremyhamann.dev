import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import {
  applyAuditReadDatabaseBounds, AUDIT_READ_TRANSACTION_OPTIONS,
  AUDIT_READ_STATEMENT_TIMEOUT_MS, AUDIT_READ_LOCK_TIMEOUT_MS,
} from "@/lib/data/audit-read-bounds";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
type Settings = { statement: string; lock: string; jit: string; role: string | null };
const settings = (tx: Pick<Prisma.TransactionClient, "$queryRaw">) => tx.$queryRaw<Settings[]>`
  SELECT current_setting('statement_timeout') AS statement,
         current_setting('lock_timeout') AS lock,
         current_setting('jit') AS jit,
         nullif(current_setting('app.user_role', true), '') AS role`;

gated("Audit SQL cancellation and single-connection pool recovery", () => {
  let reader: PrismaClient;
  let blocker: PrismaClient;
  beforeAll(() => {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error("explicit_synthetic_database_required");
    const url = new URL(raw);
    const allowedParameters = new Set(["schema", "connection_limit", "pool_timeout"]);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !["5432", "55444"].includes(url.port) || url.username !== "app_rw"
      || !(["/aoa_pagination_synthetic", "/aoa_loading_full_synthetic"].includes(url.pathname)
        || (process.env.CI === "true" && url.pathname === "/aoa"))
      || [...url.searchParams.keys()].some(key => !allowedParameters.has(key))
      || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
      || ["prod", "production", "dev", "development"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
      throw new Error("isolated_synthetic_database_required");
    }
    url.searchParams.set("connection_limit", "1");
    reader = new PrismaClient({ datasourceUrl: url.toString() });
    blocker = new PrismaClient({ datasourceUrl: url.toString() });
  });
  afterAll(async () => { await reader?.$disconnect(); await blocker?.$disconnect(); });

  it("shows why Prisma's transaction deadline alone cannot stop an active SQL statement", async () => {
    const started = performance.now();
    await expect(reader.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_sleep(0.5)`;
    }, { timeout: 100 })).rejects.toMatchObject({ code: "P2028" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(450);
    expect(await reader.$queryRaw`SELECT 1 AS recovered`).toEqual([{ recovered: 1 }]);
  });

  it("restores JIT and RLS settings after a successful scoped read on the same connection", async () => {
    const before = await settings(reader);
    await reader.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true)`;
      await applyAuditReadDatabaseBounds(tx);
      expect(await settings(tx)).toEqual([{
        statement: `${AUDIT_READ_STATEMENT_TIMEOUT_MS / 1000}s`,
        lock: `${AUDIT_READ_LOCK_TIMEOUT_MS / 1000}s`, jit: "off", role: "OPERATIONS",
      }]);
      expect(await tx.$queryRaw`SELECT 1 AS bounded_read`).toEqual([{ bounded_read: 1 }]);
    }, AUDIT_READ_TRANSACTION_OPTIONS);
    expect(await settings(reader)).toEqual(before);
  });

  it("cancels expensive reads in PostgreSQL and restores the connection's RLS/settings", async () => {
    const before = await settings(reader);
    const started = performance.now();
    await expect(reader.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true)`;
      await applyAuditReadDatabaseBounds(tx);
      expect(await settings(tx)).toEqual([{
        statement: `${AUDIT_READ_STATEMENT_TIMEOUT_MS / 1000}s`,
        lock: `${AUDIT_READ_LOCK_TIMEOUT_MS / 1000}s`, jit: "off", role: "OPERATIONS",
      }]);
      await tx.$executeRaw`SELECT pg_sleep(30)`;
    }, AUDIT_READ_TRANSACTION_OPTIONS)).rejects.toMatchObject({ code: "P2010", meta: { code: "57014" } });
    // A generous ceiling distinguishes SQL cancellation from the 30s sleep;
    // this is a resource-release check, not a production latency promise.
    expect(performance.now() - started).toBeLessThan(25_000);
    expect(await settings(reader)).toEqual(before);
    expect(await reader.$queryRaw`SELECT 1 AS recovered`).toEqual([{ recovered: 1 }]);
  }, 35_000);

  it("releases lock waiters before the statement budget and keeps the pool usable", async () => {
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const hold = blocker.$transaction(async tx => {
      await applyAuditReadDatabaseBounds(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(76119320260917)`;
      ready();
      await held;
    }, { timeout: 15_000 });
    try {
      await Promise.race([acquired, hold]);
      await expect(reader.$transaction(async tx => {
        await applyAuditReadDatabaseBounds(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(76119320260917)`;
      }, AUDIT_READ_TRANSACTION_OPTIONS)).rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
    } finally {
      release();
      await hold;
    }
    expect(await reader.$queryRaw`SELECT 1 AS recovered`).toEqual([{ recovered: 1 }]);
  }, 20_000);
});
