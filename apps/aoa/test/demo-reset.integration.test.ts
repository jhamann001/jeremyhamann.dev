// The demo's nightly reset (lib/demo/reset + the seed) on real PostgreSQL: it empties a seeded database back to what
// a fresh migration leaves, append-only tables included, and the seed then fills it to the same row counts as the
// first time. Also pins what the reset relies on, so a later migration can't quietly break it: the schemas holding
// tables, the rows the migrations insert, no trigger on TRUNCATE, no TRUNCATE grant to a login the demo signs in with
// (statement_pipeline_rw may empty its roster table, as in production, but has no password in the demo), and no
// write grant at all on the tables the reset keeps.
// Opt-in: DEMO_SEED_TEST_OWNER_URL is the owner login of a freshly migrated loopback database. It seeds and resets
// that database, so point it at a throwaway copy.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));

const OWNER_URL = process.env.DEMO_SEED_TEST_OWNER_URL;
const RUN = OWNER_URL ? describe : describe.skip;

const DEMO_CONFIG = JSON.parse(readFileSync(new URL("../demo-config.json", import.meta.url), "utf8")) as Record<string, string>;
const LOGIN_KEYS = ["DATABASE_URL", "INGEST_DATABASE_URL", "CRM_RECONCILER_DATABASE_URL"];
const savedEnv: Record<string, string | undefined> = {};

function loopback(raw: string): string {
  const url = new URL(raw);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username !== "aoa") throw new Error("loopback_demo_reset_database_required");
  return raw;
}

type Counts = Record<string, number>;

