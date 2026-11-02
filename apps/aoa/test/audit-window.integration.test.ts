import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
const captured = vi.hoisted(() => ({ sql: [] as string[], timezone: "" }));
vi.mock("@/lib/rls", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/rls")>();
  return { ...original, withUserScope: (identity: Parameters<typeof original.withUserScope>[0],
    fn: Parameters<typeof original.withUserScope>[1], options: Parameters<typeof original.withUserScope>[2]) =>
    original.withUserScope(identity, async tx => {
      if (captured.timezone) await tx.$executeRaw`SELECT set_config('TimeZone', ${captured.timezone}, true)`;
      return fn(new Proxy(tx, {
      get(target, key) {
        if (key !== "$queryRaw") return Reflect.get(target, key);
        return (query: { sql: string }) => { captured.sql.push(query.sql); return target.$queryRaw(query as never); };
      },
      }));
    }, options) };
});
import { getRowChangeMetadata, listRowChanges, listRowChangeWindow } from "@/lib/data/row-changes";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "audit-window@example.invalid" };
const TABLE = "AWIN-SYNTHETIC";
gated("Audit bounded rows are independent of full-history metadata", () => {
  let owner: PrismaClient;
  let reservedId: bigint;
  const cleanup = () => owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE 'AWIN-SYN-%'`;
  beforeAll(() => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw || !process.env.DATABASE_URL) throw new Error("explicit_synthetic_database_required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      const url = new URL(value!);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !["5432", "55444"].includes(url.port) || url.username !== username
        || !(["/aoa_pagination_synthetic", "/aoa_loading_full_synthetic"].includes(url.pathname)
          || (process.env.CI === "true" && url.pathname === "/aoa"))
        || url.host !== target.host || url.pathname !== target.pathname
        || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
        || ["prod", "production", "dev", "development"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
        throw new Error("isolated_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: raw });
  });
  beforeEach(async () => {
    captured.timezone = "";
    await cleanup();
    const [{ id }] = await owner.$queryRaw<Array<{ id: bigint }>>`SELECT nextval('audit.row_change_id_seq') AS id`;
    reservedId = id;
    await owner.$executeRaw`INSERT INTO audit.row_change
      (at, actor_email, actor_role, db_role, schema_name, table_name, op, row_pk, changed)
      SELECT '2026-09-17T12:00:00Z'::timestamptz + i * interval '1 second',
        'audit-window@example.invalid', 'OPERATIONS', 'app_rw', 'app', ${TABLE}, 'UPDATE',
        'AWIN-SYN-' || i, jsonb_build_object('invented', i, 'body', repeat(md5(i::text), 8))
      FROM generate_series(1, 205) i`;
    captured.sql = [];
  });
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });

  it("returns only 100 rendered rows and one lookahead without a history count or facets", async () => {
    const first = await listRowChangeWindow(OPS, { table: TABLE });
    expect(first).toMatchObject({ ok: true, firstPage: 1, pageSize: 100, loaded: 100, hasMore: true, meta: {} });
    if (!first.ok) throw new Error("expected_access");
    expect(first.rows).toHaveLength(100);
    expect(captured.sql).toHaveLength(1);
    expect(captured.sql[0]).toContain("WITH page_ids AS MATERIALIZED");
    expect(captured.sql[0]).not.toMatch(/GROUP BY table_name|COUNT\(\*\).*FROM audit\.row_change/s);
    const legacy = await listRowChanges(OPS, { table: TABLE, pageSize: 100 });
    if (!legacy.ok) throw new Error("expected_access");
    expect(first.rows).toEqual(legacy.rows);
    const second = await listRowChangeWindow(OPS, { table: TABLE, loaded: 100, snapshot: first.snapshot });
    if (!second.ok) throw new Error("expected_access");
    expect(second).toMatchObject({ loaded: 200, hasMore: true });
    expect(second.rows).toHaveLength(100);
    expect(second.snapshot).not.toBe(first.snapshot);
    const third = await listRowChangeWindow(OPS, { table: TABLE, loaded: 200, snapshot: second.snapshot });
    if (!third.ok) throw new Error("expected_access");
    expect(third).toMatchObject({ loaded: 205, hasMore: false });
    expect(third.rows).toHaveLength(5);
    expect(new Set([...first.rows, ...second.rows, ...third.rows].map(row => row.id)).size).toBe(205);
    expect(await getRowChangeMetadata(OPS, { table: TABLE })).toMatchObject({ ok: true, total: 205 });
  });

  it.each(["new row", "late lower ID", "delete", "payload edit", "actor role edit"])("rejects a changed displayed prefix: %s", async change => {
    const first = await listRowChangeWindow(OPS, { table: TABLE });
    if (!first.ok) throw new Error("expected_access");
    if (change === "new row") {
      await owner.$executeRaw`INSERT INTO audit.row_change (at, db_role, schema_name, table_name, op, row_pk, changed)
        VALUES ('2026-09-18'::timestamptz, 'app_rw', 'app', ${TABLE}, 'UPDATE', 'AWIN-SYN-new', '{}')`;
    } else if (change === "late lower ID") {
      // An explicitly reserved historical ID can commit after newer IDs. The
      // timestamp places it inside the visible prefix without changing MAX(id).
      await owner.$executeRaw`INSERT INTO audit.row_change (id, at, db_role, schema_name, table_name, op, row_pk, changed)
        VALUES (${reservedId}, '2026-09-17T12:03:00Z'::timestamptz, 'app_rw', 'app', ${TABLE}, 'UPDATE', 'AWIN-SYN-late', '{}')`;
    } else if (change === "delete") {
      await owner.$executeRaw`DELETE FROM audit.row_change WHERE id = ${BigInt(first.rows[1].id)}`;
    } else if (change === "payload edit") {
      await owner.$executeRaw`UPDATE audit.row_change SET changed = '{"invented":"updated"}'::jsonb WHERE id = ${BigInt(first.rows[1].id)}`;
    } else {
      await owner.$executeRaw`UPDATE audit.row_change SET actor_role = 'ADMIN' WHERE id = ${BigInt(first.rows[1].id)}`;
    }
    expect(await listRowChangeWindow(OPS, { table: TABLE, loaded: 100, snapshot: first.snapshot }))
      .toEqual({ ok: false, reason: "changed" });
  });

  it("supports exact-filter direct windows, empty windows and metadata without inventing totals", async () => {
    const direct = await listRowChangeWindow(OPS, { table: TABLE, op: "UPDATE", actor: OPS.email, page: 2 });
    const legacy = await listRowChanges(OPS, { table: TABLE, op: "UPDATE", actor: OPS.email, page: 2, pageSize: 100 });
    if (!direct.ok || !legacy.ok) throw new Error("expected_access");
    expect(direct.rows).toEqual(legacy.rows);
    expect(direct).toMatchObject({ firstPage: 2, loaded: 100, hasMore: true });
    expect(direct).not.toHaveProperty("total");
    const empty = await listRowChangeWindow(OPS, { table: "AWIN-ABSENT", page: 30 });
    expect(empty).toMatchObject({ ok: true, rows: [], firstPage: 30, loaded: 0, hasMore: false });
  });

  it("applies inclusive UTC dates before limiting, including the final microsecond across a DST day", async () => {
    await owner.$executeRaw`INSERT INTO audit.row_change (at, db_role, schema_name, table_name, op, actor_email, row_pk, changed)
      VALUES ('2026-03-07T23:59:59.999999Z'::timestamptz,'app_rw','app',${TABLE},'UPDATE',NULL,'AWIN-SYN-before','{}'),
        ('2026-03-08T00:00:00Z'::timestamptz,'app_rw','app',${TABLE},'UPDATE',NULL,'AWIN-SYN-start','{}'),
        ('2026-03-08T12:00:00Z'::timestamptz,'app_rw','app',${TABLE},'UPDATE',${OPS.email},'AWIN-SYN-middle','{}'),
        ('2026-03-08T23:59:59.999999Z'::timestamptz,'app_rw','app',${TABLE},'UPDATE',NULL,'AWIN-SYN-last','{}'),
        ('2026-03-09T00:00:00Z'::timestamptz,'app_rw','app',${TABLE},'UPDATE',NULL,'AWIN-SYN-after','{}')`;
    // RLS-scoped transaction is deliberately not in UTC: a calendar-day interval
    // would otherwise be 23 hours at this DST transition. The query uses24hours.
    captured.timezone = "America/New_York";
    const query = { table: TABLE, from: "2026-03-08", to: "2026-03-08" };
    const result = await listRowChangeWindow(OPS, query);
    if (!result.ok) throw new Error("expected_access");
    expect(result.rows.map(row => row.rowPk)).toEqual(["AWIN-SYN-last", "AWIN-SYN-middle", "AWIN-SYN-start"]);
    expect(result).toMatchObject({ loaded: 3, hasMore: false });
    expect(captured.sql).toHaveLength(1);
    expect(captured.sql[0].indexOf("AND at >=")).toBeLessThan(captured.sql[0].indexOf("LIMIT"));
    expect(captured.sql[0].indexOf("AND at <")).toBeLessThan(captured.sql[0].indexOf("LIMIT"));
    const actor = await listRowChangeWindow(OPS, { ...query, actor: OPS.email, op: "UPDATE" });
    if (!actor.ok) throw new Error("expected_access");
    expect(actor.rows.map(row => row.rowPk)).toEqual(["AWIN-SYN-middle"]);
    const until = await listRowChangeWindow(OPS, { table: TABLE, to: "2026-03-08" });
    if (!until.ok) throw new Error("expected_access");
    expect(until.rows).toHaveLength(4);
    const from = await listRowChangeWindow(OPS, { table: TABLE, from: "2026-09-17", restoreRows: 300 });
    if (!from.ok) throw new Error("expected_access");
    expect(from.rows).toHaveLength(205);
  });

  it("binds continuation to dates even when the first visible rows are identical", async () => {
    const first = await listRowChangeWindow(OPS, { table: TABLE });
    if (!first.ok) throw new Error("expected_access");
    expect(await listRowChangeWindow(OPS, { table: TABLE, from: "2026-09-17", to: "2026-09-17", loaded: 100, snapshot: first.snapshot }))
      .toEqual({ ok: false, reason: "changed" });
    const dated = await listRowChangeWindow(OPS, { table: TABLE, from: "2026-09-17", to: "2026-09-17" });
    if (!dated.ok) throw new Error("expected_access");
    expect(dated.rows).toEqual(first.rows);
    expect(dated.snapshot).not.toBe(first.snapshot);
    const next = await listRowChangeWindow(OPS, { table: TABLE, from: "2026-09-17", to: "2026-09-17", loaded: 100, snapshot: dated.snapshot });
    expect(next).toMatchObject({ ok: true, loaded: 200 });
    const restored = await listRowChangeWindow(OPS, { table: TABLE, from: "2026-09-17", to: "2026-09-17", restoreRows: 300 });
    expect(restored).toMatchObject({ ok: true, loaded: 205, hasMore: false });
    captured.sql = [];
    for (const dates of [{ from: "2026-02-30" }, { from: "2026-09-18", to: "2026-09-17" }]) {
      await expect(listRowChangeWindow(OPS, dates)).rejects.toThrow("invalid_audit_date_range");
    }
    expect(await listRowChangeWindow({ ...OPS, role: "ADVISOR" }, { from: "2026-02-30" }))
      .toEqual({ ok: false, reason: "forbidden" });
    expect(captured.sql).toHaveLength(0);
  });

  it("matches every legacy exact metadata field with NULL actors, empty filters and combinations, without MAX(id)", async () => {
    await owner.$executeRaw`INSERT INTO audit.row_change (db_role,schema_name,table_name,op,actor_email,row_pk,changed)
      VALUES ('app_rw','app',${TABLE},'INSERT',NULL,'AWIN-SYN-null','{}'),
             ('app_rw','app',${TABLE},'DELETE','other@example.invalid','AWIN-SYN-other','{}')`;
    for (const query of [{}, {table:TABLE},{op:"INSERT"},{actor:OPS.email},{table:TABLE,op:"UPDATE",actor:OPS.email},
      {table:"AWIN-ABSENT"},{table:TABLE,op:"DELETE",actor:OPS.email}]) {
      const legacy=await listRowChanges(OPS,query);
      if (!legacy.ok) throw new Error("expected_access");
      captured.sql=[];
      expect(await getRowChangeMetadata(OPS,query)).toEqual({ok:true,total:legacy.total,tables:legacy.tables,ops:legacy.ops,actors:legacy.actors});
      expect(captured.sql).toHaveLength(1);
      expect(captured.sql[0]).not.toMatch(/MAX\(id\)|last_id|snapshot/);
    }
    expect(await getRowChangeMetadata({...OPS,role:"ADMIN"},{table:TABLE})).toMatchObject({ok:true,total:207});
  });

  it("rebuilds a remembered 205-row range with one fresh query and no stale payload", async () => {
    const first = await listRowChangeWindow(OPS, { table: TABLE });
    if (!first.ok) throw new Error("expected_access");
    await owner.$executeRaw`UPDATE audit.row_change SET changed = '{"invented":"fresh on Back"}'::jsonb
      WHERE id = ${BigInt(first.rows[0].id)}`;
    captured.sql = [];
    const restored = await listRowChangeWindow(OPS, { table: TABLE, loaded: 0, snapshot: null, restoreRows: 300 });
    if (!restored.ok) throw new Error("expected_access");
    expect(restored).toMatchObject({ firstPage: 1, loaded: 205, hasMore: false });
    expect(restored.rows).toHaveLength(205);
    expect(restored.rows[0].changed).toEqual({ invented: "fresh on Back" });
    expect(restored.snapshot).not.toBe(first.snapshot);
    expect(captured.sql).toHaveLength(1);
    expect(captured.sql[0]).not.toContain("GROUP BY table_name");
  });

  it("restores at most 5,000 rows and retains a real next-window signal", async () => {
    await owner.$executeRaw`INSERT INTO audit.row_change (at, db_role, schema_name, table_name, op, row_pk, changed)
      SELECT '2026-09-17T12:00:00Z'::timestamptz + i * interval '1 second', 'app_rw', 'app', ${TABLE}, 'UPDATE',
        'AWIN-SYN-' || i, jsonb_build_object('invented', i) FROM generate_series(206, 5205) i`;
    captured.sql = [];
    const restored = await listRowChangeWindow(OPS, { table: TABLE, restoreRows: 5_000 });
    if (!restored.ok) throw new Error("expected_access");
    expect(restored).toMatchObject({ loaded: 5_000, hasMore: true });
    expect(restored.rows).toHaveLength(5_000);
    expect(new Set(restored.rows.map(row => row.id)).size).toBe(5_000);
    expect(captured.sql).toHaveLength(1);
  });

  it("rejects cross-filter snapshots, unbounded requests and denied roles before reads", async () => {
    const first = await listRowChangeWindow(OPS, { table: TABLE });
    if (!first.ok) throw new Error("expected_access");
    expect(await listRowChangeWindow(OPS, { table: TABLE, op: "UPDATE", loaded: 100, snapshot: first.snapshot }))
      .toEqual({ ok: false, reason: "changed" });
    captured.sql = [];
    for (const query of [{ loaded: 100 }, { pageSize: 150 }, { loaded: 5_000, snapshot: first.snapshot },
      { loaded: 99, snapshot: first.snapshot }, { page: 0 }, { snapshot: first.snapshot },
      { restoreRows: 0 }, { restoreRows: 5_001 }, { restoreRows: 150 }, { restoreRows: 100.5 },
      { restoreRows: 300, loaded: 100, snapshot: first.snapshot }, { restoreRows: 300, snapshot: first.snapshot }]) {
      await expect(listRowChangeWindow(OPS, query)).rejects.toThrow(/invalid_audit_window/);
    }
    for (const role of ["ADVISOR", "VIEWER", "CLIENT_SERVICE", "HEAD_OF_ADVISORY", "UNKNOWN"]) {
      expect(await listRowChangeWindow({ ...OPS, role })).toEqual({ ok: false, reason: "forbidden" });
      expect(await getRowChangeMetadata({ ...OPS, role })).toEqual({ ok: false, reason: "forbidden" });
    }
    expect(captured.sql).toHaveLength(0);
  });
});
