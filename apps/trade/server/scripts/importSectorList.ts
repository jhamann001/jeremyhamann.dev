/**
 * Load an edited sector worklist (data/sector-list.csv from exportSectorList.ts)
 * back into the `security_sector` cache. Upserts every row whose `final_sector`
 * is a valid sector, with source='manual' and resolved=true — so manual answers
 * survive a future Massive re-run (the backfill skips resolved=true).
 *
 * Run from server/:
 *   npx tsx scripts/importSectorList.ts --dry-run        # validate, no writes
 *   npx tsx scripts/importSectorList.ts                  # apply
 *   npx tsx scripts/importSectorList.ts /tmp/x.csv       # custom path
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pool from '../src/db/pool.js';
import { SECTORS, type Sector } from '../src/data/sicToSector.js';
import { upsertSecuritySector } from '../src/services/securitySector.js';

const DRY_RUN = process.argv.includes('--dry-run');
const FILE = process.argv.find((a) => a.endsWith('.csv')) ?? path.resolve('data/sector-list.csv');
const VALID = new Set<string>(SECTORS.filter((s) => s !== 'Unclassified'));

/** Minimal RFC-4180 line parser (handles quoted cells with commas/quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function main(): Promise<void> {
  const text = await readFile(FILE, 'utf-8');
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  const header = rows.shift();
  if (!header) throw new Error('empty CSV');
  const col = (name: string) => header.indexOf(name);
  const iTicker = col('ticker');
  const iSrc = col('source_symbol');
  const iName = col('name');
  const iSic = col('sic_code');
  const iSicD = col('sic_description');
  const iFinal = col('final_sector');
  if (iTicker < 0 || iFinal < 0) throw new Error('CSV must have `ticker` and `final_sector` columns');

  let applied = 0;
  let skippedBlank = 0;
  const invalid: Array<{ ticker: string; value: string }> = [];

  for (const r of rows) {
    const ticker = (r[iTicker] ?? '').trim();
    const final = (r[iFinal] ?? '').trim();
    if (!ticker) continue;
    if (!final) {
      skippedBlank++;
      continue;
    }
    if (!VALID.has(final)) {
      invalid.push({ ticker, value: final });
      continue;
    }
    if (!DRY_RUN) {
      await upsertSecuritySector(pool, {
        ticker,
        sourceSymbol: (r[iSrc] ?? '').trim() || null,
        name: (r[iName] ?? '').trim() || null,
        sicCode: (r[iSic] ?? '').trim() || null,
        sicDescription: (r[iSicD] ?? '').trim() || null,
        sector: final as Sector,
        source: 'manual',
        resolved: true,
      });
    }
    applied++;
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}import from ${FILE}`);
  console.log(`  rows with valid final_sector: ${applied}${DRY_RUN ? ' (would upsert)' : ' upserted'}`);
  console.log(`  blank final_sector (skipped): ${skippedBlank}`);
  if (invalid.length) {
    console.log(`  INVALID sector values (${invalid.length}) — fix these, must be one of: ${[...VALID].join(' | ')}`);
    for (const x of invalid.slice(0, 15)) console.log(`    ${x.ticker}: "${x.value}"`);
  }

  await pool.end();
  process.exit(invalid.length ? 1 : 0);
}

main().catch((err) => {
  console.error('importSectorList failed:', err);
  process.exit(1);
});