RUN("demo reset: back to a fresh migration, then the same seed", () => {
  let owner: PrismaClient;
  let ingest: PrismaClient;
  let schemas: readonly string[];
  let baselineTables: readonly string[];
  let keptTables: readonly string[];
  let loginRoles: readonly string[];
  let clear: (db: PrismaClient) => Promise<{ tables: number }>;
  let migrationProblems: (db: PrismaClient) => Promise<string[]>;
  let loginProblems: (db: PrismaClient) => Promise<string[]>;
  let seed: () => Promise<unknown>;
  let migratedRows: Record<string, unknown[]>;
  let seededCounts: Counts;
  let seededUsers: Array<{ id: string; email: string | null }>;

  const users = () =>
    owner.$queryRaw<Array<{ id: string; email: string | null }>>`SELECT id, email FROM app."User" ORDER BY email`;

  // Every table in the reset's schemas but Prisma's history, with its row count.
  async function counts(): Promise<Counts> {
    const tables = await owner.$queryRaw<Array<{ name: string }>>`
      SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
       WHERE schemaname = ANY(${[...schemas]}::text[]) AND format('%I.%I', schemaname, tablename) <> 'app._prisma_migrations'
       ORDER BY 1`;
    const result: Counts = {};
    for (const { name } of tables) {
      const [{ n }] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM ${name}`);
      result[name] = Number(n);
    }
    return result;
  }

  // A table's rows without their time columns (a migration or a reset stamps those with the time it ran).
  async function rowsWithoutTimes(table: string): Promise<unknown[]> {
    const [schema, name] = table.split(".");
    const timeColumns = await owner.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = ${schema} AND table_name = ${name} AND data_type LIKE 'timestamp%'`;
    const drop = timeColumns.map((c) => ` - '${c.column_name}'`).join("");
    const rows = await owner.$queryRawUnsafe<Array<{ row: unknown }>>(`SELECT to_jsonb(t)${drop} AS row FROM ${table} t ORDER BY 1`);
    return rows.map((r) => r.row);
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries(DEMO_CONFIG)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    const { DEMO_LOGIN_ROLES, demoLoginProblems, demoLoginUrls, ensureDemoLogins } = await import("@/lib/demo/logins");
    loginRoles = DEMO_LOGIN_ROLES;
    loginProblems = demoLoginProblems;
    const logins = demoLoginUrls(loopback(OWNER_URL!));
    for (const key of LOGIN_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = logins[key as keyof typeof logins];
    }
    owner = new PrismaClient({ datasourceUrl: OWNER_URL });
    ingest = new PrismaClient({ datasourceUrl: logins.INGEST_DATABASE_URL });
    const [{ held }] = await owner.$queryRaw<Array<{ held: bigint }>>`SELECT count(*) AS held FROM app.transfer`;
    if (held > 0n) throw new Error("DEMO_SEED_TEST_OWNER_URL must be a freshly migrated database");
    await ensureDemoLogins(owner, OWNER_URL!);

    const reset = await import("@/lib/demo/reset");
    schemas = reset.DEMO_RESET_SCHEMAS;
    baselineTables = reset.DEMO_RESET_BASELINE.map((row) => row.table);
    keptTables = reset.DEMO_RESET_KEPT.filter((t) => t !== "app._prisma_migrations");
    clear = reset.clearDemoDatabase;
    migrationProblems = (db) => reset.demoMigrationProblems(db, join(import.meta.dirname, "..", "prisma", "migrations"));
    const { seedDemo } = await import("@/lib/demo/seed");
    const { loadUniverse } = await import("@/lib/demo/seed/universe");
    seed = () => seedDemo(loadUniverse(), owner, ingest);
  }, 60_000);

  afterAll(async () => {
    await owner?.$disconnect();
    await ingest?.$disconnect();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("finds tables only in the reset's schemas", async () => {
    const rows = await owner.$queryRaw<Array<{ schema: string }>>`
      SELECT DISTINCT schemaname AS schema FROM pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`;
    expect(rows.map((r) => r.schema)).toEqual([...schemas].sort());
  });

  it("passes the checks a reset runs before it empties anything: this checkout's migrations, and the logins", async () => {
    expect(await migrationProblems(owner)).toEqual([]);
    expect(await loginProblems(owner)).toEqual([]);
  });

  it("finds rows after a fresh migration only in the tables the reset puts back or keeps", async () => {
    const filled = Object.entries(await counts()).filter(([, n]) => n > 0);
    expect(filled).toEqual([
      ["app.account_close_date_override", 1],
      ["app.custodian_authority_state", 1],
      ["mirror.advisor", 1],
      ["trade_request.serving_state", 1],
    ]);
    expect([...baselineTables, "trade_request.serving_state"].sort()).toEqual(filled.map(([t]) => t));
    migratedRows = Object.fromEntries(
      await Promise.all(baselineTables.map(async (t) => [t, await rowsWithoutTimes(t)] as const)),
    );
  });

  it("relies on no trigger refusing TRUNCATE, and no login the demo signs in with holding it", async () => {
    const [{ triggers }] = await owner.$queryRaw<Array<{ triggers: bigint }>>`
      SELECT count(*) AS triggers FROM pg_trigger WHERE NOT tgisinternal AND (tgtype & 32) <> 0`;
    expect(triggers).toBe(0n);
    const granted = await owner.$queryRaw<Array<{ login: string; name: string }>>`
      SELECT r.rolname AS login, format('%I.%I', t.schemaname, t.tablename) AS name
        FROM pg_tables t CROSS JOIN pg_roles r
       WHERE t.schemaname = ANY(${[...schemas]}::text[])
         AND r.rolname = ANY(${[...loginRoles]}::text[])
         AND has_table_privilege(r.oid, format('%I.%I', t.schemaname, t.tablename), 'TRUNCATE')`;
    expect(granted).toEqual([]);
  });

  it("keeps only tables no login the demo signs in with may write", async () => {
    const writable = await owner.$queryRaw<Array<{ login: string; name: string }>>`
      SELECT r.rolname AS login, k.name
        FROM unnest(${[...keptTables]}::text[]) AS k(name) CROSS JOIN pg_roles r
       WHERE r.rolname = ANY(${[...loginRoles]}::text[])
         AND has_table_privilege(r.oid, k.name, 'INSERT, UPDATE, DELETE, TRUNCATE')`;
    expect(writable).toEqual([]);
  });

  it("seeds the demo", async () => {
    await seed();
    seededCounts = await counts();
    seededUsers = await users();
    expect(seededUsers.length).toBeGreaterThan(0);
    expect(seededCounts["app.transfer"]).toBeGreaterThan(0);
    expect(seededCounts["audit.row_change"]).toBeGreaterThan(0);
    expect(seededCounts["demo.stand_in_record"]).toBeGreaterThan(0);
  }, 120_000);

  it("seeds the stand-ins well below the ceilings visitors are held to", async () => {
    // The store's per-kind cap (lib/demo/stand-ins/store.ts) and the table's ceiling (demo.stand_in_record_bounds):
    // the seed must leave visitors most of the room, or the nightly reset itself would start refusing.
    const { STAND_IN_KIND_CAP } = await import("@/lib/demo/stand-ins/store");
    const kinds = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM demo.stand_in_record GROUP BY service, kind`;
    const [{ rows, bytes }] = await owner.$queryRaw<Array<{ rows: bigint; bytes: bigint }>>`
      SELECT count(*) AS rows, sum(pg_column_size(doc)) AS bytes FROM demo.stand_in_record`;
    expect(Math.max(...kinds.map((k) => Number(k.n)))).toBeLessThan(STAND_IN_KIND_CAP / 2);
    expect(Number(rows)).toBeLessThan(4000 / 2);
    expect(Number(bytes)).toBeLessThan((16 * 1024 * 1024) / 4);
  });

  it("empties the seeded database back to what the migrations left, append-only tables and sequences included", async () => {
    const triggersBefore = await owner.$queryRaw<Array<{ name: string; enabled: string }>>`
      SELECT tgname AS name, tgenabled::text AS enabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`;
    const keptBefore = await Promise.all(keptTables.map((t) => owner.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM ${t} t ORDER BY 1`)));
    const { tables } = await clear(owner);
    expect(tables).toBe(Object.keys(seededCounts).length - keptTables.length);

    const filled = Object.entries(await counts()).filter(([, n]) => n > 0).map(([t]) => t);
    const keptFilled = keptTables.filter((t) => seededCounts[t] > 0);
    expect(filled).toEqual([...baselineTables, ...keptFilled].sort());
    for (const table of baselineTables) expect(await rowsWithoutTimes(table)).toEqual(migratedRows[table]);
    const keptAfter = await Promise.all(keptTables.map((t) => owner.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM ${t} t ORDER BY 1`)));
    expect(keptAfter).toEqual(keptBefore);

    const used = await owner.$queryRaw<Array<{ name: string }>>`
      SELECT format('%I.%I', schemaname, sequencename) AS name FROM pg_sequences
       WHERE schemaname = ANY(${[...schemas]}::text[]) AND last_value IS NOT NULL`;
    expect(used).toEqual([]);
    const triggersAfter = await owner.$queryRaw<Array<{ name: string; enabled: string }>>`
      SELECT tgname AS name, tgenabled::text AS enabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`;
    expect(triggersAfter).toEqual(triggersBefore);
  }, 60_000);

  it("seeds it again to the same row counts as the first time", async () => {
    await seed();
    expect(await counts()).toEqual(seededCounts);
  }, 120_000);

  it("gives every sign-in user the same id again, so a visitor signed in across the reset is still themselves", async () => {
    expect(await users()).toEqual(seededUsers);
  });
});
