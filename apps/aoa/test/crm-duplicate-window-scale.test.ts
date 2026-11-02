import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
const captured = vi.hoisted(() => ({ queries: [] as Array<{ sql: Prisma.Sql; ms: number }> }));
vi.mock("@/lib/rls", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/rls")>();
  return { ...original, withUserScope: (identity: Parameters<typeof original.withUserScope>[0],
    fn: Parameters<typeof original.withUserScope>[1], options: Parameters<typeof original.withUserScope>[2]) =>
    original.withUserScope(identity, tx => fn(new Proxy(tx, { get(target, key) {
      if (key !== "$queryRaw") return Reflect.get(target, key);
      return async (sql: Prisma.Sql) => {
        const start = performance.now();
        try { return await target.$queryRaw(sql); }
        finally { captured.queries.push({ sql, ms: Number((performance.now() - start).toFixed(2)) }); }
      };
    } })), options) };
});
import { listCrmDuplicateWindow } from "@/lib/data/crm-duplicate-review";
import { withUserScope } from "@/lib/rls";
import { applyCrmExplorerDatabaseBounds } from "@/lib/data/crm-explorer";

const benchmark = process.env.CRM_DUPLICATE_WINDOW_SCALE === "1" ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "crm-stress-a@example.invalid" };
benchmark("duplicate window with populated synthetic source families", () => {
  let owner: PrismaClient;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "https://invalid");
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== "127.0.0.1"
      || url.port !== "55444" || url.pathname !== "/aoa_directory_contention_synthetic" || url.username !== "app_rw"
      || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
      || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
      || ["prod", "production", "dev", "development"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
      throw new Error("isolated_synthetic_database_required");
    }
    const ownerUrl = new URL(process.env.AUDIT_TEST_CLEANUP_URL ?? "https://invalid");
    if (ownerUrl.hostname !== url.hostname || ownerUrl.port !== url.port || ownerUrl.pathname !== url.pathname
      || ownerUrl.protocol !== url.protocol || ownerUrl.username !== "aoa" || ownerUrl.search !== url.search) {
      throw new Error("isolated_synthetic_owner_required");
    }
    owner = new PrismaClient({ datasourceUrl: ownerUrl.href });
    // Dedicated invented rows only; retain the preexisting all-family fixture.
    await owner.$executeRaw`INSERT INTO app.crm_duplicate_candidate
      (id, detector_key, entity_type, left_identity_id, right_identity_id, evidence_codes, status,
       decision_reason, canonical_identity_id, updated_at)
      SELECT 'dup_summstress_h' || i, md5('summstress-h-' || i) || md5('summstress-h-' || i), 'HOUSEHOLD',
        LEAST('hld_fss' || md5('001ZGT200725818AAA'), 'hld_fss' || md5('001FSS' || lpad((i + 1001)::text,9,'0') || 'AAA')),
        GREATEST('hld_fss' || md5('001ZGT200725818AAA'), 'hld_fss' || md5('001FSS' || lpad((i + 1001)::text,9,'0') || 'AAA')),
        ARRAY['SHARED_CEDAR_RIDGE_USER_ID'], 'READY_FOR_FOLLOW_UP', 'SHARED_IDENTIFIER_CONFIRMED',
        'hld_fss' || md5('001ZGT200725818AAA'), now() FROM generate_series(1,100) i ON CONFLICT(id) DO NOTHING`;
    await owner.$executeRaw`INSERT INTO app.crm_duplicate_candidate
      (id, detector_key, entity_type, left_identity_id, right_identity_id, evidence_codes, status,
       decision_reason, canonical_identity_id, updated_at)
      SELECT 'dup_summstress_c' || i, md5('summstress-c-' || i) || md5('summstress-c-' || i), 'CONTACT',
        LEAST('con_fss' || md5('003ZGT200725818AAA'), 'con_fss' || md5('003FSS' || lpad((i + 1001)::text,9,'0') || 'AAA')),
        GREATEST('con_fss' || md5('003ZGT200725818AAA'), 'con_fss' || md5('003FSS' || lpad((i + 1001)::text,9,'0') || 'AAA')),
        ARRAY['SHARED_CEDAR_RIDGE_USER_ID'], 'READY_FOR_FOLLOW_UP', 'SHARED_IDENTIFIER_CONFIRMED',
        'con_fss' || md5('003ZGT200725818AAA'), now() FROM generate_series(1,100) i ON CONFLICT(id) DO NOTHING`;
    vi.stubEnv("CRM_IDENTITY_READS", "1");
  });
  afterAll(async () => { await owner?.$disconnect(); vi.unstubAllEnvs(); });
  it("measures the existing candidate population and actual query plan", async () => {
    for (const view of ["potential", "confirmed"] as const) {
      captured.queries = [];
      const start = performance.now();
      // The final acceptance benchmark must fail on timeout, not merely print it.
      const result = await listCrmDuplicateWindow(OPS, view, null, { firstPage: 1, pageSize: 100, loaded: 0, snapshot: null });
      if (!result.ok) throw new Error("expected_access");
      expect(result.meta.total).toBe(view === "confirmed" ? 200 : 500);
      expect(result.rows).toHaveLength(100);
      process.stdout.write(JSON.stringify({ event: "duplicate_window_scale", view, ms: performance.now() - start,
        total: result.meta.total, queries: captured.queries.map(q => q.ms) }) + "\n");
      const sql = captured.queries.find(q => q.sql.sql.includes("similar_confirmed"))?.sql;
      if (!sql) throw new Error("candidate_query_not_captured");
      const [raw] = await withUserScope(OPS, async tx => {
        await applyCrmExplorerDatabaseBounds(tx);
        await tx.$executeRaw`SELECT set_config('statement_timeout', '60000', true)`;
        return tx.$queryRaw<Array<{ "QUERY PLAN": Array<Record<string, unknown>> }>>(
          Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
      }, { timeout: 65_000, maxWait: 5_000 });
      const plan = raw["QUERY PLAN"][0];
      const nodes: unknown[] = [];
      const walk = (node: Record<string, unknown>) => {
        if ((node["Subplan Name"] && Number(node["Actual Loops"]) > 0) || Number(node["Actual Total Time"]) > 100) nodes.push({ type: node["Node Type"],
          relation: node["Relation Name"], subplan: node["Subplan Name"], ms: node["Actual Total Time"], loops: node["Actual Loops"],
          rows: node["Actual Rows"], reads: node["Shared Read Blocks"], hits: node["Shared Hit Blocks"] });
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
      };
      walk(plan.Plan as Record<string, unknown>);
      process.stdout.write(JSON.stringify({ event: "duplicate_window_scale_plan", view, executionMs: plan["Execution Time"], nodes }) + "\n");
      const next = await listCrmDuplicateWindow(OPS, view, null, {firstPage:1,pageSize:100,loaded:result.loaded,snapshot:result.snapshot});
      if(!next.ok)throw new Error("expected_continuation");
      expect(next.rows).toHaveLength(100);
      expect(next.loaded).toBe(200);
      expect(next.meta).toEqual(result.meta);
      expect(new Set([...result.rows,...next.rows].map(row=>row.id)).size).toBe(200);
      const restored=await listCrmDuplicateWindow(OPS,view,null,{firstPage:1,pageSize:100,loaded:0,snapshot:null,restoreRows:200});
      if(!restored.ok)throw new Error("expected_restore");
      expect(restored.snapshot).toBe(next.snapshot);
      expect(restored.rows).toEqual([...result.rows,...next.rows]);
    }
  }, 180_000);
  it("keeps five concurrent confirmed reads within unchanged real application deadlines",async()=>{
    const started=performance.now();
    const results=await Promise.all(Array.from({length:5},()=>listCrmDuplicateWindow(OPS,"confirmed",null,
      {firstPage:1,pageSize:100,loaded:0,snapshot:null})));
    for(const result of results){
      if(!result.ok)throw new Error("expected_access");
      expect(result.meta.total).toBe(200);
      expect(result.rows).toHaveLength(100);
      expect(result.snapshot).toBe(results[0].ok?results[0].snapshot:null);
    }
    process.stdout.write(JSON.stringify({event:"duplicate_window_concurrent",requests:5,ms:performance.now()-started})+"\n");
  },30_000);
});
