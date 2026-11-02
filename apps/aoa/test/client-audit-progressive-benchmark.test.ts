import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
const captured = vi.hoisted(() => ({ queries: [] as unknown[] }));
vi.mock("@/lib/rls", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/rls")>();
  const { Prisma: Sql } = await import("@prisma/client");
  return { ...original, withUserScope: (identity: unknown, fn: (tx: unknown) => unknown, options: unknown) =>
    original.withUserScope(identity as Parameters<typeof original.withUserScope>[0], async tx => fn(new Proxy(tx, {
      get(target, key) {
        if (key !== "$queryRaw") return Reflect.get(target, key);
        return (...args: unknown[]) => {
          const query = Array.isArray(args[0]) ? Sql.sql(args[0] as unknown as TemplateStringsArray, ...args.slice(1)) : args[0];
          captured.queries.push(query);
          return (target.$queryRaw.bind(target) as (...values: unknown[]) => Promise<unknown>)(...args);
        };
      },
    })), options as Parameters<typeof original.withUserScope>[2]) };
});
import { getClientDirectory } from "@/lib/data/clients";
import { listAuditLog } from "@/lib/data/audit-log";
import { listRowChanges } from "@/lib/data/row-changes";
import { withUserScope } from "@/lib/rls";

// Repeatable local measurement only; never a production or CI latency promise.
const benchmark = process.env.CLIENT_AUDIT_NAVIGATION_BENCHMARK === "1" ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "client-audit-benchmark@example.invalid" };
const CLIENTS = 20_000, EVENTS = 50_000, FIELD_CHANGES = 200_000;
benchmark("Client/Audit progressive query scale with synthetic bodies", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE 'PCB-C-%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE 'PCB-H-%'`;
    await owner.$executeRaw`DELETE FROM audit."AuditLog" WHERE "entityType" = 'pcb_synthetic_benchmark'`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE table_name = 'pcb_synthetic_benchmark'`;
  }
  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw || !process.env.DATABASE_URL) throw new Error("explicit_synthetic_database_required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      const url = new URL(value!);
      if (url.hostname !== "127.0.0.1" || !["/aoa_rollout_synthetic", "/aoa_pagination_synthetic"].includes(url.pathname) || url.username !== username
        || url.host !== target.host || url.pathname !== target.pathname) throw new Error("isolated_synthetic_benchmark_required");
    }
    owner = new PrismaClient({ datasourceUrl: raw });
    await cleanup();
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
      SELECT 'PCB-H-' || lpad(i::text, 8, '0'), 'Synthetic benchmark household ' || i, 'Client', ${OPS.email}
      FROM generate_series(1, ${CLIENTS}) i`;
    await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
      SELECT 'PCB-C-' || lpad(i::text, 8, '0'), 'PCB-H-' || lpad(i::text, 8, '0'), 'Synthetic benchmark', i::text, ${OPS.email}
      FROM generate_series(1, ${CLIENTS}) i`;
    await owner.$executeRaw`INSERT INTO audit."AuditLog" (at, action, "entityType", detail)
      SELECT '2026-01-01'::timestamptz + i * interval '1 second', 'pcb.synthetic', 'pcb_synthetic_benchmark',
      json_build_object('invented_body', repeat(md5(i::text), 64))::text FROM generate_series(1, ${EVENTS}) i`;
    await owner.$executeRaw`INSERT INTO audit.row_change (at, db_role, schema_name, table_name, op, row_pk, changed)
      SELECT '2026-09-17'::timestamptz, 'app_rw', 'app', 'pcb_synthetic_benchmark',
      'UPDATE', 'PCB-' || i, jsonb_build_object('invented_body', repeat(md5(i::text), 64)) FROM generate_series(1, ${FIELD_CHANGES}) i`;
    for (const table of [Prisma.sql`mirror.client`, Prisma.sql`mirror.household`, Prisma.sql`audit."AuditLog"`, Prisma.sql`audit.row_change`]) {
      await owner.$executeRaw(Prisma.sql`ANALYZE ${table}`);
    }
  }, 120_000);
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } vi.unstubAllEnvs(); }, 120_000);
  it("records actual scoped page timings and SQL plans without rewriting the queries", async () => {
    const filters = { query: "Synthetic benchmark", stage: "client" as const, sortKey: "name" as const, sortDir: "asc" as const };
    const results: Record<string, unknown> = {};
    for (const [name, read, match] of [
      ["clients", () => getClientDirectory(OPS, filters, 1, 100), "WITH visible_client"],
      ["audit_events", () => listAuditLog(OPS, { action: "pcb.synthetic", pageSize: 100 }), "md5(COUNT(*)::text"],
      ["audit_changes", () => listRowChanges(OPS, { table: "pcb_synthetic_benchmark", pageSize: 100 }), "MAX(id)"],
      ["audit_changes_unfiltered", () => listRowChanges(OPS, { pageSize: 100 }), "MAX(id)"],
    ] as const) {
      const times: number[] = [], plans: Record<string, unknown>[] = [];
      for (let run = 0; run < 3; run++) {
        captured.queries = [];
        const started = performance.now(), result = await read();
        times.push(Number((performance.now() - started).toFixed(2)));
        if ("ok" in result && !result.ok) throw new Error("Unexpected forbidden read");
        expect(result.rows).toHaveLength(100);
        if (name === "audit_changes_unfiltered") expect(result.total).toBeGreaterThanOrEqual(FIELD_CHANGES);
        else expect(result.total).toBe(name === "clients" ? CLIENTS : name === "audit_events" ? EVENTS : FIELD_CHANGES);
        // Measure every actual Audit query: an inexpensive watermark cannot
        // stand in for the ordered page or its unfiltered dropdown scans.
        const queries = captured.queries.filter(value => value && typeof value === "object" && "sql" in value
          && (name !== "clients" || String(value.sql).includes(match))) as Prisma.Sql[];
        expect(queries).toHaveLength(name === "clients" ? 1 : name === "audit_events" ? 4 : 2);
        for (const [queryIndex, query] of queries.entries()) {
          if (name !== "clients") expect(query.sql).not.toMatch(/string_agg|to_jsonb/);
          const [plan] = await withUserScope(OPS, tx => tx.$queryRaw<Array<{ "QUERY PLAN": Record<string, unknown>[] }>>(
            Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`), { timeout: 60_000 });
          const root = plan["QUERY PLAN"][0], detail = root.Plan as Record<string, unknown>;
          plans.push({ run, queryIndex, queryKind: name === "clients" ? "directory" : queryIndex === 0 ? name === "audit_events" ? "watermark" : "metadata" : queryIndex === 1 ? "rows" : "vocabulary",
            planningMs: root["Planning Time"], executionMs: root["Execution Time"], sharedHitBlocks: detail["Shared Hit Blocks"],
            sharedReadBlocks: detail["Shared Read Blocks"], tempWrittenBlocks: detail["Temp Written Blocks"] });
        }
      }
      results[name] = { complete100RowPageMs: times, explain: plans };
    }
    process.stdout.write(JSON.stringify({ event: "client_audit_navigation_synthetic_benchmark", clients: CLIENTS,
      auditEvents: EVENTS, fieldChanges: FIELD_CHANGES, inventedBodyBytes: 2048, fieldChangeTimestamps: "one shared batch timestamp",
      source: "warm loopback PostgreSQL; no production data", results }) + "\n");
  }, 120_000);
});
