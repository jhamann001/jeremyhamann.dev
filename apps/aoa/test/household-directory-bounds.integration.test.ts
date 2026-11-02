import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { prisma } from "@/lib/db";
import { getHouseholdDirectory } from "@/lib/data/households";
import { DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS } from "@/lib/navigation/household-query";
import { applyHouseholdDirectoryDatabaseBounds, HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS } from "@/lib/data/household-directory-bounds";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const settings = (tx: Pick<Prisma.TransactionClient, "$queryRaw">) => tx.$queryRaw`
  SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS statement,
    current_setting('lock_timeout') AS lock, current_setting('jit') AS jit,
    nullif(current_setting('app.user_role', true), '') AS role`;

gated("Household directory cancellation and pooled-connection restoration", () => {
  let reader: PrismaClient, blocker: PrismaClient;
  beforeAll(() => {
    const raw = process.env.DATABASE_URL, cleanup = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw || !cleanup) throw new Error("explicit_synthetic_database_required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "app_rw"], [cleanup, "aoa"]]) {
      const url = new URL(value);
      if (!["postgresql:", "postgres:"].includes(url.protocol)
        || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !["5432", "55444"].includes(url.port) || url.username !== username
        || !(["/aoa_directory_contention_synthetic", "/aoa_pagination_synthetic", "/aoa_loading_full_synthetic"].includes(url.pathname)
          || (process.env.CI === "true" && url.pathname === "/aoa"))
        || url.host !== target.host || url.pathname !== target.pathname
        || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
        || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
        throw new Error("isolated_synthetic_database_required");
      }
    }
    target.searchParams.set("connection_limit", "1");
    reader = new PrismaClient({ datasourceUrl: target.toString() });
    blocker = new PrismaClient({ datasourceUrl: cleanup });
  });
  afterAll(async () => { await reader?.$disconnect(); await blocker?.$disconnect(); });

  it("cancels running SQL within the existing transaction deadline and releases the same connection", async () => {
    const before = await settings(reader);
    const start = performance.now();
    await expect(reader.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true)`;
      await applyHouseholdDirectoryDatabaseBounds(tx);
      await tx.$executeRaw`SELECT pg_sleep(12)`;
    }, HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS)).rejects.toMatchObject({ code: "P2010", meta: { code: "57014" } });
    expect(performance.now() - start).toBeLessThan(10_000);
    expect(await settings(reader)).toEqual(before);
    expect(await reader.$queryRaw`SELECT 1 AS recovered`).toEqual([{ recovered: 1 }]);
  }, 15_000);

  it("applies settings only inside the successful transaction", async () => {
    const before = await settings(reader);
    const scoped = await reader.$transaction(async tx => {
      await applyHouseholdDirectoryDatabaseBounds(tx);
      return settings(tx);
    }, HOUSEHOLD_DIRECTORY_TRANSACTION_OPTIONS);
    expect(scoped).toEqual([{ ...(before as object[])[0], statement: "4s", lock: "1s", jit: "off" }]);
    expect(await settings(reader)).toEqual(before);
  });

  it("cancels an actual blocked household read and then serves the same scoped query", async () => {
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { ready = resolve; });
    const transaction = vi.spyOn(prisma, "$transaction")
      .mockImplementation(reader.$transaction.bind(reader) as typeof prisma.$transaction);
    const before = await settings(reader);
    const hold = blocker.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
      await tx.$executeRaw`LOCK TABLE mirror.household IN ACCESS EXCLUSIVE MODE`;
      ready();
      await held;
    }, { timeout: 10_000 });
    const read = () => getHouseholdDirectory({ role: "ADVISOR", email: "household-bounds@example.invalid" },
      DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS, 1, 100);
    try {
      try {
        await Promise.race([acquired, hold]);
        await expect(read()).rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
      } finally { release(); await hold; }
      expect(await settings(reader)).toEqual(before);
      expect((await read()).rows).toEqual([]);
      expect(await settings(reader)).toEqual(before);
    } finally { transaction.mockRestore(); }
  }, 15_000);
});
