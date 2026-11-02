import { beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
const captured = vi.hoisted(() => ({ queries: [] as Prisma.Sql[] }));
vi.mock("@/lib/rls", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/rls")>();
  return { ...original, withUserScope: (identity: Parameters<typeof original.withUserScope>[0],
    fn: Parameters<typeof original.withUserScope>[1], options: Parameters<typeof original.withUserScope>[2]) =>
    original.withUserScope(identity, async tx => {
      await tx.$executeRaw`SELECT set_config('max_parallel_workers_per_gather', '0', true)`;
      return fn(new Proxy(tx, { get(target, key) {
        if (key !== "$queryRaw") return Reflect.get(target, key);
        return (query: Prisma.Sql) => { captured.queries.push(query); return target.$queryRaw(query); };
      } }));
    }, options) };
});
import { listRowChangeWindow } from "@/lib/data/row-changes";
import { withUserScope } from "@/lib/rls";
import { applyAuditReadDatabaseBounds, AUDIT_READ_TRANSACTION_OPTIONS } from "@/lib/data/audit-read-bounds";

// Read-only opt-in: preserved ten-million-row synthetic history; never live.
const benchmark = process.env.AUDIT_WINDOW_SCALE_BENCHMARK === "1" ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "audit-window-scale@example.invalid" };
benchmark("Audit bounded prefix rows at ten-million-row synthetic scale", () => {
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL ?? "https://invalid");
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
      || url.port !== "55444" || url.pathname !== "/aoa_audit_scale_synthetic" || url.username !== "app_rw"
      || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
      || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
      || ["prod", "production", "dev", "development"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
      throw new Error("isolated_synthetic_benchmark_required");
    }
  });
  it("reads a bounded first chunk and validated 5,000-row window without history metadata", async () => {
    const timings: Array<{ loaded: number; ms: number }> = [];
    let snapshot: string | null = null;
    let initialSql: Prisma.Sql | undefined;
    for (let loaded = 0; loaded < 5_000; loaded += 100) {
      captured.queries = [];
      const started = performance.now();
      const result = await listRowChangeWindow(OPS, { loaded, snapshot });
      timings.push({ loaded: loaded + 100, ms: Number((performance.now() - started).toFixed(3)) });
      if (!result.ok) throw new Error("expected_synthetic_window");
      expect(result.rows).toHaveLength(100);
      expect(result.loaded).toBe(loaded + 100);
      expect(result.hasMore).toBe(true);
      expect(captured.queries).toHaveLength(1);
      initialSql ??= captured.queries[0];
      snapshot = result.snapshot;
    }
    captured.queries = [];
    const restoreStarted = performance.now();
    const restored = await listRowChangeWindow(OPS, { loaded: 0, snapshot: null, restoreRows: 5_000 });
    const restoreMs = Number((performance.now() - restoreStarted).toFixed(3));
    if (!restored.ok) throw new Error("expected_synthetic_window");
    expect(restored.rows).toHaveLength(5_000);
    expect(restored.loaded).toBe(5_000);
    expect(restored.snapshot).toBe(snapshot);
    expect(captured.queries).toHaveLength(1);
    const [explain] = await withUserScope(OPS, async tx => {
      await applyAuditReadDatabaseBounds(tx);
      return tx.$queryRaw<Array<{ "QUERY PLAN": Array<Record<string, unknown>> }>>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${initialSql!}`);
    }, AUDIT_READ_TRANSACTION_OPTIONS);
    const plan = explain["QUERY PLAN"][0], scans: unknown[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (node["Relation Name"]) scans.push({ type: node["Node Type"], relation: node["Relation Name"],
        rows: node["Actual Rows"], loops: node["Actual Loops"], index: node["Index Name"], heapFetches: node["Heap Fetches"] });
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
    };
    walk(plan.Plan as Record<string, unknown>);
    process.stdout.write(JSON.stringify({ event: "audit_window_scale_benchmark",
      source: "local synthetic history; one query worker, no client data, no live latency claim",
      timings: [timings[0], timings[1], timings[24], timings[48], timings[49]],
      firstPagePlanMs: plan["Execution Time"], fresh5000RestoreMs: restoreMs, restoreQueries: 1, scans }) + "\n");
  }, 90_000);
});
