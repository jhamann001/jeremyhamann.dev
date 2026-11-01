/**
 * One-off: dollar-weight coverage of the sector cache against current holdings.
 * Aggregates trade-date market value per equity symbol across all accounts,
 * then buckets those dollars into sectored / unclassified / missing using the
 * local `security_sector` cache. Read-only. Run from server/:
 *   npx tsx scripts/sectorCoverage.ts
 */
import 'dotenv/config';
import pool from '../src/db/pool.js';
import { fetchAccountPositions } from '../src/services/warehouse.js';
import { classifySymbol } from '../src/data/instruments.js';
import { normalizeTicker } from '../src/data/sicToSector.js';

async function main(): Promise<void> {
  const accounts = await fetchAccountPositions();

  // Aggregate market value per raw symbol across every account.
  const valueBySymbol = new Map<string, number>();
  for (const acct of accounts.values()) {
    for (const [sym, val] of Object.entries(acct.positionsBySymbol)) {
      if (!Number.isFinite(val)) continue;
      valueBySymbol.set(sym, (valueBySymbol.get(sym) ?? 0) + val);
    }
  }

  // Load the cache: normalized ticker -> {sector, resolved}.
  const { rows } = await pool.query<{ ticker: string; sector: string | null; resolved: boolean }>(
    'SELECT ticker, sector, asset_class, resolved FROM security_sector',
  );
  const cache = new Map(
    rows.map((r) => [r.ticker, { sector: r.sector, assetClass: r.asset_class, resolved: r.resolved }]),
  );

  let equityTotal = 0;
  let sectored = 0; // individual equities with a GICS sector
  let fundClassified = 0; // ETFs/funds with an asset class
  let missing = 0; // neither
  const missingSamples: Array<{ sym: string; val: number }> = [];
  const unclassifiedSamples: Array<{ sym: string; val: number }> = [];

  for (const [sym, val] of valueBySymbol) {
    if (classifySymbol(sym) !== 'equity') continue; // sector analysis is equity-bucket only
    if (val <= 0) continue;
    equityTotal += val;

    const norm = normalizeTicker(sym);
    const hit = norm ? cache.get(norm) : undefined;
    if (hit && hit.sector && hit.sector !== 'Unclassified') {
      sectored += val;
    } else if (hit && hit.assetClass) {
      fundClassified += val;
    } else {
      missing += val;
      missingSamples.push({ sym, val });
    }
  }

  const classified = sectored + fundClassified;
  const pct = (n: number) => `${((n / equityTotal) * 100).toFixed(1)}%`;
  const usd = (n: number) => `$${(n / 1_000_000).toFixed(1)}M`;

  console.log('\n=== CLASSIFICATION DOLLAR-WEIGHT COVERAGE (equity-bucket holdings, market value) ===');
  console.log(`equity symbols held:   ${[...valueBySymbol].filter(([s]) => classifySymbol(s) === 'equity').length}`);
  console.log(`equity market value:   ${usd(equityTotal)}`);
  console.log(`  classified TOTAL:    ${usd(classified)}  (${pct(classified)})`);
  console.log(`    - stocks (sector): ${usd(sectored)}  (${pct(sectored)})`);
  console.log(`    - funds (asset cls): ${usd(fundClassified)}  (${pct(fundClassified)})`);
  console.log(`  still unclassified:  ${usd(missing)}  (${pct(missing)})`);

  void unclassifiedSamples;
  missingSamples.sort((a, b) => b.val - a.val);
  console.log('\n  top still-unclassified by $ (3 no-category funds + stragglers + funds not yet in cache):');
  for (const m of missingSamples.slice(0, 15)) console.log(`    ${m.sym.padEnd(8)} ${usd(m.val)}`);

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('sectorCoverage failed:', err);
  process.exit(1);
});
