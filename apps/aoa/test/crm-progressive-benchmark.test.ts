import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
import { applyCrmExplorerDatabaseBounds, listCrmIdentities, readCrmNavigationState } from "@/lib/data/crm-explorer";
import { withUserScope } from "@/lib/rls";

// Explicit opt-in: a repeatable local scale measurement, not a CI latency gate.
const benchmark = process.env.CRM_NAVIGATION_BENCHMARK === "1" ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "crm-benchmark@example.test" };
const COUNT = 20_000;

benchmark("CRM navigation scoped SQL at synthetic registry scale", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'crmbm-map-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id LIKE 'hld_crmbm%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001CBM%'`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE
      (table_name = 'crm_identity' AND row_pk LIKE 'hld_crmbm%') OR
      (table_name = 'crm_source_mapping' AND row_pk LIKE 'crmbm-map-%')`;
  }

  beforeAll(async () => {
    const url = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!url || !process.env.DATABASE_URL) throw new Error("Explicit local synthetic database URLs required");
    const target = new URL(url);
    for (const value of [url, process.env.DATABASE_URL]) {
      const parsed = new URL(value);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
        || !parsed.pathname.endsWith("_synthetic") || parsed.pathname !== target.pathname) {
        throw new Error("CRM benchmark requires one loopback synthetic database");
      }
    }
    owner = new PrismaClient({ datasourceUrl: url });
    await cleanup();
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, lead_advisor_email)
      SELECT '001CBM' || lpad(i::text, 9, '0') || 'AAA', 'CRM Synthetic Benchmark ' || i, ${OPS.email}
      FROM generate_series(1, ${COUNT}) i`;
    await owner.$executeRaw`INSERT INTO app.crm_identity (id, identity_type, updated_at)
      SELECT 'hld_crmbm' || lpad(i::text, 8, '0'), 'HOUSEHOLD', '2026-01-01T00:00:00Z'
      FROM generate_series(1, ${COUNT}) i`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping
      (id, identity_id, source_system, source_namespace, source_key, updated_at)
      SELECT 'crmbm-map-' || i, 'hld_crmbm' || lpad(i::text, 8, '0'),
        'CRM', 'household', '001CBM' || lpad(i::text, 9, '0') || 'AAA', now()
      FROM generate_series(1, ${COUNT}) i`;
    await owner.$executeRaw`ANALYZE mirror.household`;
    await owner.$executeRaw`ANALYZE app.crm_identity`;
    await owner.$executeRaw`ANALYZE app.crm_source_mapping`;
  }, 120_000);

  afterAll(async () => {
    if (owner) { await cleanup(); await owner.$disconnect(); }
    vi.unstubAllEnvs();
  }, 120_000);

  it("records snapshot-only EXPLAIN and complete100-row scoped reads", async () => {
    let snapshotSql: Prisma.Sql | undefined;
    // Capture the actual production SQL object without rewriting its projection.
    await readCrmNavigationState({
      $queryRaw: async (query: unknown) => {
        if (query && typeof query === "object" && !Array.isArray(query) && "sql" in query) {
          snapshotSql = query as Prisma.Sql;
          return [{ snapshot: "0".repeat(32) }];
        }
        return [{ identities: 0n, source_aliases: 0n, open_exceptions: 0n, potential_duplicates: 0n, latest_seen_at: null }];
      },
    } as unknown as Prisma.TransactionClient);
    if (!snapshotSql) throw new Error("Snapshot SQL capture failed");

    const [jitSettings] = await withUserScope(OPS, (tx) => tx.$queryRaw<Array<{
      enabled: string; available: boolean; aboveCost: number; inlineAboveCost: number; optimizeAboveCost: number;
    }>>`
      SELECT current_setting('jit') AS enabled,
             pg_jit_available() AS available,
             current_setting('jit_above_cost')::double precision AS "aboveCost",
             current_setting('jit_inline_above_cost')::double precision AS "inlineAboveCost",
             current_setting('jit_optimize_above_cost')::double precision AS "optimizeAboveCost"`);

    const pageMs: number[] = [];
    const plans: Array<Record<string, unknown>> = [];
    for (let run = 0; run < 3; run += 1) {
      const start = performance.now();
      const page = await listCrmIdentities(OPS, { page: run + 1, q: "hld_crmbm" });
      pageMs.push(Number((performance.now() - start).toFixed(2)));
      expect(page.ok && page.rows.length).toBe(100);
      expect(page.ok && page.total).toBe(COUNT);
      const plan = await withUserScope(OPS, async (tx) => {
        await applyCrmExplorerDatabaseBounds(tx);
        return tx.$queryRaw<Array<{ "QUERY PLAN": Array<Record<string, unknown>> }>>(
          Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${snapshotSql}`,
        );
      }, { timeout: 60_000, maxWait: 5_000 });
      plans.push(plan[0]["QUERY PLAN"][0]);
    }
    process.stdout.write(JSON.stringify({
      event: "crm_navigation_synthetic_benchmark",
      fixture: { identities: COUNT, mappings: COUNT, households: COUNT, otherSourceTables: "empty" },
      jitSettings,
      completeScoped100RowPageMs: pageMs,
      snapshotExplain: plans.map((plan) => ({
        totalCost: (plan.Plan as Record<string, unknown>)["Total Cost"],
        planningMs: plan["Planning Time"], executionMs: plan["Execution Time"],
        // PostgreSQL includes functions/options/compilation timings only when JIT ran.
        jit: plan.JIT ?? null,
        sharedHitBlocks: (plan.Plan as Record<string, unknown>)["Shared Hit Blocks"],
        sharedReadBlocks: (plan.Plan as Record<string, unknown>)["Shared Read Blocks"],
        tempReadBlocks: (plan.Plan as Record<string, unknown>)["Temp Read Blocks"],
        tempWrittenBlocks: (plan.Plan as Record<string, unknown>)["Temp Written Blocks"],
      })),
    }) + "\n");
  }, 120_000);
});
