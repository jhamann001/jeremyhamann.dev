// The demo seed on real PostgreSQL is a function of its clock: seeded, reset (lib/demo/reset) and seeded again with
// the same `now`, every table holds the same rows, ids included, so links into the demo (/deals/[id], the audit
// trail's entity ids, a visitor's bookmarked transfer) survive the nightly reset. Each table is compared by a digest
// of its rows, leaving out only what is genuinely per run (PER_RUN below).
// Opt-in: DEMO_SEED_TEST_OWNER_URL is the owner login of a freshly migrated loopback database. It seeds and resets
// that database, so point it at a throwaway copy.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

// What a seed can't repeat, and why. Everything else must match.
//  - Stamped with the time of the write, not the seed's clock: columns defaulting to now() (User.createdAt, the roster
//    entries' created_at, the row-change trail's `at`, the asset-map mirror's and the held-away summaries' synced_at,
//    which the import and the summary feed leave to the database), Prisma's updatedAt (the roster upload, the fee
//    requests), and the close-date override's approved_at and created_at, which the migration and the reset stamp as they
//    insert its row.
//  - Production's scheduled jobs, which the seed runs as they are (seed/operations.ts): CRM identity reconciliation
//    and relationships, ACAT auto-linking, the review-queue sweep and the saved trade reconciliations give their rows
//    random ids and the time they ran, and the columns that point at those rows or hash them follow.
const PER_RUN: Record<string, string[]> = {
  'app."User"': ["createdAt"],
  "app.account_close_date_override": ["approved_at", "created_at"],
  "app.employee_roster_entry": ["created_at"],
  "app.employee_roster_upload": ["updated_at"],
  "app.operations_fee_request": ["updated_at"],
  "audit.row_change": ["at"],
  "mirror.acat_asset_map_account": ["synced_at"],
  "mirror.acat_asset_map_account_link": ["synced_at"],
  "mirror.acat_asset_map_household": ["synced_at"],
  "mirror.acat_asset_map_link": ["synced_at"],
  "mirror.acat_asset_map_position": ["synced_at"],
  "mirror.linked_external_account_summary": ["synced_at"],
  "app.crm_identity": ["id", "created_at", "updated_at", "first_seen_at"],
  "app.crm_source_mapping": ["id", "identity_id", "created_at", "updated_at", "first_seen_at", "last_seen_at"],
  "app.crm_relationship": [
    "id", "from_identity_id", "to_identity_id", "evidence_mapping_id", "created_at", "updated_at", "first_seen_at", "last_seen_at",
  ],
  "app.acat_link_run": ["id", "summary", "source_boundary", "target_boundary", "created_at", "updated_at"],
  "app.acat_link_decision": ["id", "run_id", "created_at", "updated_at"],
  "app.review_queue_item": ["id", "created_at", "updated_at", "detected_at", "last_seen_at"],
  "app.review_queue_event": ["item_id", "at"],
  "app.review_queue_sweep_state": ["created_at", "updated_at", "last_started_at", "last_completed_at"],
  "app.trade_reconciliation_run": ["id"],
};
// Audit rows written by code that leaves `at` to the database (writeAudit), and the jobs among them that name their
// run with an id of their own (the seed gives the CRM jobs, the import and the matcher theirs).
const AUDIT_AT_NOW = new Set([
  "ingest.asset_map", "ingest.asset_map_match", "ingest.asset_map_account_link", "crm.identity.reconcile",
  "crm.relationship.reconcile", "ingest.linked_external_account_summary", "acat_link.prepare", "acat_link.run",
  "trade_reconciliation.run",
]);
const AUDIT_OWN_RUN_ID = new Set(["ingest.linked_external_account_summary", "acat_link.prepare", "acat_link.run", "trade_reconciliation.run"]);
// The row-change trail of the tables whose ids are random: its row_pk and snapshot carry them.
const ROW_CHANGE_RANDOM_IDS = new Set(["crm_identity", "crm_source_mapping", "crm_relationship"]);

type Row = Record<string, unknown>;

function withoutPerRun(table: string, row: Row): Row {
  const out = { ...row };
  for (const column of PER_RUN[table] ?? []) delete out[column];
  if (table === 'audit."AuditLog"' && AUDIT_AT_NOW.has(String(out.action))) {
    delete out.at;
    if (AUDIT_OWN_RUN_ID.has(String(out.action))) {
      delete out.entityId;
      delete out.detail;
    }
  }
  if (table === "audit.row_change" && ROW_CHANGE_RANDOM_IDS.has(String(out.table_name))) {
    delete out.row_pk;
    delete out.changed;
  }
  return out;
}

RUN("demo seed: the same clock, the same rows", () => {
  let owner: PrismaClient;
  let ingest: PrismaClient;
  let tables: string[];
  let seed: () => Promise<unknown>;
  let clear: (db: PrismaClient) => Promise<{ tables: number }>;
  let dealId: (sfDealId: string) => string;
  let first: Record<string, string>;
  // One clock for both seeds.
  const now = new Date();

  // Every table's rows (sorted, per-run columns left out) as one digest per table, with its row count.
  async function digests(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const table of tables) {
      const rows = await owner.$queryRawUnsafe<Array<{ row: Row }>>(`SELECT to_jsonb(t) AS row FROM ${table} t`);
      const lines = rows.map((r) => JSON.stringify(withoutPerRun(table, r.row))).sort();
      out[table] = `${lines.length} rows ${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16)}`;
    }
    return out;
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries(DEMO_CONFIG)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    const { demoLoginUrls, ensureDemoLogins } = await import("@/lib/demo/logins");
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
    clear = reset.clearDemoDatabase;
    tables = (await owner.$queryRaw<Array<{ name: string }>>`
      SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables
       WHERE schemaname = ANY(${[...reset.DEMO_RESET_SCHEMAS]}::text[]) AND format('%I.%I', schemaname, tablename) <> 'app._prisma_migrations'
       ORDER BY 1`).map((t) => t.name);
    const { seedDemo } = await import("@/lib/demo/seed");
    const { loadUniverse } = await import("@/lib/demo/seed/universe");
    ({ dealId } = await import("@/lib/demo/seed/deals"));
    seed = () => seedDemo(loadUniverse(), owner, ingest, now);
  }, 60_000);

  afterAll(async () => {
    await owner?.$disconnect();
    await ingest?.$disconnect();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("seeds the demo, its deals under ids derived from their CRM ids and its clock recorded", async () => {
    await seed();
    const deals = await owner.$queryRaw<Array<{ id: string; sf_deal_id: string }>>`SELECT id, sf_deal_id FROM app.deal`;
    expect(deals.length).toBeGreaterThan(0);
    for (const d of deals) expect(d.id).toBe(dealId(d.sf_deal_id));
    const [clock] = await owner.$queryRaw<Array<{ seed_now: Date }>>`SELECT seed_now FROM demo.seed_clock`;
    expect(clock.seed_now.toISOString()).toBe(now.toISOString());
    // The app login reads it back for the sample data (the seed took longer than a millisecond, so this is no
    // wall-clock fallback).
    const { demoSampleNow, lastDemoSampleNow } = await import("@/lib/demo/samples/clock");
    expect((await demoSampleNow()).toISOString()).toBe(now.toISOString());
    expect(lastDemoSampleNow().toISOString()).toBe(now.toISOString());
    first = await digests();
  }, 120_000);

  it("seeds the same rows again after the reset", async () => {
    await clear(owner);
    await seed();
    expect(await digests()).toEqual(first);
  }, 180_000);
});
