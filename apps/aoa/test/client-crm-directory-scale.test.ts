import { execFileSync } from "node:child_process";
import { Script } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { Prisma, PrismaClient } from "@prisma/client";

vi.mock("server-only", () => ({}));
const captured = vi.hoisted(() => ({ queries: [] as Array<{ sql: unknown; ms: number }> }));
vi.mock("@/lib/rls", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/rls")>();
  const { Prisma: Sql } = await import("@prisma/client");
  return { ...original, withUserScope: (identity: Parameters<typeof original.withUserScope>[0],
    fn: (tx: Prisma.TransactionClient) => unknown, options: Parameters<typeof original.withUserScope>[2]) =>
    original.withUserScope(identity, async tx => fn(new Proxy(tx, {
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
import { getClientDirectory } from "@/lib/data/clients";
import { listCrmIdentities } from "@/lib/data/crm-explorer";
import * as scopedReads from "@/lib/rls";
import * as flags from "@/lib/flags";
import * as visibility from "@/lib/crm/visibility";
import * as parentResolution from "@/lib/data/crm-parent-resolution";
import * as clientFieldAuthz from "@/lib/data/client-field-authz";
import * as crmResolve from "@/lib/crm/resolve";
import * as structuredLog from "@/lib/observability/structured-log";

// Explicit opt-in, one disposable loopback database, invented records only.
// This compares the actual committed baseline SQL, not a hand-written analogue.
// A timeout is evidence and is reported; it must not stop the remaining plans.
const benchmark = process.env.CLIENT_CRM_DIRECTORY_SCALE_BENCHMARK === "1" ? describe : describe.skip;
const BASELINE_REF = "5b690beb";
const OPS = { role: "OPERATIONS", email: "directory-scale@example.invalid" };
const CLIENTS = 50_000;
const EMPLOYEES = 40;
const FILTERS = { query: "", stage: "all" as const, sortKey: "name" as const, sortDir: "asc" as const };

function baselineModule<T>(file: string): T {
  const source = execFileSync("git", ["show", `${BASELINE_REF}:${file}`], { encoding: "utf8" });
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  const dependencies: Record<string, unknown> = {
    "server-only": {}, "@prisma/client": { Prisma }, "@/lib/rls": scopedReads,
    "@/lib/flags": flags, "@/lib/crm/visibility": visibility,
    "@/lib/data/crm-parent-resolution": parentResolution, "./client-field-authz": clientFieldAuthz,
    "@/lib/crm/resolve": crmResolve, "@/lib/observability/structured-log": structuredLog,
  };
  const exports = {};
  new Script(compiled, { filename: `baseline/${file}` }).runInNewContext({
    exports, process, console, performance, Date,
    require: (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected baseline dependency: ${name}`);
      return dependencies[name];
    },
  });
  return exports as T;
}

function queryKind(query: Prisma.Sql): string {
  if (query.sql.includes("WITH visible_client")) return "client_directory";
  if (query.sql.includes("WITH page_rows")) return "crm_ordered_page";
  if (query.sql.includes("display_name")) return "crm_page_mappings";
  if (query.sql.includes("snapshot")) return "crm_content_version";
  if (query.sql.includes("potential_duplicates")) return "crm_fresh_stats";
  return "crm_other";
}

function safeError(error: unknown): Record<string, unknown> {
  const value = error as { name?: string; code?: string; meta?: { code?: string } };
  return { name: value?.name ?? "unknown", code: value?.code ?? null, sqlState: value?.meta?.code ?? null };
}

benchmark("Client/CRM directory reads at source-backed synthetic scale", () => {
  let owner: PrismaClient;
  async function cleanup() {
    await owner.$executeRaw`DELETE FROM app.employee_client_status WHERE source_upload_id = 'dirscale-upload'`;
    await owner.$executeRaw`DELETE FROM app.employee_contact_mapping WHERE id LIKE 'dirscale-employee-%'`;
    await owner.$executeRaw`DELETE FROM app.employee_roster_entry WHERE upload_id = 'dirscale-upload'`;
    await owner.$executeRaw`DELETE FROM app.employee_roster_upload WHERE id = 'dirscale-upload'`;
    await owner.$executeRaw`DELETE FROM app.crm_source_mapping WHERE id LIKE 'dirscale-map-%'`;
    await owner.$executeRaw`DELETE FROM app.crm_identity WHERE id LIKE 'hld_dirscale%' OR id LIKE 'con_dirscale%'`;
    await owner.$executeRaw`DELETE FROM mirror.client WHERE sf_id LIKE '003DSC%'`;
    await owner.$executeRaw`DELETE FROM mirror.household WHERE sf_id LIKE '001DSC%'`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE
      (table_name = 'crm_identity' AND (row_pk LIKE 'hld_dirscale%' OR row_pk LIKE 'con_dirscale%')) OR
      (table_name = 'crm_source_mapping' AND row_pk LIKE 'dirscale-map-%') OR
      (table_name IN ('employee_roster_upload', 'employee_roster_entry', 'employee_contact_mapping', 'employee_client_status')
        AND (row_pk LIKE 'dirscale-%' OR row_pk LIKE '003DSC%')) OR
      (table_name IN ('client', 'household') AND (row_pk LIKE '003DSC%' OR row_pk LIKE '001DSC%'))`;
  }

  beforeAll(async () => {
    const ownerUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!ownerUrl || !process.env.DATABASE_URL) throw new Error("explicit_synthetic_database_required");
    for (const [value, username] of [[ownerUrl, "aoa"], [process.env.DATABASE_URL, "app_rw"]]) {
      const url = new URL(value!);
      if (!["postgresql:", "postgres:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || url.port !== "55444"
        || url.pathname !== "/aoa_directory_scale_synthetic" || url.username !== username
        || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
        || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
        throw new Error("isolated_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    await cleanup();
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
      SELECT '001DSC' || lpad(i::text, 9, '0') || 'AAA', 'Invented Directory Household ' || lpad(i::text, 5, '0'),
        CASE i % 4 WHEN 0 THEN 'Client' WHEN 1 THEN 'Prospect' WHEN 2 THEN 'Lost Client' ELSE 'Lost Prospect' END, ${OPS.email}
      FROM generate_series(1, ${CLIENTS}) i`;
    await owner.$executeRaw`INSERT INTO mirror.client (sf_id, first_name, last_name, household_id, lead_advisor_email)
      SELECT '003DSC' || lpad(i::text, 9, '0') || 'AAA', 'Invented Directory', lpad(i::text, 5, '0'),
        '001DSC' || lpad(i::text, 9, '0') || 'AAA', ${OPS.email} FROM generate_series(1, ${CLIENTS}) i`;
    await owner.$executeRaw`INSERT INTO app.crm_identity (id, identity_type, updated_at)
      SELECT 'hld_dirscale' || lpad(i::text, 8, '0'), 'HOUSEHOLD', '2026-01-01T00:00:00Z'::timestamptz FROM generate_series(1, ${CLIENTS}) i
      UNION ALL SELECT 'con_dirscale' || lpad(i::text, 8, '0'), 'CONTACT', '2026-01-01T00:00:00Z'::timestamptz FROM generate_series(1, ${CLIENTS}) i`;
    await owner.$executeRaw`INSERT INTO app.crm_source_mapping (id, identity_id, source_system, source_namespace, source_key, updated_at)
      SELECT 'dirscale-map-h-' || i, 'hld_dirscale' || lpad(i::text, 8, '0'), 'CRM', 'household',
        '001DSC' || lpad(i::text, 9, '0') || 'AAA', now() FROM generate_series(1, ${CLIENTS}) i
      UNION ALL SELECT 'dirscale-map-c-' || i, 'con_dirscale' || lpad(i::text, 8, '0'), 'CRM', 'contact',
        '003DSC' || lpad(i::text, 9, '0') || 'AAA', now() FROM generate_series(1, ${CLIENTS}) i`;
    await owner.$executeRaw`INSERT INTO app.employee_roster_upload
      (id, file_sha256, effective_date, parser_version, status, row_count, employee_count, dependent_row_count,
       active_count, former_count, uploaded_by, updated_at)
      VALUES ('dirscale-upload', repeat('d',64), '2026-01-01', 'synthetic-directory-v1', 'DRAFT', ${EMPLOYEES}, ${EMPLOYEES}, 0,
       ${EMPLOYEES / 2}, ${EMPLOYEES / 2}, ${OPS.email}, now())`;
    await owner.$executeRaw`INSERT INTO app.employee_contact_mapping
      (id, employee_id, contact_identity_id, client_sf_id, state, evidence, reviewed_by, updated_at)
      SELECT 'dirscale-employee-' || i, 'dirscale-employee-' || i, 'con_dirscale' || lpad(i::text, 8, '0'),
        '003DSC' || lpad(i::text, 9, '0') || 'AAA', 'CONFIRMED', 'EXACT_NAME', ${OPS.email}, now()
      FROM generate_series(1, ${EMPLOYEES}) i`;
    await owner.$executeRaw`INSERT INTO app.employee_client_status
      (client_sf_id, employment_state, effective_date, source_upload_id, updated_at)
      SELECT '003DSC' || lpad(i::text, 9, '0') || 'AAA',
        (CASE i % 2 WHEN 0 THEN 'ACTIVE' ELSE 'FORMER' END)::app."EmployeeEmploymentState",
        '2026-01-01', 'dirscale-upload', now() FROM generate_series(1, ${EMPLOYEES}) i`;
    for (const table of [Prisma.sql`mirror.client`, Prisma.sql`mirror.household`, Prisma.sql`app.crm_identity`,
      Prisma.sql`app.crm_source_mapping`, Prisma.sql`app.employee_contact_mapping`, Prisma.sql`app.employee_client_status`]) {
      await owner.$executeRaw(Prisma.sql`ANALYZE ${table}`);
    }
  }, 180_000);

  afterAll(async () => {
    if (owner) { await cleanup(); await owner.$disconnect(); }
    vi.unstubAllEnvs();
  }, 180_000);

  it("compares first/continuation pages and actual RLS query plans without changing application budgets", async () => {
    const baselineClients = baselineModule<typeof import("@/lib/data/clients")>("lib/data/clients.ts");
    const baselineCrm = baselineModule<typeof import("@/lib/data/crm-explorer")>("lib/data/crm-explorer.ts");
    const [databaseSettings] = await scopedReads.withUserScope(OPS, tx => tx.$queryRaw<Array<{
      version: string; jit: string; jit_available: boolean; jit_above_cost: string;
    }>>`SELECT version(), current_setting('jit') AS jit, pg_jit_available() AS jit_available,
      current_setting('jit_above_cost') AS jit_above_cost`);
    const measurements: unknown[] = [];
    const queries = new Map<string, Prisma.Sql[]>();
    const successful = new Map<string, unknown>();
    for (const [surface, versions] of [
      ["clients", { before: (page: number) => baselineClients.getClientDirectory(OPS, FILTERS, page, 100),
        after: (page: number) => getClientDirectory(OPS, FILTERS, page, 100) }],
      ["crm", { before: (page: number) => baselineCrm.listCrmIdentities(OPS, { page }),
        after: (page: number) => listCrmIdentities(OPS, { page }) }],
    ] as const) {
      for (const page of [1, 2]) {
        for (const [version, read] of Object.entries(versions)) {
          captured.queries = [];
          const started = performance.now();
          let outcome: Record<string, unknown>;
          try {
            const result = await read(page);
            if ("ok" in result && !result.ok) throw new Error("unexpected_denied_read");
            expect(result.rows).toHaveLength(100);
            expect(result.total).toBe(surface === "clients" ? CLIENTS : CLIENTS * 2);
            successful.set(`${surface}:${version}:${page}`, result);
            outcome = { ok: true, total: result.total, page: result.page, snapshot: result.snapshot };
          } catch (error) {
            // Expected database timeout outcomes are measurements. A broken
            // count/result assertion or application exception still fails loudly.
            const failure = safeError(error);
            if (failure.code !== "P2028" && !(failure.code === "P2010" && failure.sqlState === "57014")) throw error;
            outcome = { ok: false, error: safeError(error) };
          }
          const records = captured.queries.filter(record => record.sql && typeof record.sql === "object" && "sql" in record.sql);
          queries.set(`${surface}:${version}`, records.map(record => record.sql as Prisma.Sql));
          const measurement = { surface, version, page, elapsedMs: Number((performance.now() - started).toFixed(2)), ...outcome,
            queries: records.map(record => ({ kind: queryKind(record.sql as Prisma.Sql), ms: record.ms })) };
          measurements.push(measurement);
          process.stdout.write(JSON.stringify({ event: "client_crm_directory_scale_page", ...measurement }) + "\n");
        }
        const before = successful.get(`${surface}:before:${page}`), after = successful.get(`${surface}:after:${page}`);
        if (before && after) expect(after).toEqual(before);
      }
      for (const version of ["before", "after"]) {
        const first = successful.get(`${surface}:${version}:1`) as { snapshot: string } | undefined;
        const next = successful.get(`${surface}:${version}:2`) as { snapshot: string } | undefined;
        if (first && next) expect(next.snapshot).toBe(first.snapshot);
      }
    }
    const plans: unknown[] = [];
    for (const [key, sqls] of queries) {
      for (const [index, sql] of sqls.entries()) {
        // Compare JIT only where the full-population query can plausibly trigger
        // compilation; all other phases retain the app's CRM JIT-off policy.
        const kind = queryKind(sql);
        for (const jit of kind === "client_directory" || kind === "crm_content_version" ? ["on", "off"] : ["off"]) {
          try {
            const raw = await scopedReads.withUserScope(OPS, async tx => {
              await tx.$executeRaw`SELECT set_config('jit', ${jit}, true)`;
              await tx.$executeRaw`SELECT set_config('statement_timeout', '45000', true)`;
              await tx.$executeRaw`SELECT set_config('lock_timeout', '2000', true)`;
              return tx.$queryRaw<Array<{ "QUERY PLAN": Array<Record<string, unknown>> }>>(
                Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
            }, { maxWait: 5_000, timeout: 60_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
            const plan = raw[0]["QUERY PLAN"][0];
            const tree = plan.Plan as Record<string, unknown>;
            const detail = { key, index, kind, jit, planningMs: plan["Planning Time"], executionMs: plan["Execution Time"],
              totalCost: tree["Total Cost"], compilation: plan.JIT ?? null, sharedHitBlocks: tree["Shared Hit Blocks"],
              sharedReadBlocks: tree["Shared Read Blocks"], tempWrittenBlocks: tree["Temp Written Blocks"] };
            plans.push(detail);
            process.stdout.write(JSON.stringify({ event: "client_crm_directory_scale_plan", ...detail }) + "\n");
          } catch (error) {
            const detail = { key, index, kind, jit, error: safeError(error) };
            plans.push(detail);
            process.stdout.write(JSON.stringify({ event: "client_crm_directory_scale_plan", ...detail }) + "\n");
          }
        }
      }
    }
    process.stdout.write(JSON.stringify({ event: "client_crm_directory_scale_summary", baseline: BASELINE_REF, databaseSettings,
      source: "invented loopback PostgreSQL records; app_rw RLS; no cache flush or production latency claim",
      fixture: { clients: CLIENTS, households: CLIENTS, identities: CLIENTS * 2, mappings: CLIENTS * 2,
        confirmedEmployeeBadges: EMPLOYEES, otherSourceTables: "empty" }, measurements, plans }) + "\n");
    // The optimized path must succeed within its unchanged real application
    // budget; a baseline timeout is retained as comparison evidence above.
    for (const surface of ["clients", "crm"]) for (const page of [1, 2]) {
      expect(successful.has(`${surface}:after:${page}`)).toBe(true);
    }
  }, 600_000);
});
