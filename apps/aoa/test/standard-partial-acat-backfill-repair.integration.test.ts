import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Run with the normal synthetic database CI gate. The suite creates its own
// disposable database and NON-superuser owner; it never alters the shared app
// database. A superuser-only CI migration run would miss the original defect.
const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const require = createRequire(import.meta.url);
const migration = (name: string) => readFileSync(join(import.meta.dirname, "../prisma/migrations", name, "migration.sql"), "utf8");
const original = migration("20260909184500_standard_partial_acat_tasks");
const repair = migration("20260924120000_standard_partial_acat_backfill_repair");
const suffix = randomBytes(5).toString("hex");
const database = `aoa_partial_repair_${suffix}_synthetic`;
const ownerRole = `aoa_partial_owner_${suffix}`;
let admin: PrismaClient;
let inspector: PrismaClient;
let ownerUrl: string;
let databaseCreated = false;
let roleCreated = false;

function execute(sql: string) {
  // db execute sends the exact SQL script (including BEGIN/COMMIT), so these
  // tests exercise migration transaction boundaries rather than adding their own.
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "db", "execute", "--url", ownerUrl, "--stdin"], {
    input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000,
  });
}

async function seedCase(id: string, status = "OPEN", source = "ASSET_TRANSFER", key = `asset-transfer:${id}:excluded-positions`) {
  await inspector.$executeRawUnsafe(`INSERT INTO app.transfer (id) VALUES ($1)`, id);
  await inspector.$executeRawUnsafe(`INSERT INTO app.decision_case
    (id, source, source_key, transfer_id, question, owner_team, status, blocks_transfer,
     created_by, version, resolution_code, resolution_summary, resolved_by, resolved_at)
    VALUES ($1, $2::app."DecisionCaseSource", $3, $1, 'Synthetic legacy case', 'OPERATIONS',
      $4::app."DecisionCaseStatus", true, 'synthetic@example.test',
      CASE WHEN $4 = 'RESOLVED' THEN 1 ELSE 0 END,
      CASE WHEN $4 = 'RESOLVED' THEN 'KEEP_HISTORY' END,
      CASE WHEN $4 = 'RESOLVED' THEN 'Previously completed' END,
      CASE WHEN $4 = 'RESOLVED' THEN 'synthetic@example.test' END,
      CASE WHEN $4 = 'RESOLVED' THEN CURRENT_TIMESTAMP END)`, id, source, key, status);
  await inspector.$executeRawUnsafe(`INSERT INTO app.decision_task
    (id, decision_id, transfer_id, task_key, title, owner_team)
    VALUES ($1 || '-resolver', $1, $1, 'resolve-excluded-positions', 'Legacy resolver', 'OPERATIONS')`, id);
}

async function state() {
  return inspector.$queryRawUnsafe<Array<{ state: unknown }>>(`SELECT jsonb_build_object(
    'cases', (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM app.decision_case c),
    'tasks', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM app.decision_task t),
    'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM app.decision_case_event e)
  ) AS state`);
}

async function forcedRls() {
  return inspector.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>(`
    SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE relnamespace = 'app'::regnamespace
      AND relname IN ('decision_case', 'decision_task', 'decision_case_event') ORDER BY relname`);
}

