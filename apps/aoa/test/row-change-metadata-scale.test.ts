import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
const captured = vi.hoisted(() => ({ queries: [] as Array<{ sql: unknown; ms: number }> }));
vi.mock("@/lib/rls", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/rls")>();
  const { Prisma: Sql } = await import("@prisma/client");
  return { ...original, withUserScope: (identity: Parameters<typeof original.withUserScope>[0], fn: (tx: Prisma.TransactionClient) => unknown,
    options: Parameters<typeof original.withUserScope>[2]) => original.withUserScope(identity, async tx => fn(new Proxy(tx, {
      get(target, key) {
        if (key !== "$queryRaw") return Reflect.get(target, key);
        return async (...args: unknown[]) => {
          const sql = Array.isArray(args[0]) ? Sql.sql(args[0] as unknown as TemplateStringsArray, ...args.slice(1)) : args[0];
          const started = performance.now();
          try { return await (target.$queryRaw.bind(target) as (...values: unknown[]) => Promise<unknown>)(...args); }
          finally { captured.queries.push({ sql, ms: Number((performance.now() - started).toFixed(2)) }); }
        };
      },
    })), options) };
});
import { listRowChanges } from "@/lib/data/row-changes";
import { withUserScope } from "@/lib/rls";
import { applyAuditReadDatabaseBounds, AUDIT_READ_TRANSACTION_OPTIONS } from "@/lib/data/audit-read-bounds";

// Read-only opt-in benchmark. Root seeds a dedicated 10M-row synthetic history;
// this test neither creates nor deletes rows and is excluded from ordinary CI.
const benchmark = process.env.AUDIT_METADATA_SCALE_BENCHMARK === "1" ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "audit-scale@example.invalid" };
benchmark("Audit metadata at representative synthetic history size", () => {
  beforeAll(() => {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error("explicit_synthetic_database_required");
    const url = new URL(raw);
    if (!["postgresql:", "postgres:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
      || url.port !== "55444" || url.pathname !== "/aoa_audit_scale_synthetic" || url.username !== "app_rw"
      || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
      || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
      || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
      throw new Error("isolated_synthetic_database_required");
    }
  });

  const previous = () => withUserScope(OPS, async tx => {
    await applyAuditReadDatabaseBounds(tx);
    const [{ total, watermark }] = await tx.$queryRaw<{ total: bigint; watermark: string }[]>`
      SELECT COUNT(*) AS total, md5(COUNT(*)::text || ':' || COALESCE(MAX(id)::text, '')) AS watermark
      FROM audit.row_change`;
    const rows = await tx.$queryRaw<{ id: bigint }[]>`SELECT id, at, actor_email, actor_role, db_role, table_name, op, row_pk, changed
      FROM audit.row_change ORDER BY at DESC, id DESC LIMIT 100 OFFSET 0`;
    const tables = await tx.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM audit.row_change ORDER BY table_name`;
    const ops = await tx.$queryRaw<{ op: string }[]>`SELECT DISTINCT op FROM audit.row_change ORDER BY op`;
    const actors = await tx.$queryRaw<{ actor_email: string }[]>`SELECT DISTINCT actor_email FROM audit.row_change WHERE actor_email IS NOT NULL ORDER BY actor_email`;
    return { total: Number(total), snapshot: createHash("sha256").update(watermark).update(JSON.stringify([tables, ops, actors])).digest("hex"),
      ids: rows.map(row => String(row.id)), tables: tables.map(row => row.table_name), ops: ops.map(row => row.op), actors: actors.map(row => row.actor_email) };
  }, { ...AUDIT_READ_TRANSACTION_OPTIONS, isolationLevel: "RepeatableRead" });

  it("compares actual scoped first/repeated reads and every unchanged result field", async () => {
    const measurements: unknown[] = [];
    for (let run = 0; run < 2; run++) {
      captured.queries = [];
      const oldStart = performance.now(), old = await previous();
      const before = { elapsedMs: Number((performance.now() - oldStart).toFixed(2)), queryMs: captured.queries.map(query => query.ms) };
      expect(old.total).toBeGreaterThanOrEqual(10_000_000);
      captured.queries = [];
      const newStart = performance.now(), current = await listRowChanges(OPS, { pageSize: 100 });
      const after = { elapsedMs: Number((performance.now() - newStart).toFixed(2)), queryMs: captured.queries.map(query => query.ms) };
      if (!current.ok) throw new Error("expected_audit_access");
      expect({ total: current.total, snapshot: current.snapshot, ids: current.rows.map(row => row.id),
        tables: current.tables, ops: current.ops, actors: current.actors }).toEqual(old);
      expect(captured.queries).toHaveLength(2);
      measurements.push({ run, total: old.total, before, after });
    }
    const metadataSql = captured.queries[0].sql as Prisma.Sql;
    const [explain] = await withUserScope(OPS, async tx => {
      await applyAuditReadDatabaseBounds(tx);
      return tx.$queryRaw<Array<{ "QUERY PLAN": Array<Record<string, unknown>> }>>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${metadataSql}`);
    }, { ...AUDIT_READ_TRANSACTION_OPTIONS, isolationLevel: "RepeatableRead" });
    const plan = explain["QUERY PLAN"][0], root = plan.Plan as Record<string, unknown>;
    const relations: string[] = [];
    const visit = (node: Record<string, unknown>) => {
      if (typeof node["Relation Name"] === "string") relations.push(node["Relation Name"]);
      if (Array.isArray(node.Plans)) for (const child of node.Plans) visit(child);
    };
    visit(root);
    expect(relations.filter(name => name === "row_change")).toHaveLength(1);
    process.stdout.write(JSON.stringify({ event: "audit_metadata_scale_benchmark", source: "synthetic local PostgreSQL app_rw with existing RLS/timeouts",
      cacheNote: "first observed and repeated reads; no cache flush or production latency claim", measurements,
      metadataPlan: { executionMs: plan["Execution Time"], sharedHitBlocks: root["Shared Hit Blocks"],
        sharedReadBlocks: root["Shared Read Blocks"], tempWrittenBlocks: root["Temp Written Blocks"], relationScans: relations } }) + "\n");
  }, 90_000);
});
