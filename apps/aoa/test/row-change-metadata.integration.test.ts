import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { listRowChanges, type RowChangeQuery } from "@/lib/data/row-changes";
import { withUserScope } from "@/lib/rls";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "audit-metadata@example.invalid" };
const tableA = "ADM-SYN-A", tableB = "ADM-SYN-B";
const actorA = "adm-a@example.invalid", actorB = "adm-b@example.invalid";

gated("Field change metadata matches the previous exact read contract", () => {
  let owner: PrismaClient;
  const cleanup = () => owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE 'ADM-SYN-%'`;
  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw || !process.env.DATABASE_URL) throw new Error("explicit_synthetic_database_required");
    const target = new URL(raw);
    for (const [value, username] of [[raw, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      const url = new URL(value!);
      if (!["postgresql:", "postgres:"].includes(url.protocol)
        || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || !["5432", "55444"].includes(url.port) || url.username !== username
        || !(["/aoa_pagination_synthetic", "/aoa_directory_timeouts_synthetic"].includes(url.pathname)
          || (process.env.CI === "true" && url.pathname === "/aoa"))
        || url.host !== target.host || url.pathname !== target.pathname
        || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
        || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
        throw new Error("isolated_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: raw });
    await cleanup();
    await owner.$executeRaw`
      INSERT INTO audit.row_change (at, actor_email, actor_role, db_role, schema_name, table_name, op, row_pk, changed)
      SELECT '2026-09-17'::timestamptz,
        CASE (i / 6) % 3 WHEN 0 THEN NULL WHEN 1 THEN ${actorA} ELSE ${actorB} END,
        'OPERATIONS', 'app_rw', 'app', CASE i % 2 WHEN 0 THEN ${tableA} ELSE ${tableB} END,
        CASE (i / 2) % 3 WHEN 0 THEN 'INSERT' WHEN 1 THEN 'UPDATE' ELSE 'DELETE' END,
        'ADM-SYN-' || i, '{"invented":true}'::jsonb
      FROM generate_series(0, 359) i`;
  });
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });

  async function previousMetadata(query: RowChangeQuery) {
    const table = query.table || null, op = query.op || null, actor = query.actor || null;
    const where = Prisma.sql`WHERE (${table}::text IS NULL OR table_name = ${table})
      AND (${op}::text IS NULL OR op = ${op}) AND (${actor}::text IS NULL OR actor_email = ${actor})`;
    return withUserScope(OPS, async tx => {
      const [{ total, watermark }] = await tx.$queryRaw<{ total: bigint; watermark: string }[]>(Prisma.sql`
        SELECT COUNT(*) AS total, md5(COUNT(*)::text || ':' || COALESCE(MAX(id)::text, '')) AS watermark
        FROM audit.row_change ${where}`);
      const tables = await tx.$queryRaw<{ table_name: string }[]>`SELECT DISTINCT table_name FROM audit.row_change ORDER BY table_name`;
      const ops = await tx.$queryRaw<{ op: string }[]>`SELECT DISTINCT op FROM audit.row_change ORDER BY op`;
      const actors = await tx.$queryRaw<{ actor_email: string }[]>`SELECT DISTINCT actor_email FROM audit.row_change WHERE actor_email IS NOT NULL ORDER BY actor_email`;
      const ids = await tx.$queryRaw<{ id: bigint }[]>(Prisma.sql`SELECT id FROM audit.row_change ${where}
        ORDER BY at DESC, id DESC LIMIT 100 OFFSET ${((query.page ?? 1) - 1) * 100}`);
      return { total: Number(total), snapshot: createHash("sha256").update(watermark).update(JSON.stringify([tables, ops, actors])).digest("hex"),
        tables: tables.map(row => row.table_name), ops: ops.map(row => row.op), actors: actors.map(row => row.actor_email), ids: ids.map(row => String(row.id)) };
    }, { isolationLevel: "RepeatableRead" });
  }

  it("preserves exact totals, full vocabularies, snapshot bytes and ordered pages across all filter combinations", async () => {
    for (const table of [undefined, tableA, tableB, "ADM-SYN-absent"]) {
      for (const op of [undefined, "INSERT", "UPDATE", "DELETE"]) {
        for (const actor of [undefined, actorA, actorB, "absent@example.invalid"]) {
          const query = { table, op, actor, pageSize: 100 };
          const expected = await previousMetadata(query);
          const actual = await listRowChanges(OPS, query);
          if (!actual.ok) throw new Error("expected_audit_access");
          expect(actual).toMatchObject({ total: expected.total, snapshot: expected.snapshot,
            tables: expected.tables, ops: expected.ops, actors: expected.actors });
          expect(actual.rows.map(row => row.id)).toEqual(expected.ids);
        }
      }
    }
    const query = { table: tableA, page: 2, pageSize: 100 };
    const actual = await listRowChanges(OPS, query), expected = await previousMetadata(query);
    if (!actual.ok) throw new Error("expected_audit_access");
    expect(actual.rows.map(row => row.id)).toEqual(expected.ids);
    expect(actual.pageCount).toBe(2);
  }, 15_000);

  it("invalidates new vocabulary outside the active filter and retains vocabulary for an empty filter", async () => {
    const before = await listRowChanges(OPS, { table: tableA });
    await owner.$executeRaw`INSERT INTO audit.row_change (db_role, schema_name, table_name, op, row_pk, changed, actor_email)
      VALUES ('app_rw', 'app', 'ADM-SYN-Z', 'UPDATE', 'ADM-SYN-vocabulary', '{}', 'adm-new@example.invalid')`;
    const after = await listRowChanges(OPS, { table: tableA });
    const empty = await listRowChanges(OPS, { table: "ADM-SYN-absent" });
    if (!before.ok || !after.ok || !empty.ok) throw new Error("expected_audit_access");
    expect(after.total).toBe(before.total);
    expect(after.snapshot).not.toBe(before.snapshot);
    expect(after.tables).toContain("ADM-SYN-Z");
    expect(empty.tables).toEqual(after.tables);
    expect(empty.actors).toEqual(after.actors);
    expect(empty.total).toBe(0);
    expect(empty.rows).toEqual([]);
  });

  it("detects a lower ID committed after a higher ID, even when MAX(id) is unchanged", async () => {
    const [{ id: delayed }] = await owner.$queryRaw<{ id: bigint }[]>`SELECT nextval('audit.row_change_id_seq') AS id`;
    const insert = (id: bigint) => owner.$executeRaw`INSERT INTO audit.row_change (id, db_role, schema_name, table_name, op, row_pk, changed)
      VALUES (${id}, 'app_rw', 'app', ${tableA}, 'UPDATE', 'ADM-SYN-late-' || ${id}::text, '{}')`;
    const [{ id: newer }] = await owner.$queryRaw<{ id: bigint }[]>`SELECT nextval('audit.row_change_id_seq') AS id`;
    await insert(newer);
    const before = await listRowChanges(OPS, { table: tableA });
    await insert(delayed);
    const after = await listRowChanges(OPS, { table: tableA });
    if (!before.ok || !after.ok) throw new Error("expected_audit_access");
    expect(after.total).toBe(before.total + 1);
    expect(after.snapshot).not.toBe(before.snapshot);
    expect(after.snapshot).toBe((await previousMetadata({ table: tableA })).snapshot);
    expect(await listRowChanges({ ...OPS, role: "ADVISOR" })).toEqual({ ok: false, reason: "forbidden" });
  });
});
