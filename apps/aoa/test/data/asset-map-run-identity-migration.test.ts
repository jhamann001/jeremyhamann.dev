import { existsSync, readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AVAILABILITY_VALUES,
  COVERAGE_VALUES,
  DECISION_STATES,
  RESOLUTION_OUTCOMES,
  REVIEW_STATES,
} from "@/lib/data/asset-map-run-identity/contract";
import {
  connectSyntheticDatabase,
  disconnectSyntheticDatabase,
  integrationDescribe,
  type SyntheticDatabase,
} from "../asset-map-run-identity/fixtures";

const MIGRATIONS = new URL("../../prisma/migrations/", import.meta.url);
const NAME = "20260930120000_asset_map_run_identity";
const MIGRATION = new URL(`${NAME}/migration.sql`, MIGRATIONS);
const TABLES = ["acat_asset_map_run_identity", "acat_asset_map_run_person", "acat_asset_map_run_identity_history"] as const;
const sql = () => readFileSync(MIGRATION, "utf8");

/** Collect the literal set from `<column> ... IN ('a','b')` checks for one column. */
function checkedValues(text: string, column: string): string[][] {
  const pattern = new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`, "g");
  return [...text.matchAll(pattern)].map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((v) => v[1]));
}

describe("asset-map run identity migration text", () => {
  it("exists at the reserved timestamp, alone", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    const same = readdirSync(MIGRATIONS).filter((d) => d.startsWith("20260930120000"));
    expect(same).toEqual([NAME]);
  });

  it("uses exactly the frozen contract enums in its checks", () => {
    const text = sql();
    for (const [column, values] of [
      ["decision_state", DECISION_STATES],
      ["coverage", COVERAGE_VALUES],
      ["review_state", REVIEW_STATES],
      ["last_observed_availability", AVAILABILITY_VALUES],
      ["resolution_outcome", RESOLUTION_OUTCOMES],
    ] as const) {
      const found = checkedValues(text, column);
      expect(found.length, column).toBeGreaterThan(0);
      for (const set of found) expect(set, column).toEqual([...values]);
    }
  });

  it("does not reuse its enum spellings with different meanings in earlier migrations", () => {
    const earlier = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d) && d !== NAME);
    for (const dir of earlier) {
      const path = new URL(`${dir}/migration.sql`, MIGRATIONS);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      expect(text, dir).not.toMatch(/acat_asset_map_run_(identity|person)/);
      expect(text, dir).not.toMatch(/resolve_asset_map_run_people/);
    }
  });

  it("is additive and never widens runtime or registry access", () => {
    const text = sql().replace(/--[^\n]*/g, "");
    expect(text).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|COLUMN|FUNCTION|POLICY)\b/i);
    expect(text).not.toMatch(/\bALTER\s+TABLE\s+(app|mirror)\.(?!acat_asset_map_run_)/i);
    expect(text).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(text).not.toMatch(/\bUPDATE\s+(app|mirror)\./i);
    expect(text).not.toMatch(/\bTO\s+(PUBLIC|app_rw)\b/i);
    expect(text).not.toMatch(/\bGRANT\b[^;]*\bON\s+(TABLE\s+)?app\.crm_/i);
    expect(text).not.toMatch(/\bEXECUTE\s+format\b|\bEXECUTE\s+'/i);
    expect(text).not.toMatch(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\s+app\.resolve_crm_/i);
    expect(text).toMatch(/REVOKE ALL ON[^;]*acat_asset_map_run_identity_history[^;]*FROM PUBLIC, app_rw, ingest_rw/);
  });
});

type PrivilegeRow = { grantee: string; table_name: string; privilege_type: string };

integrationDescribe("asset-map run identity catalog under the dedicated database", () => {
  let db: SyntheticDatabase | undefined;

  beforeAll(async () => { db = await connectSyntheticDatabase(); });
  afterAll(async () => { await disconnectSyntheticDatabase(db); });

  it("records the migration as applied", async () => {
    const rows = await db!.fixture.$queryRaw<Array<{ ok: boolean }>>`
      SELECT finished_at IS NOT NULL AND rolled_back_at IS NULL AS ok
        FROM app._prisma_migrations WHERE migration_name = ${NAME}`;
    expect(rows).toEqual([{ ok: true }]);
  });

  it("enables and forces RLS on each new table owned by the non-superuser owner", async () => {
    const rows = await db!.fixture.$queryRaw<Array<{ relname: string; rls: boolean; forced: boolean; owner: string }>>`
      SELECT c.relname::text, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             pg_catalog.pg_get_userbyid(c.relowner)::text AS owner
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'mirror' AND c.relname = ANY(${[...TABLES]}::text[]) ORDER BY 1`;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ rls: true, forced: true, owner: db!.ownerRole });
  });

  it("grants ingest exactly the documented privileges and nothing to app_rw or PUBLIC", async () => {
    const rows = await db!.fixture.$queryRaw<PrivilegeRow[]>`
      SELECT grantee::text, table_name::text, privilege_type::text
        FROM information_schema.role_table_grants
       WHERE table_schema = 'mirror' AND table_name = ANY(${[...TABLES]}::text[])
         AND grantee <> ${db!.ownerRole} ORDER BY 1, 2, 3`;
    const byTable = (table: string) => rows.filter((r) => r.table_name === table).map((r) => `${r.grantee}:${r.privilege_type}`);
    expect(byTable("acat_asset_map_run_identity")).toEqual(["ingest_rw:INSERT", "ingest_rw:SELECT", "ingest_rw:UPDATE"]);
    expect(byTable("acat_asset_map_run_person")).toEqual(["ingest_rw:INSERT", "ingest_rw:SELECT", "ingest_rw:UPDATE"]);
    expect(byTable("acat_asset_map_run_identity_history")).toEqual(["ingest_rw:INSERT", "ingest_rw:SELECT"]);
  });

  it("defines a pinned, definer-rights resolver executable only by ingest_rw", async () => {
    const [fn] = await db!.fixture.$queryRaw<Array<{ definer: boolean; config: string[]; owner: string; volatility: string }>>`
      SELECT p.prosecdef AS definer, p.proconfig AS config, pg_catalog.pg_get_userbyid(p.proowner)::text AS owner,
             p.provolatile::text AS volatility
        FROM pg_catalog.pg_proc p WHERE p.oid = 'app.resolve_asset_map_run_people(text[])'::regprocedure`;
    expect(fn).toMatchObject({ definer: true, owner: db!.ownerRole, volatility: "s" });
    expect(fn.config).toEqual(["search_path=pg_catalog, pg_temp"]);
    const [privs] = await db!.fixture.$queryRaw<Array<{ ingest: boolean; app: boolean; reconciler: boolean; public: boolean }>>`
      SELECT has_function_privilege('ingest_rw', 'app.resolve_asset_map_run_people(text[])', 'EXECUTE') AS ingest,
             has_function_privilege('app_rw', 'app.resolve_asset_map_run_people(text[])', 'EXECUTE') AS app,
             has_function_privilege('identity_reconciler', 'app.resolve_asset_map_run_people(text[])', 'EXECUTE') AS reconciler,
             EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      WHERE p.oid = 'app.resolve_asset_map_run_people(text[])'::regprocedure
                        AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public`;
    expect(privs).toEqual({ ingest: true, app: false, reconciler: false, public: false });
  });

  it("persists only the frozen enum spellings in live constraints", async () => {
    const rows = await db!.fixture.$queryRaw<Array<{ def: string }>>`
      SELECT pg_catalog.pg_get_constraintdef(con.oid) AS def
        FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       WHERE c.relname = ANY(${[...TABLES]}::text[]) AND con.contype = 'c'`;
    const text = rows.map((r) => r.def).join("\n");
    const literals = (column: string) => [...text.matchAll(new RegExp(`\\(${column} = ANY \\(ARRAY\\[([^\\]]*)\\]`, "g"))]
      .map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((v) => v[1]));
    for (const [column, values] of [
      ["decision_state", DECISION_STATES],
      ["coverage", COVERAGE_VALUES],
      ["review_state", REVIEW_STATES],
      ["last_observed_availability", AVAILABILITY_VALUES],
      ["resolution_outcome", RESOLUTION_OUTCOMES],
    ] as const) {
      const found = literals(column);
      expect(found.length, column).toBeGreaterThan(0);
      for (const set of found) expect(set, column).toEqual([...values]);
    }
  });

  it("keeps history append-only with no update or delete privilege", async () => {
    const [row] = await db!.fixture.$queryRaw<Array<{ upd: boolean; del: boolean; app_sel: boolean }>>`
      SELECT has_table_privilege('ingest_rw', 'mirror.acat_asset_map_run_identity_history', 'UPDATE') AS upd,
             has_table_privilege('ingest_rw', 'mirror.acat_asset_map_run_identity_history', 'DELETE') AS del,
             has_table_privilege('app_rw', 'mirror.acat_asset_map_run_identity_history', 'SELECT') AS app_sel`;
    expect(row).toEqual({ upd: false, del: false, app_sel: false });
  });
});
