/**
 * One-time backfill of historical client exclusions into the `client_exclusions`
 * table. Sources from an NDJSON file (one exclusion per line) generated outside
 * this repo. Writes are atomic — any single failure rolls the whole batch back.
 *
 * Never goes through the API routes (no Slack fan-out, no in-app notifications)
 * because a 14-row backfill should not page every active trader. The audit trail
 * lives in `created_by_name` (the canonical attribution string below) and the
 * source NDJSON file in this repo.
 *
 * Usage:
 *   tsx src/scripts/backfillExclusions.ts --file <path> [--dry-run|--commit]
 *
 * Defaults to --dry-run when neither flag is set. The DB target is whatever
 * connection the standard pool resolves (see src/db/pool.ts) — set the env
 * before running.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import pool from '../db/pool.js';

const BACKFILL_AUTHOR = 'Backfill — Jeremy Hamann (2026-05-21)';
const TICKER_REGEX = /^[A-Z0-9.-]+$/;

const rowSchema = z
  .object({
    client_id: z.string().trim().min(1).max(100),
    ticker: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .transform((s) => s.toUpperCase())
      .refine((s) => TICKER_REGEX.test(s), 'ticker must be [A-Z0-9.-]+'),
    kind: z.enum(['advisor', 'client']),
    reason: z.string().trim().max(500).default(''),
    no_buy: z.boolean(),
    no_sell: z.boolean(),
  })
  .refine((v) => v.no_buy || v.no_sell, {
    message: 'no_buy OR no_sell must be true',
    path: ['no_buy'],
  });

type ParsedRow = z.infer<typeof rowSchema> & { lineNo: number };

function fmtSide(noBuy: boolean, noSell: boolean): string {
  if (noBuy && noSell) return 'DNB+DNS';
  if (noBuy) return 'DNB';
  return 'DNS';
}

async function preflightSchema(): Promise<void> {
  const required = ['client_id', 'ticker', 'kind', 'reason', 'no_buy', 'no_sell', 'created_by', 'created_by_name'];
  const { rows: colRows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'client_exclusions'`,
  );
  const present = new Set(colRows.map((r) => r.column_name));
  const missing = required.filter((c) => !present.has(c));
  if (missing.length > 0) {
    throw new Error(
      `Schema pre-flight FAILED — missing column(s): ${missing.join(', ')}. Run 'npm run migrate' first.`,
    );
  }

  const { rows: checkRows } = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'client_exclusions'::regclass AND contype = 'c'`,
  );
  const checks = new Set(checkRows.map((r) => r.conname));
  const requiredChecks = ['client_exclusions_kind_check', 'client_exclusions_at_least_one_side'];
  const missingChecks = requiredChecks.filter((c) => !checks.has(c));
  if (missingChecks.length > 0) {
    throw new Error(
      `Schema pre-flight FAILED — missing CHECK constraint(s): ${missingChecks.join(', ')}. Run 'npm run migrate' first.`,
    );
  }
}

async function preflightTarget(): Promise<{ db: string; host: string }> {
  const { rows } = await pool.query<{ db: string; host: string | null }>(
    `SELECT current_database() AS db, inet_server_addr()::text AS host`,
  );
  return { db: rows[0]!.db, host: rows[0]!.host ?? '<local socket>' };
}

function parseFile(filePath: string): ParsedRow[] {
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const rows: ParsedRow[] = [];
  const errors: Array<{ lineNo: number; message: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      const json = JSON.parse(line) as unknown;
      const parsed = rowSchema.parse(json);
      rows.push({ ...parsed, lineNo });
    } catch (err) {
      errors.push({ lineNo, message: err instanceof Error ? err.message : String(err) });
    }
  }

  if (errors.length > 0) {
    const summary = errors.map((e) => `  L${e.lineNo}: ${e.message}`).join('\n');
    throw new Error(`Validation FAILED on ${errors.length} row(s):\n${summary}`);
  }
  return rows;
}

async function diffAgainstExisting(rows: ParsedRow[]): Promise<{ insertable: ParsedRow[]; conflicts: ParsedRow[] }> {
  const clientIds = [...new Set(rows.map((r) => r.client_id))];
  const { rows: existing } = await pool.query<{ client_id: string; ticker: string; kind: string }>(
    `SELECT client_id, ticker, kind FROM client_exclusions WHERE client_id = ANY($1::varchar[])`,
    [clientIds],
  );
  const existingKeys = new Set(existing.map((r) => `${r.client_id}|${r.ticker}|${r.kind}`));

  const insertable: ParsedRow[] = [];
  const conflicts: ParsedRow[] = [];
  for (const row of rows) {
    const key = `${row.client_id}|${row.ticker}|${row.kind}`;
    if (existingKeys.has(key)) conflicts.push(row);
    else insertable.push(row);
  }
  return { insertable, conflicts };
}

function printPlan(rows: ParsedRow[], insertable: ParsedRow[], conflicts: ParsedRow[]): void {
  const distinctClients = new Set(rows.map((r) => r.client_id)).size;
  const dnbOnly = rows.filter((r) => r.no_buy && !r.no_sell).length;
  const dnsOnly = rows.filter((r) => !r.no_buy && r.no_sell).length;
  const blanket = rows.filter((r) => r.no_buy && r.no_sell).length;

  console.log(`\n--- Plan ---`);
  console.log(`Rows in file:       ${rows.length}`);
  console.log(`Would insert:       ${insertable.length}`);
  console.log(`Conflicts (skip):   ${conflicts.length}`);
  console.log(`Distinct clients:   ${distinctClients}`);
  console.log(`DNB-only:           ${dnbOnly}`);
  console.log(`DNS-only:           ${dnsOnly}`);
  console.log(`Blanket (DNB+DNS):  ${blanket}`);

  const byTicker = new Map<string, number>();
  for (const r of rows) byTicker.set(r.ticker, (byTicker.get(r.ticker) ?? 0) + 1);
  console.log(`\nBy ticker:`);
  for (const [t, n] of [...byTicker.entries()].sort()) {
    console.log(`  ${t.padEnd(8)} ${n}`);
  }

  if (conflicts.length > 0) {
    console.log(`\nConflicts (already in client_exclusions, would NOT re-insert):`);
    for (const c of conflicts) {
      console.log(`  L${c.lineNo} ${c.client_id} ${c.ticker} (${c.kind})`);
    }
  }

  console.log(`\nFirst 3 rows preview (exactly as they will INSERT):`);
  for (const r of rows.slice(0, 3)) {
    const reasonPreview = r.reason.length > 80 ? `${r.reason.slice(0, 80)}...` : r.reason;
    console.log(
      `  L${r.lineNo}: ${r.client_id}  ${r.ticker.padEnd(6)} ${r.kind.padEnd(8)} ${fmtSide(r.no_buy, r.no_sell)}  "${reasonPreview}"`,
    );
  }
}

async function commit(insertable: ParsedRow[]): Promise<void> {
  if (insertable.length === 0) {
    console.log(`\nNothing to insert (every row already exists). No transaction opened.`);
    return;
  }
  console.log(`\n=== COMMIT MODE — opening transaction ===`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of insertable) {
      await client.query(
        `INSERT INTO client_exclusions
           (client_id, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [row.client_id, row.ticker, row.kind, row.reason, row.no_buy, row.no_sell, null, BACKFILL_AUTHOR],
      );
    }
    await client.query('COMMIT');
    console.log(`Inserted ${insertable.length} row(s).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  console.log(`\n--- Post-commit verification ---`);
  const { rows: verify } = await pool.query<{
    client_id: string;
    ticker: string;
    kind: string;
    no_buy: boolean;
    no_sell: boolean;
    created_by: string | null;
    created_by_name: string;
  }>(
    `SELECT client_id, ticker, kind, no_buy, no_sell, created_by, created_by_name
       FROM client_exclusions
      WHERE created_by_name = $1
      ORDER BY client_id, kind, ticker`,
    [BACKFILL_AUTHOR],
  );
  console.log(`Rows attributed to "${BACKFILL_AUTHOR}": ${verify.length}`);
  for (const r of verify) {
    console.log(
      `  ${r.client_id}  ${r.ticker.padEnd(6)} ${r.kind.padEnd(8)} ${fmtSide(r.no_buy, r.no_sell)}  created_by=${r.created_by ?? 'NULL'}`,
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      commit: { type: 'boolean', default: false },
    },
  });

  if (!values.file) throw new Error('--file <path> is required');
  if (values.commit && values['dry-run']) throw new Error('--commit and --dry-run are mutually exclusive');
  const mode: 'dry-run' | 'commit' = values.commit ? 'commit' : 'dry-run';

  console.log(`\n=== Backfill Exclusions (mode: ${mode}) ===`);
  console.log(`File: ${values.file}`);

  const target = await preflightTarget();
  console.log(`Target: ${target.db} @ ${target.host}`);
  await preflightSchema();
  console.log(`Schema pre-flight: OK`);

  const rows = parseFile(values.file);
  console.log(`Parsed ${rows.length} valid row(s).`);

  const { insertable, conflicts } = await diffAgainstExisting(rows);
  printPlan(rows, insertable, conflicts);

  if (mode === 'dry-run') {
    console.log(`\n=== DRY RUN — no DB writes performed. Re-run with --commit to apply. ===`);
    return;
  }

  await commit(insertable);
  console.log(`\nDone.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
