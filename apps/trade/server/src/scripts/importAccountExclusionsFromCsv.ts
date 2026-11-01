/**
 * Imports account-level DNB/DNS restrictions from a CSV into `account_exclusions`.
 *
 * Usage:
 *   npx tsx src/scripts/importAccountExclusionsFromCsv.ts --file /path/to/restrictions.csv
 *   npx tsx src/scripts/importAccountExclusionsFromCsv.ts --file /path/to/restrictions.csv --commit
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import pool from '../db/pool.js';

type ExclusionKind = 'advisor' | 'client';

interface RawCsvRow {
  trading_account_no: string;
  restriction_type: string;
  value: string;
}

interface NormalizedRule {
  accountId: string;
  ticker: string;
  kind: ExclusionKind;
  noBuy: boolean;
  noSell: boolean;
}

interface ExistingRule {
  account_id: string;
  ticker: string;
  kind: ExclusionKind;
  no_buy: boolean;
  no_sell: boolean;
}

interface ImportSummary {
  csvRows: number;
  csvTickerEntries: number;
  uniqueRules: number;
  collapsedDuplicates: number;
  mergedSides: number;
  invalidRows: number;
  existingExactDuplicates: number;
  existingSideConflicts: number;
  readyToInsert: number;
  inserted: number;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const isEscapedQuote = inQuotes && line[i + 1] === '"';
      if (isEscapedQuote) {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function parseCsv(content: string): RawCsvRow[] {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const required = ['trading_account_no', 'restriction_type', 'value'];
  for (const key of required) {
    if (!header.includes(key)) {
      throw new Error(`CSV missing required column: ${key}`);
    }
  }

  return lines.slice(1).map((line, idx) => {
    const values = parseCsvLine(line);
    if (values.length !== header.length) {
      throw new Error(`CSV row ${idx + 2} has ${values.length} columns, expected ${header.length}`);
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]] = values[i] ?? '';
    }
    return {
      trading_account_no: row.trading_account_no.trim(),
      restriction_type: row.restriction_type.trim(),
      value: row.value.trim(),
    };
  });
}

function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase();
}

function sideFromRestrictionType(type: string): { noBuy: boolean; noSell: boolean } | null {
  if (type === 'buyTickerRestrictions') return { noBuy: true, noSell: false };
  if (type === 'sellTickerRestrictions') return { noBuy: false, noSell: true };
  return null;
}

function ruleKey(rule: Pick<NormalizedRule, 'accountId' | 'ticker' | 'kind'>): string {
  return `${rule.accountId}::${rule.ticker}::${rule.kind}`;
}

async function ensureAccountExclusionsTableExists(): Promise<void> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'account_exclusions'`,
  );
  if (rows.length === 0) {
    throw new Error('Table account_exclusions does not exist. Run migrations first.');
  }
}

function summarizeAndPrint(summary: ImportSummary): void {
  console.log('');
  console.log('Import summary');
  console.log(`- CSV rows parsed: ${summary.csvRows}`);
  console.log(`- CSV ticker entries parsed: ${summary.csvTickerEntries}`);
  console.log(`- Unique normalized rules: ${summary.uniqueRules}`);
  console.log(`- Collapsed duplicate rows: ${summary.collapsedDuplicates}`);
  console.log(`- Rules merged to blanket (DNB+DNS): ${summary.mergedSides}`);
  console.log(`- Invalid rows skipped: ${summary.invalidRows}`);
  console.log(`- Existing exact duplicates: ${summary.existingExactDuplicates}`);
  console.log(`- Existing side conflicts: ${summary.existingSideConflicts}`);
  console.log(`- Ready to insert: ${summary.readyToInsert}`);
  console.log(`- Inserted: ${summary.inserted}`);
  console.log('');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      kind: { type: 'string' },
      author: { type: 'string' },
      commit: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  const filePath = values.file;
  if (!filePath) {
    throw new Error('Missing --file. Example: --file /Users/me/Downloads/restrictions.csv');
  }

  const kindArg = (values.kind ?? 'client').toLowerCase();
  if (kindArg !== 'advisor' && kindArg !== 'client') {
    throw new Error(`Invalid --kind "${kindArg}". Use "advisor" or "client".`);
  }
  const kind = kindArg as ExclusionKind;
  const author = values.author?.trim() || 'Restriction CSV Import';
  const commit = values.commit === true;

  await ensureAccountExclusionsTableExists();

  const content = await readFile(filePath, 'utf8');
  const rows = parseCsv(content);

  const normalizedByKey = new Map<string, NormalizedRule>();
  let csvTickerEntries = 0;
  let collapsedDuplicates = 0;
  let mergedSides = 0;
  let invalidRows = 0;

  for (const row of rows) {
    if (!row.trading_account_no) {
      invalidRows++;
      continue;
    }
    const side = sideFromRestrictionType(row.restriction_type);
    if (!side) {
      invalidRows++;
      continue;
    }

    let tickers: unknown;
    try {
      tickers = JSON.parse(row.value);
    } catch {
      invalidRows++;
      continue;
    }
    if (!Array.isArray(tickers)) {
      invalidRows++;
      continue;
    }

    for (const tickerRaw of tickers) {
      if (typeof tickerRaw !== 'string') {
        invalidRows++;
        continue;
      }
      const ticker = normalizeTicker(tickerRaw);
      if (!ticker) {
        invalidRows++;
        continue;
      }
      csvTickerEntries++;

      const candidate: NormalizedRule = {
        accountId: row.trading_account_no,
        ticker,
        kind,
        noBuy: side.noBuy,
        noSell: side.noSell,
      };
      const key = ruleKey(candidate);
      const existing = normalizedByKey.get(key);
      if (!existing) {
        normalizedByKey.set(key, candidate);
        continue;
      }

      collapsedDuplicates++;
      const nextNoBuy = existing.noBuy || candidate.noBuy;
      const nextNoSell = existing.noSell || candidate.noSell;
      if ((nextNoBuy !== existing.noBuy || nextNoSell !== existing.noSell) && nextNoBuy && nextNoSell) {
        mergedSides++;
      }
      existing.noBuy = nextNoBuy;
      existing.noSell = nextNoSell;
    }
  }

  const normalizedRules = [...normalizedByKey.values()];
  const accountIds = [...new Set(normalizedRules.map((r) => r.accountId))];

  const existingMap = new Map<string, ExistingRule>();
  if (accountIds.length > 0) {
    const { rows: existingRows } = await pool.query<ExistingRule>(
      `SELECT account_id, ticker, kind, no_buy, no_sell
       FROM account_exclusions
       WHERE account_id = ANY($1::varchar[])
         AND kind = $2`,
      [accountIds, kind],
    );
    for (const row of existingRows) {
      existingMap.set(`${row.account_id}::${row.ticker}::${row.kind}`, row);
    }
  }

  const toInsert: NormalizedRule[] = [];
  let existingExactDuplicates = 0;
  let existingSideConflicts = 0;

  for (const rule of normalizedRules) {
    const existing = existingMap.get(ruleKey(rule));
    if (!existing) {
      toInsert.push(rule);
      continue;
    }

    if (existing.no_buy === rule.noBuy && existing.no_sell === rule.noSell) {
      existingExactDuplicates++;
      continue;
    }

    existingSideConflicts++;
  }

  let inserted = 0;
  if (commit && toInsert.length > 0) {
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      for (const rule of toInsert) {
        const result = await dbClient.query(
          `INSERT INTO account_exclusions (account_id, ticker, kind, reason, no_buy, no_sell, created_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (account_id, ticker, kind) DO NOTHING`,
          [rule.accountId, rule.ticker, rule.kind, `Imported from ${filePath}`, rule.noBuy, rule.noSell, author],
        );
        inserted += result.rowCount ?? 0;
      }
      await dbClient.query('COMMIT');
    } catch (err) {
      try {
        await dbClient.query('ROLLBACK');
      } catch {
        // rollback best-effort
      }
      throw err;
    } finally {
      dbClient.release();
    }
  }

  summarizeAndPrint({
    csvRows: rows.length,
    csvTickerEntries,
    uniqueRules: normalizedRules.length,
    collapsedDuplicates,
    mergedSides,
    invalidRows,
    existingExactDuplicates,
    existingSideConflicts,
    readyToInsert: toInsert.length,
    inserted,
  });

  if (existingSideConflicts > 0) {
    console.log('Conflicts detected (same account+ticker+kind exists with different sides).');
    console.log('No updates were applied to conflicting rows in this script.');
  }

  if (!commit) {
    console.log('Dry-run only. Re-run with --commit to insert rows.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
