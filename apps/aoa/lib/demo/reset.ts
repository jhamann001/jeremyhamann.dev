// The nightly reset's first half, run as the owner: one transaction that empties every table the migrations made
// (but the few it keeps, below), restarts their sequences and puts back the rows the migrations themselves insert,
// leaving the database as a fresh migration and the seed's cutover leave it. The demo seed then fills it again
// (scripts/demo-seed.ts with DEMO_SEED=reset), so every date is relative to the reset, not to a snapshot.
//
// TRUNCATE, not DELETE: the append-only tables refuse UPDATE and DELETE through their triggers, but no trigger runs
// on TRUNCATE, and none of the logins the demo signs in with may truncate. The reset test fails if a migration adds a
// schema, a TRUNCATE trigger or a row of its own, so this file can't silently fall behind.
// Visitors see the old data until the transaction commits, then the new data appears as the seed writes it.
//
// The clear commits before the seed starts, so a seed that then fails leaves the demo empty. demoMigrationProblems
// is one of the checks the reset runs first (scripts/demo-seed.ts), so it stops with the data intact instead.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";

/** Every schema AoA's migrations create tables in (public holds none). */
export const DEMO_RESET_SCHEMAS = ["app", "audit", "demo", "mirror", "statement_pipeline", "trade_request"] as const;

/**
 * Tables the reset keeps as they are: Prisma's migration history, and the trade-request serving state with its two
 * transition logs. Only the owner's cutover job writes those (lib/trade-requests/serving-state-admin.ts, the one
 * writer test/trade-request-cutover-structure.test.ts allows); the logins the demo signs in with may only read them,
 * so no visitor can change them. The seed's own switch to AoA-served then finds it already done and writes nothing.
 */
export const DEMO_RESET_KEPT: readonly string[] = [
  "app._prisma_migrations",
  "trade_request.serving_state",
  "trade_request.serving_state_transitions",
  "trade_request.standalone_transitions",
];

/** The rows the migrations insert, as they insert them (migration folder in each comment). */
export const DEMO_RESET_BASELINE: ReadonlyArray<{ table: string; sql: string }> = [
  // 20260706000000_seed_advisor_reference
  {
    table: "mirror.advisor",
    sql: `INSERT INTO mirror.advisor (sf_id, name, email, title, active)
          VALUES ('003Sx32720OPJ3RIAX', 'Rachel Moss', 'rachel.moss@example.com', 'Advisor', true)`,
  },
  // 20260822130000_apex_balance_breakout
  {
    table: "app.account_close_date_override",
    sql: `INSERT INTO app.account_close_date_override
            (custodian_account_id, provisional_close_date, reason, source_reference, approved_by, approved_at)
          VALUES ('01SYNTH91CNZDPTY5FVCZAQCB1', DATE '2026-04-14',
                  'Operational close date: 90 days after the account-close request.',
                  'Operations-approved close request dated 2026-01-14.', 'owner', CURRENT_TIMESTAMP)`,
  },
  // (20261101120000_trade_request_schema inserts the serving-state row too: kept, see DEMO_RESET_KEPT.)
  // 20261102120000_custodian_authority_storage
  { table: "app.custodian_authority_state", sql: `INSERT INTO "app"."custodian_authority_state" ("id") VALUES (1)` },
];

/** Empties the demo database back to its migrated state. Returns how many tables it emptied. */
export async function clearDemoDatabase(owner: PrismaClient): Promise<{ tables: number }> {
  return owner.$transaction(
    async (tx) => {
      // Wait at most this long for a visitor's open transaction to finish before giving up (and leaving the data).
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '30s'");
      const tables = await tx.$queryRaw<Array<{ name: string }>>`
        SELECT format('%I.%I', schemaname, tablename) AS name
          FROM pg_tables
         WHERE schemaname = ANY(${[...DEMO_RESET_SCHEMAS]}::text[])
         ORDER BY 1`;
      const names = tables.map((t) => t.name).filter((name) => !DEMO_RESET_KEPT.includes(name));
      await tx.$executeRawUnsafe(`TRUNCATE TABLE ${names.join(", ")} RESTART IDENTITY`);
      for (const { sql } of DEMO_RESET_BASELINE) await tx.$executeRawUnsafe(sql);
      // The custodian authority row's audit trigger came after the migration that inserts it, so putting the row back
      // writes an audit row a fresh migration doesn't have. Empty everything but the baseline once more.
      const baseline = new Set(DEMO_RESET_BASELINE.map((row) => row.table));
      const rest = names.filter((name) => !baseline.has(name));
      await tx.$executeRawUnsafe(`TRUNCATE TABLE ${rest.join(", ")} RESTART IDENTITY`);
      return { tables: names.length };
    },
    { maxWait: 30_000, timeout: 120_000 },
  );
}

/** One row of Prisma's migration history (app._prisma_migrations). */
export interface AppliedMigration {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

/**
 * How the database's migration history differs from the migrations this checkout carries, one line per problem
 * (none when they match). A migration the database lacks means the seed expects a schema it doesn't have yet (one
 * merged but not deployed); one only the database has means it is ahead of this code (a deploy that migrated, then
 * failed); one that never finished means the schema is half changed. In each case the seed could fail after the
 * clear. A row Prisma marked rolled back is history only: the migration ran again, or is listed as not applied.
 */
export function migrationProblems(applied: readonly AppliedMigration[], available: readonly string[]): string[] {
  const current = applied.filter((m) => m.rolled_back_at === null);
  const finished = new Set(current.filter((m) => m.finished_at !== null).map((m) => m.migration_name));
  const unfinished = new Set(current.filter((m) => m.finished_at === null).map((m) => m.migration_name));
  const known = new Set(available);
  const missing = available.filter((name) => !finished.has(name) && !unfinished.has(name));
  const extra = [...finished].filter((name) => !known.has(name)).sort();
  return [
    ...[...unfinished].sort().map((name) => `${name}: started in the database but never finished`),
    ...missing.map((name) => `${name}: not applied to the database`),
    ...extra.map((name) => `${name}: in the database but not in this checkout`),
  ];
}

/** The migrations in `directory` (prisma/migrations): each folder holding a migration.sql, in name order. */
export function migrationFolders(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .sort();
}

/** migrationProblems for the database `owner` reaches, against the migrations in `directory`. */
export async function demoMigrationProblems(owner: PrismaClient, directory: string): Promise<string[]> {
  const applied = await owner.$queryRaw<AppliedMigration[]>`
    SELECT migration_name, finished_at, rolled_back_at FROM app._prisma_migrations`;
  return migrationProblems(applied, migrationFolders(directory));
}