gated("partial-ACAT repair under a non-BYPASSRLS migration owner", () => {
  beforeAll(async () => {
    const raw = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!raw) throw new Error("Explicit synthetic database admin URL required");
    const url = new URL(raw);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        (!(process.env.CI === "true" && url.pathname === "/aoa") && !url.pathname.endsWith("_synthetic")) ||
        ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))) {
      throw new Error("Migration rehearsal requires a loopback synthetic database");
    }
    url.searchParams.set("connection_limit", "1");
    admin = new PrismaClient({ datasourceUrl: url.toString() });
    const roles = await admin.$queryRawUnsafe<Array<{ rolsuper: boolean }>>(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
    if (!roles[0]?.rolsuper) throw new Error("Disposable fixture creation requires the local test superuser");
    await admin.$executeRawUnsafe(`CREATE ROLE ${ownerRole} LOGIN NOSUPERUSER NOBYPASSRLS`);
    roleCreated = true;
    await admin.$executeRawUnsafe(`CREATE DATABASE ${database} OWNER ${ownerRole}`);
    databaseCreated = true;
    url.pathname = `/${database}`;
    url.searchParams.set("schema", "app");
    inspector = new PrismaClient({ datasourceUrl: url.toString() });
    url.username = ownerRole;
    url.password = "";
    ownerUrl = url.toString();
    execute('CREATE SCHEMA IF NOT EXISTS app; CREATE TABLE app.transfer (id text PRIMARY KEY);');
    execute(migration("20260908193000_unified_decision_workflow"));
    await seedCase("legacy-open");
    await seedCase("legacy-snoozed", "SNOOZED");
    await seedCase("keep-resolved", "RESOLVED");
    await seedCase("keep-manual", "OPEN", "MANUAL", "manual:keep");
    await seedCase("keep-exception", "OPEN", "ASSET_TRANSFER", "asset-transfer:keep-exception:explicit-exception");
  }, 60_000);

  afterAll(async () => {
    await inspector?.$disconnect();
    if (databaseCreated) await admin.$executeRawUnsafe(`DROP DATABASE ${database} WITH (FORCE)`);
    if (roleCreated) await admin.$executeRawUnsafe(`DROP ROLE ${ownerRole}`);
    await admin?.$disconnect();
  });

  it("reproduces the historical silent no-op and repairs only eligible cases atomically", async () => {
    const role = await inspector.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, ownerRole);
    expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const before = await state();
    execute(original);
    // Schema changed, but all old work remains untouched: the original owner
    // sees zero rows through FORCE RLS and still reports migration success.
    expect(await inspector.$queryRawUnsafe(`SELECT source_key FROM app.decision_task WHERE decision_id IS NULL`)).toEqual([]);
    expect(await inspector.$queryRawUnsafe(`SELECT id FROM app.decision_case WHERE resolution_code = 'STANDARD_PARTIAL_ACAT'`)).toEqual([]);
    expect((await state())[0].state).toMatchObject({ cases: (before[0].state as { cases: unknown }).cases });

    // A task already completed by an operator must keep its exact ID, status,
    // completion actor and timestamp through repair and later replays.
    await inspector.$executeRawUnsafe(`INSERT INTO app.decision_task
      (id, source_key, transfer_id, task_key, title, owner_team, status, completed_by, completed_at)
      VALUES ('existing-completed', 'asset-transfer:legacy-open:standard-partial-acat:prepare-wet-signature-paperwork',
        'legacy-open', 'prepare-wet-signature-paperwork', 'Existing operator title', 'CLIENT_SERVICE',
        'DONE', 'original@example.test', '2026-09-01T12:00:00Z')`);
    const completed = await inspector.$queryRawUnsafe(`SELECT * FROM app.decision_task WHERE id = 'existing-completed'`);
    await inspector.$executeRawUnsafe(`INSERT INTO app.decision_case_event
      (decision_id, action, actor_email, actor_role, to_status, detail)
      VALUES ('legacy-open', 'CREATED', 'historical@example.test', 'OPERATIONS', 'OPEN', '{"preserve":"original trail"}')`);
    const history = await inspector.$queryRawUnsafe(`SELECT * FROM app.decision_case_event WHERE action = 'CREATED'`);
    const beforeFailure = await state();
    expect(() => execute(repair.replace('ALTER TABLE "app"."decision_case" FORCE ROW LEVEL SECURITY;',
      'SELECT 1 / 0;\nALTER TABLE "app"."decision_case" FORCE ROW LEVEL SECURITY;'))).toThrow();
    expect(await state()).toEqual(beforeFailure);
    expect(await forcedRls()).toEqual(expect.arrayContaining([
      ...["decision_case", "decision_task", "decision_case_event"].map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })),
    ]));

    execute(repair);
    expect(await inspector.$queryRawUnsafe(`SELECT id, status::text, blocks_transfer, version FROM app.decision_case
      WHERE resolution_code = 'STANDARD_PARTIAL_ACAT' ORDER BY id`)).toEqual([
      { id: "legacy-open", status: "RESOLVED", blocks_transfer: false, version: 1 },
      { id: "legacy-snoozed", status: "RESOLVED", blocks_transfer: false, version: 1 },
    ]);
    expect(await inspector.$queryRawUnsafe(`SELECT transfer_id, count(*)::int AS count FROM app.decision_task
      WHERE decision_id IS NULL GROUP BY transfer_id ORDER BY transfer_id`)).toEqual([
      { transfer_id: "legacy-open", count: 3 }, { transfer_id: "legacy-snoozed", count: 3 },
    ]);
    expect(await inspector.$queryRawUnsafe(`SELECT * FROM app.decision_task WHERE id = 'existing-completed'`)).toEqual(completed);
    expect(await inspector.$queryRawUnsafe(`SELECT decision_id, status::text FROM app.decision_task
      WHERE task_key = 'resolve-excluded-positions' ORDER BY decision_id`)).toEqual([
      { decision_id: "keep-exception", status: "TODO" }, { decision_id: "keep-manual", status: "TODO" },
      { decision_id: "keep-resolved", status: "TODO" }, { decision_id: "legacy-open", status: "DONE" },
      { decision_id: "legacy-snoozed", status: "DONE" },
    ]);
    const events = await inspector.$queryRawUnsafe<Array<{ decision_id: string; action: string; actor_role: string }>>(`
      SELECT decision_id, action, actor_role FROM app.decision_case_event WHERE action = 'RESOLVED' ORDER BY decision_id`);
    expect(events).toEqual([
      { decision_id: "legacy-open", action: "RESOLVED", actor_role: "SYSTEM" },
      { decision_id: "legacy-snoozed", action: "RESOLVED", actor_role: "SYSTEM" },
    ]);
    expect(await inspector.$queryRawUnsafe(`SELECT * FROM app.decision_case_event WHERE action = 'CREATED'`)).toEqual(history);
    const after = await state();
    execute(repair);
    expect(await state()).toEqual(after);
    expect((await forcedRls()).every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const owner = new PrismaClient({ datasourceUrl: ownerUrl });
    try {
      expect(await owner.$queryRawUnsafe(`SELECT id FROM app.decision_case`)).toEqual([]);
      expect(await owner.$queryRawUnsafe(`SELECT id FROM app.decision_task`)).toEqual([]);
      expect(await owner.$queryRawUnsafe(`SELECT id FROM app.decision_case_event`)).toEqual([]);
    } finally {
      await owner.$disconnect();
    }
  }, 90_000);
});
