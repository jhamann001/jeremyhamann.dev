import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));
const captured = vi.hoisted(() => ({ queries: [] as unknown[] }));
vi.mock("@/lib/rls", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/rls")>();
  const { Prisma: Sql } = await import("@prisma/client");
  return { ...original, withUserScope: (identity: Parameters<typeof original.withUserScope>[0],
    fn: (tx: Prisma.TransactionClient) => unknown, options: Parameters<typeof original.withUserScope>[2]) =>
    original.withUserScope(identity, async tx => fn(new Proxy(tx, {
      get(target, key) {
        if (key !== "$queryRaw") return Reflect.get(target, key);
        return (...args: unknown[]) => {
          const query = Array.isArray(args[0])
            ? Sql.sql(args[0] as unknown as TemplateStringsArray, ...args.slice(1)) : args[0];
          captured.queries.push(query);
          return (target.$queryRaw.bind(target) as (...values: unknown[]) => Promise<unknown>)(...args);
        };
      },
    })), options) };
});

import { applyNavCountDatabaseBounds, navCounts } from "@/lib/data/nav-counts";
import { withUserScope } from "@/lib/rls";
import { previousNavCounts } from "@/test/fixtures/nav-counts-before-batch";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "nav-jit-ops@example.test" };
const ADVISOR = { role: "ADVISOR", email: "nav-jit-advisor@example.test" };
type Settings = { jit: string; statement: string; lock: string; pid: number };
const settings = (tx: Pick<Prisma.TransactionClient, "$queryRaw">) => tx.$queryRaw<Settings[]>`
  SELECT current_setting('jit') AS jit, current_setting('statement_timeout') AS statement,
    current_setting('lock_timeout') AS lock, pg_backend_pid() AS pid`;

gated("sidebar badge transaction-local JIT policy", () => {
  let owner: PrismaClient;
  let reader: PrismaClient;
  let beforeOps: Awaited<ReturnType<typeof navCounts>>;
  let beforeAdvisor: Awaited<ReturnType<typeof navCounts>>;

  async function cleanup() {
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE 'NAV-JIT-C-%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE 'NAV-JIT-H-%'`;
  }

  beforeAll(async () => {
    const raw = process.env.DATABASE_URL, cleanupUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw || !cleanupUrl) throw new Error("explicit_nav_jit_synthetic_urls_required");
    const target = new URL(cleanupUrl);
    for (const [value, username] of [[raw, "app_rw"], [cleanupUrl, "aoa"]]) {
      const url = new URL(value);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !(url.pathname.endsWith("_synthetic") || (process.env.CI === "true" && url.pathname === "/aoa"))
        || url.username !== username || url.host !== target.host || url.pathname !== target.pathname) {
        throw new Error("loopback_nav_jit_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: cleanupUrl });
    const single = new URL(raw);
    single.searchParams.set("connection_limit", "1");
    reader = new PrismaClient({ datasourceUrl: single.toString() });
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await cleanup();
    beforeOps = await navCounts(OPS);
    beforeAdvisor = await navCounts(ADVISOR);
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
      VALUES ('NAV-JIT-H-A', 'Invented Nav JIT A', 'Client', ${ADVISOR.email}),
        ('NAV-JIT-H-B', 'Invented Nav JIT B', 'Client', 'nav-jit-other@example.test')`;
    await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, stage, lead_advisor_email)
      VALUES ('NAV-JIT-C-A', 'NAV-JIT-H-A', 'Invented Nav JIT A', 'Client', ${ADVISOR.email}),
        ('NAV-JIT-C-B', 'NAV-JIT-H-B', 'Invented Nav JIT B', 'Client', 'nav-jit-other@example.test')`;
  });

  beforeEach(() => { captured.queries = []; });
  afterAll(async () => {
    if (owner) { await cleanup(); await owner.$disconnect(); }
    if (reader) await reader.$disconnect();
    vi.unstubAllEnvs();
  });

  it.each([false, true])("restores the same pooled connection settings after rollback=%s", async rollback => {
    const before = (await settings(reader))[0];
    const operation = reader.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('jit', 'on', true)`;
      expect((await settings(tx))[0].jit).toBe("on");
      await applyNavCountDatabaseBounds(tx);
      expect((await settings(tx))[0]).toEqual({ ...before, jit: "off", statement: "10s", lock: "2s" });
      if (rollback) throw new Error("synthetic_nav_jit_rollback");
    });
    if (rollback) await expect(operation).rejects.toThrow("synthetic_nav_jit_rollback");
    else await operation;
    expect(await settings(reader)).toEqual([before]);
  });

  it.each([OPS, ADVISOR])("returns exactly the unchanged JIT-on counts for $role", async identity => {
    const actual = await navCounts(identity);
    const queries = captured.queries.slice() as Prisma.Sql[];
    expect(queries).toHaveLength(1);
    const baseline = await withUserScope(identity, async tx => {
      await tx.$executeRaw`SELECT set_config('jit', 'on', true),
        set_config('statement_timeout', '10000', true), set_config('lock_timeout', '2000', true)`;
      return tx.$queryRaw<Awaited<ReturnType<typeof navCounts>>[]>(queries[0]);
    }, { timeout: 15_000, maxWait: 5_000 });
    expect(actual).toEqual(baseline[0]);
    const before = identity.role === "OPERATIONS" ? beforeOps : beforeAdvisor;
    const delta = identity.role === "OPERATIONS" ? 2 : 1;
    expect(actual.households - before.households).toBe(delta);
    expect(actual.clients - before.clients).toBe(delta);
  });

  it("cancels the whole batched statement instead of resetting the SQL deadline for each queued count", async () => {
    await previousNavCounts(OPS);
    await navCounts(OPS);
    const queries = captured.queries.slice() as Prisma.Sql[];
    expect(queries).toHaveLength(6);
    // Synthetic latency only: each of the first four independent counts takes
    // 150ms. All pass individually under 300ms, but their single batch must be
    // cancelled by that same whole-statement budget. Production remains 10s.
    const delayed = (query: Prisma.Sql) => Prisma.sql(
      query.strings.map(part => part.replaceAll("SELECT count(*)::int AS n",
        "SELECT count(*)::int + (SELECT 0 FROM pg_sleep(0.15)) AS n")) as unknown as TemplateStringsArray,
      ...query.values,
    );
    const before = (await settings(reader))[0];
    await reader.$transaction(async tx => {
      await applyNavCountDatabaseBounds(tx);
      await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true),
        set_config('app.user_email', ${OPS.email}, true), set_config('statement_timeout', '300', true)`;
      for (const query of queries.slice(0, 5)) await tx.$queryRaw(delayed(query));
    }, { timeout: 5_000 });
    const started = performance.now();
    await expect(reader.$transaction(async tx => {
      await applyNavCountDatabaseBounds(tx);
      await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true),
        set_config('app.user_email', ${OPS.email}, true), set_config('statement_timeout', '300', true)`;
      await tx.$queryRaw(delayed(queries[5]));
    }, { timeout: 5_000 })).rejects.toMatchObject({ code: "P2010", meta: { code: "57014" } });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await settings(reader)).toEqual([before]);
  });
});
