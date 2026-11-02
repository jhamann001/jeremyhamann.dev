import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
          const start = performance.now();
          try { return await (target.$queryRaw.bind(target) as (...values: unknown[]) => Promise<unknown>)(...args); }
          finally { captured.queries.push({ sql, ms: Number((performance.now() - start).toFixed(2)) }); }
        };
      },
    })), options) };
});
import { applyCrmExplorerDatabaseBounds, listCrmIdentities, listCrmIdentityWindow, readCrmNavigationState } from "@/lib/data/crm-explorer";
import { withUserScope } from "@/lib/rls";

const benchmark = process.env.CRM_FULL_SOURCE_STRESS === "1" ? describe : describe.skip;
const OPS = { role: "OPERATIONS", email: "crm-stress-a@example.invalid" };
const HOUSEHOLDS = 2_500;
const SOURCE_ROWS = 100_000;
const fixtureIdentityCount = HOUSEHOLDS * 2 + SOURCE_ROWS * 3 + 5_000 + 1_000;
const errorCode = (error: unknown) => {
  const value = error as { code?: string; meta?: { code?: string } };
  return { code: value?.code ?? "unknown", sqlState: value?.meta?.code ?? null };
};

// Explicit stress fixture, not a claim about dev counts or cold I/O. All 13
// version relations are populated. Retain invented rows only in this dedicated
// database for repeatable plan experiments; no shared test database is touched.
benchmark("CRM populated-source/RLS stress diagnosis", () => {
  let owner: PrismaClient;
  let versionSql: Prisma.Sql;
  beforeAll(async () => {
    const cleanup = process.env.AUDIT_TEST_CLEANUP_URL, reader = process.env.DATABASE_URL;
    if (!cleanup || !reader) throw new Error("explicit_synthetic_database_required");
    for (const [raw, username] of [[cleanup, "aoa"], [reader, "app_rw"]]) {
      const url = new URL(raw);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
        || url.port !== "55444" || url.pathname !== "/aoa_directory_contention_synthetic" || url.username !== username
        || [...url.searchParams.keys()].some(key => !["schema", "connection_limit", "pool_timeout"].includes(key))
        || process.env.K_SERVICE || process.env.CLOUD_RUN_SERVICE
        || ["dev", "development", "prod", "production"].includes(process.env.APP_ENV?.toLowerCase() ?? "")) {
        throw new Error("isolated_synthetic_database_required");
      }
    }
    owner = new PrismaClient({ datasourceUrl: cleanup });
    vi.stubEnv("CRM_IDENTITY_READS", "1");
    const [{ n }] = await owner.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM app.crm_identity`;
    if (Number(n) !== 0 && Number(n) !== fixtureIdentityCount) throw new Error("unexpected_or_partial_stress_fixture");
    if (Number(n) === 0) {
      await owner.$executeRaw`INSERT INTO mirror.household (sf_id, name, stage, lead_advisor_email)
        SELECT '001FSS' || lpad(i::text,9,'0') || 'AAA', 'Invented Full Source Household ' || i, 'Client',
          CASE i % 2 WHEN 0 THEN ${OPS.email} ELSE 'crm-stress-b@example.invalid' END FROM generate_series(1, ${HOUSEHOLDS}) i`;
      await owner.$executeRaw`INSERT INTO mirror.client (sf_id, household_id, first_name, last_name, lead_advisor_email)
        SELECT '003FSS' || lpad(i::text,9,'0') || 'AAA', '001FSS' || lpad(i::text,9,'0') || 'AAA', 'Invented Full Source', i::text,
          CASE i % 2 WHEN 0 THEN ${OPS.email} ELSE 'crm-stress-b@example.invalid' END FROM generate_series(1, ${HOUSEHOLDS}) i`;
      for (const table of [Prisma.sql`mirror.email`, Prisma.sql`mirror.activity`, Prisma.sql`mirror.task`]) {
        await owner.$executeRaw(Prisma.sql`INSERT INTO ${table} (sf_id, household_sf_id, subject)
          SELECT 'FSS-' || i, '001FSS' || lpad(((i % ${HOUSEHOLDS}) + 1)::text,9,'0') || 'AAA',
            'Invented source text ' || i || ' ' || repeat(md5(i::text), 8) FROM generate_series(1, ${SOURCE_ROWS}) i`);
      }
      await owner.$executeRaw`INSERT INTO mirror.appointment (external_key, source, client_name, client_sf_id, meeting_type, starts_at)
        SELECT 'FSS-' || i, 'synthetic-stress', 'Invented Appointment ' || i,
          '003FSS' || lpad(((i % ${HOUSEHOLDS}) + 1)::text,9,'0') || 'AAA', 'Invented meeting', '2026-09-17'::timestamptz
        FROM generate_series(1, 5000) i`;
      await owner.$executeRaw`INSERT INTO app.deal (id, source, name, client_first_name, client_last_name, household_name,
        household_sf_id, client_sf_id, amount, stage, created_date, updated_at)
        SELECT 'FSS-deal-' || i, 'IMPORT', 'Invented Deal ' || i, 'Invented', i::text, 'Invented Household',
          '001FSS' || lpad(i::text,9,'0') || 'AAA', '003FSS' || lpad(i::text,9,'0') || 'AAA', 1, 'POTENTIAL',
          '2026-09-17'::date, now() FROM generate_series(1, 500) i`;
      await owner.$executeRaw`INSERT INTO app.transfer (id, source, client_first_name, client_last_name, household_name,
        household_sf_id, client_sf_id, value, updated_at)
        SELECT 'FSS-transfer-' || i, 'APP', 'Invented', i::text, 'Invented Household',
          '001FSS' || lpad(i::text,9,'0') || 'AAA', '003FSS' || lpad(i::text,9,'0') || 'AAA', 1, now()
        FROM generate_series(1, 500) i`;
      const sources = [
        ["hld", "HOUSEHOLD", "CRM", "household", Prisma.sql`SELECT sf_id AS source_key FROM mirror.household`],
        ["con", "CONTACT", "CRM", "contact", Prisma.sql`SELECT sf_id AS source_key FROM mirror.client`],
        ["eml", "EMAIL", "CRM", "email", Prisma.sql`SELECT sf_id AS source_key FROM mirror.email`],
        ["act", "ACTIVITY", "CRM", "activity", Prisma.sql`SELECT sf_id AS source_key FROM mirror.activity`],
        ["tsk", "TASK", "CRM", "task", Prisma.sql`SELECT sf_id AS source_key FROM mirror.task`],
        ["apt", "APPOINTMENT", "CALENDAR", "appointment", Prisma.sql`SELECT external_key AS source_key FROM mirror.appointment`],
        ["dea", "DEAL", "AOA", "deal", Prisma.sql`SELECT id AS source_key FROM app.deal`],
        ["xfr", "TRANSFER", "AOA", "transfer", Prisma.sql`SELECT id AS source_key FROM app.transfer`],
      ] as const;
      for (const [prefix, type, system, namespace, source] of sources) {
        await owner.$executeRaw(Prisma.sql`INSERT INTO app.crm_identity (id, identity_type, updated_at)
          SELECT ${prefix} || '_fss' || md5(source_key), ${type}, '2026-09-17'::timestamptz FROM (${source}) source`);
        await owner.$executeRaw(Prisma.sql`INSERT INTO app.crm_source_mapping (id, identity_id, source_system, source_namespace, source_key, updated_at)
          SELECT 'fss-map-' || ${prefix} || '-' || md5(source_key), ${prefix} || '_fss' || md5(source_key), ${system}, ${namespace}, source_key, now()
          FROM (${source}) source`);
      }
      await owner.$executeRaw`INSERT INTO app.crm_identity_exception (id, source_mapping_id, reason_code, updated_at)
        SELECT 'fss-exception-' || i, 'fss-map-eml-' || md5('FSS-' || i), 'MISSING_PARENT_MAPPING', now() FROM generate_series(1, 1000) i`;
      await owner.$executeRaw`INSERT INTO app.crm_parent_override
        (id, source_mapping_id, child_identity_id, parent_identity_id, relationship_code, confirmed_by, updated_at)
        SELECT 'c' || substr(md5('fss-parent-' || i),1,24), 'fss-map-eml-' || md5('FSS-' || i), 'eml_fss' || md5('FSS-' || i),
          'hld_fss' || md5('001FSS' || lpad(((i % ${HOUSEHOLDS}) + 1)::text,9,'0') || 'AAA'), 'EMAIL_TO_HOUSEHOLD', ${OPS.email}, now()
        FROM generate_series(1, 1000) i`;
      await owner.$executeRaw`INSERT INTO app.crm_duplicate_candidate (id, detector_key, entity_type, left_identity_id, right_identity_id, evidence_codes, updated_at)
        SELECT 'dup_' || md5('fss-candidate-' || i), md5('fss-candidate-' || i) || md5('fss-candidate-' || i), 'HOUSEHOLD',
          LEAST('hld_fss' || md5('001VTF959320423AAA'), 'hld_fss' || md5('001FSS' || lpad((i + 1)::text,9,'0') || 'AAA')),
          GREATEST('hld_fss' || md5('001VTF959320423AAA'), 'hld_fss' || md5('001FSS' || lpad((i + 1)::text,9,'0') || 'AAA')),
          ARRAY['SHARED_CEDAR_RIDGE_USER_ID'], now() FROM generate_series(1, 500) i`;
      await owner.$executeRaw`ANALYZE`;
    }
    await readCrmNavigationState({ $queryRaw: async (sql: Prisma.Sql) => {
      versionSql = sql;
      return [{ snapshot: "a".repeat(32), identities: 0n, source_aliases: 0n, open_exceptions: 0n, potential_duplicates: 0n, latest_seen_at: null }];
    } } as unknown as Prisma.TransactionClient);
  }, 180_000);
  afterAll(async () => { await owner?.$disconnect(); vi.unstubAllEnvs(); });

  it("records complete read phases and the full-content fingerprint plan", async () => {
    for (const page of [1, 2]) {
      captured.queries = [];
      const start = performance.now();
      let outcome: unknown;
      try {
        const result = await listCrmIdentities(OPS, { page });
        if (!result.ok) throw new Error("unexpected_denied_read");
        expect(result.total).toBe(fixtureIdentityCount);
        expect(result.rows).toHaveLength(100);
        outcome = { ok: true, total: result.total, snapshot: result.snapshot };
      } catch (error) {
        const failure = errorCode(error);
        if (failure.code !== "P2028" && !(failure.code === "P2010" && failure.sqlState === "57014")) throw error;
        outcome = failure;
      }
      process.stdout.write(JSON.stringify({ event: "crm_full_source_stress", page, outcome,
        elapsedMs: performance.now() - start, queryMs: captured.queries.map(row => row.ms) }) + "\n");
    }
    const [explain] = await withUserScope(OPS, async tx => {
      await applyCrmExplorerDatabaseBounds(tx);
      return tx.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${versionSql}`);
    }, { timeout: 15_000, maxWait: 5_000 });
    const plan = (explain["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>)[0].Plan;
    const nodes: Array<Record<string, unknown>> = [];
    const visit = (node: Record<string, unknown>) => {
      nodes.push({ type: node["Node Type"], relation: node["Relation Name"], subplan: node["Subplan Name"],
        cost: node["Total Cost"], rows: node["Plan Rows"], actualMs: node["Actual Total Time"],
        actualLoops: node["Actual Loops"], actualRows: node["Actual Rows"], hits: node["Shared Hit Blocks"],
        reads: node["Shared Read Blocks"], tempWritten: node["Temp Written Blocks"] });
      if (Array.isArray(node.Plans)) for (const child of node.Plans) visit(child);
    };
    visit(plan);
    process.stdout.write(JSON.stringify({ event: "crm_full_source_plan", totalCost: plan["Total Cost"],
      expensiveNodes: nodes.filter(node => node.subplan?.toString().startsWith("CTE source_")).sort((a, b) => Number(b.actualMs) - Number(a.actualMs)) }) + "\n");
  }, 45_000);

  it.runIf(process.env.CRM_CONCURRENT_STRESS === "1")("records concurrent full reads under unchanged application budgets", async () => {
    for (const concurrency of [2, 5]) {
      const outcomes = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
        const start = performance.now();
        try {
          const page = await listCrmIdentities(OPS, { page: index + 1 });
          if (!page.ok) throw new Error("unexpected_denied_read");
          expect(page.total).toBe(fixtureIdentityCount);
          return { elapsedMs: performance.now() - start, ok: true, snapshot: page.snapshot };
        } catch (error) {
          const code = errorCode(error);
          if (!["P2028", "P2010"].includes(code.code)) throw error;
          return { elapsedMs: performance.now() - start, ok: false, ...code };
        }
      }));
      process.stdout.write(JSON.stringify({ event: "crm_concurrent_source_stress", concurrency, outcomes }) + "\n");
    }
  }, 45_000);

  it.runIf(process.env.CRM_COUNTS_STRESS === "1")("measures exact fresh global counts without the full content digest", async () => {
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      const result = await withUserScope(OPS, async tx => {
        await applyCrmExplorerDatabaseBounds(tx);
        const [row] = await tx.$queryRaw<Array<Record<string, unknown>>>`
          SELECT (SELECT count(*)::text FROM app.crm_identity) AS identities,
            (SELECT count(*)::text FROM app.crm_source_mapping) AS source_aliases,
            (SELECT count(*)::text FROM app.crm_identity_exception WHERE exception_state = 'OPEN') AS open_exceptions,
            (SELECT count(*)::text FROM app.crm_duplicate_candidate c
              WHERE c.source_active AND (c.status = 'NEW' OR (c.status = 'SNOOZED' AND c.snoozed_until <= now()))) AS potential_duplicates,
            (SELECT max(last_seen_at) FROM app.crm_source_mapping) AS latest_seen_at`;
        return row;
      }, { timeout: 15_000, maxWait: 5_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      expect(result.identities).toBe(String(fixtureIdentityCount));
      process.stdout.write(JSON.stringify({ event: "crm_exact_counts_without_version", run,
        elapsedMs: performance.now() - start, result }) + "\n");
    }
  }, 45_000);

  it.runIf(process.env.CRM_WINDOW_STRESS === "1")("measures the new100-row and5000-prefix paths against populated sources", async () => {
    let window: { firstPage: number; pageSize: number; loaded: number; snapshot: string | null } = { firstPage: 1, pageSize: 100, loaded: 0, snapshot: null };
    for (let run = 0; run < 50; run++) {
      captured.queries = [];
      const start = performance.now();
      const page = await listCrmIdentityWindow(OPS, {}, window);
      if (!page.ok) throw new Error("expected_access");
      expect(page.meta.total).toBe(fixtureIdentityCount);
      expect(page.rows).toHaveLength(100);
      expect(captured.queries.every(row => !(row.sql as Prisma.Sql).sql.includes("CTE source_"))).toBe(true);
      const elapsedMs = performance.now() - start;
      window = { ...window, loaded: page.loaded, snapshot: page.snapshot };
      if (run === 0 || run === 49) process.stdout.write(JSON.stringify({ event: "crm_bounded_window_stress",
        loaded: page.loaded, returned: page.rows.length, elapsedMs, queryMs: captured.queries.map(row => row.ms), total: page.meta.total }) + "\n");
    }
    expect(window.loaded).toBe(5000);
  }, 180_000);

  it.runIf(process.env.CRM_RESTORE_STRESS === "1")("measures one fresh5000-row restoration against populated sources", async () => {
    captured.queries = [];
    const start = performance.now();
    const page = await listCrmIdentityWindow(OPS, {}, { firstPage: 1, pageSize: 100, loaded: 0, snapshot: null, restoreRows: 5000 });
    if (!page.ok) throw new Error("expected_access");
    expect(page.meta.total).toBe(fixtureIdentityCount);
    expect(page.rows).toHaveLength(5000);
    expect(page.loaded).toBe(5000);
    expect(page.pageSize).toBe(100);
    expect(page.hasMore).toBe(true);
    expect(new Set(page.rows.map(row => row.id)).size).toBe(5000);
    expect(captured.queries).toHaveLength(4);
    process.stdout.write(JSON.stringify({ event: "crm_single_restore_stress", returned: page.rows.length,
      elapsedMs: performance.now() - start, queryMs: captured.queries.map(row => row.ms), total: page.meta.total }) + "\n");
  }, 20_000);

  it.runIf(process.env.CRM_RLS_IN_EXPERIMENT === "1")("diagnoses an equivalent IN policy without persisting any policy change", async () => {
    const rollback = new Error("rollback_synthetic_policy_experiment");
    const comparable: Record<string, unknown[]> = {};
    for (const variant of ["baseline", "in-policy"]) {
      const measurements: unknown[] = [];
      try {
        await owner.$transaction(async tx => {
          if (variant === "in-policy") {
            await tx.$executeRaw`ALTER POLICY crm_identity_app_read ON app.crm_identity
              USING (id IN (SELECT identity_id FROM app.crm_source_mapping))`;
            await tx.$executeRaw`ALTER POLICY crm_identity_exception_ops_read ON app.crm_identity_exception
              USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
                AND source_mapping_id IN (SELECT id FROM app.crm_source_mapping))`;
          }
          await tx.$executeRaw`SET LOCAL ROLE app_rw`;
          await tx.$executeRaw`SELECT set_config('app.user_role', 'OPERATIONS', true)`;
          await tx.$executeRaw`SELECT set_config('app.user_email', ${OPS.email}, true)`;
          await applyCrmExplorerDatabaseBounds(tx);
          const [explain] = await tx.$queryRaw<Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>>(
            Prisma.sql`EXPLAIN (FORMAT JSON) ${versionSql}`);
          process.stdout.write(JSON.stringify({ event: "crm_rls_policy_plan", variant,
            totalCost: explain["QUERY PLAN"][0].Plan["Total Cost"],
            // Detect the dangerous non-hashed IN fallback at this fixture size.
            materializeNodes: JSON.stringify(explain).match(/"Node Type":"Materialize"/g)?.length ?? 0,
            hashedSubplans: JSON.stringify(explain).match(/hashed SubPlan/g)?.length ?? 0 }) + "\n");
          let start = performance.now();
          const result = await readCrmNavigationState(tx);
          measurements.push({ operation: "full-version", elapsedMs: performance.now() - start, snapshot: result.snapshot, stats: result.stats });
          for (const role of ["OPERATIONS", "ADMIN", "ADVISOR", "CLIENT_SERVICE", "VIEWER", "INVALID_ROLE"]) {
            await tx.$executeRaw`SELECT set_config('app.user_role', ${role}, true)`;
            start = performance.now();
            const [parity] = await tx.$queryRaw<Array<Record<string, unknown>>>`
              SELECT
                (SELECT count(*)::text FROM app.crm_identity) AS identities,
                (SELECT md5(coalesce(string_agg(id, '' ORDER BY id), '')) FROM app.crm_identity) AS identity_ids,
                (SELECT count(*)::text FROM app.crm_identity_exception) AS exceptions,
                (SELECT md5(coalesce(string_agg(id, '' ORDER BY id), '')) FROM app.crm_identity_exception) AS exception_ids`;
            measurements.push({ operation: "role-parity", role, elapsedMs: performance.now() - start, ...parity });
          }
          throw rollback;
        }, { timeout: 90_000, maxWait: 5_000 });
      } catch (error) {
        if (error !== rollback) {
          const failure = errorCode(error);
          if (failure.code !== "P2028" && !(failure.code === "P2010" && failure.sqlState === "57014")) throw error;
          measurements.push({ error: failure });
        }
      }
      comparable[variant] = measurements.map(value => {
        const { elapsedMs: _elapsed, ...result } = value as Record<string, unknown>;
        return result;
      });
      process.stdout.write(JSON.stringify({ event: "crm_rls_policy_experiment", variant, measurements }) + "\n");
    }
    if (!JSON.stringify(comparable).includes('"error"')) expect(comparable["in-policy"]).toEqual(comparable.baseline);
  }, 190_000);
});
