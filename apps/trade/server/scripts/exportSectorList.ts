/**
 * Export the editable sector worklist: every held equity symbol joined to the
 * current `security_sector` cache, sorted by held market value (biggest unfilled
 * positions first). Fill the `final_sector` column for blank/Unclassified rows,
 * then load it back with scripts/importSectorList.ts to ship.
 *
 * Read-only against the DB + Warehouse. Run from server/:
 *   npx tsx scripts/exportSectorList.ts            # -> data/sector-list.csv
 *   npx tsx scripts/exportSectorList.ts /tmp/x.csv # custom path
 */
import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import pool from '../src/db/pool.js';
import { fetchAccountPositions } from '../src/services/warehouse.js';
import { classifySymbol } from '../src/data/instruments.js';
import { normalizeTicker, SECTORS } from '../src/data/sicToSector.js';

const OUT = process.argv[2] ?? path.resolve('data/sector-list.csv');

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const accounts = await fetchAccountPositions();
  const valueBySymbol = new Map<string, number>();
  for (const acct of accounts.values()) {
    for (const [sym, val] of Object.entries(acct.positionsBySymbol)) {
      if (!Number.isFinite(val) || val <= 0) continue;
      if (classifySymbol(sym) !== 'equity') continue;
      valueBySymbol.set(sym, (valueBySymbol.get(sym) ?? 0) + val);
    }
  }

  const { rows } = await pool.query<{
    ticker: string;
    name: string | null;
    sic_code: string | null;
    sic_description: string | null;
    sector: string | null;
    resolved: boolean;
  }>('SELECT ticker, name, sic_code, sic_description, sector, resolved FROM security_sector');
  const cache = new Map(rows.map((r) => [r.ticker, r]));

  const out: Array<Record<string, unknown>> = [];
  for (const [sym, val] of valueBySymbol) {
    const norm = normalizeTicker(sym) ?? '';
    const hit = norm ? cache.get(norm) : undefined;
    const haveSector = hit?.resolved && hit.sector && hit.sector !== 'Unclassified';
    const status = haveSector ? 'sectored' : hit?.resolved ? 'unclassified' : hit ? 'unresolved' : 'missing';
    out.push({
      source_symbol: sym,
      ticker: norm,
      name: hit?.name ?? '',
      sic_code: hit?.sic_code ?? '',
      sic_description: hit?.sic_description ?? '',
      current_sector: haveSector ? hit!.sector : '',
      // pre-filled where known; FILL THIS for blanks, then import.
      final_sector: haveSector ? hit!.sector : '',
      status,
      held_market_value: Math.round(val),
    });
  }
  out.sort((a, b) => (b.held_market_value as number) - (a.held_market_value as number));

  const headers = [
    'source_symbol',
    'ticker',
    'name',
    'sic_code',
    'sic_description',
    'current_sector',
    'final_sector',
    'status',
    'held_market_value',
  ];
  const lines = [headers.join(',')];
  for (const r of out) lines.push(headers.map((h) => csvCell(r[h])).join(','));

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, lines.join('\n') + '\n', 'utf-8');

  const filled = out.filter((r) => r.final_sector).length;
  const blank = out.length - filled;
  const blankVal = out.filter((r) => !r.final_sector).reduce((s, r) => s + (r.held_market_value as number), 0);
  console.log(`\nWrote ${out.length} held equity symbols -> ${OUT}`);
  console.log(`  pre-filled (sectored): ${filled}`);
  console.log(`  NEEDS final_sector:    ${blank}  ($${(blankVal / 1_000_000).toFixed(1)}M held)`);
  console.log(`\nValid sector values for the final_sector column:`);
  console.log(`  ${SECTORS.filter((s) => s !== 'Unclassified').join(' | ')}`);
  console.log(`(rows are sorted by held_market_value desc — fill from the top for max $ coverage per edit)`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('exportSectorList failed:', err);
  process.exit(1);
});
