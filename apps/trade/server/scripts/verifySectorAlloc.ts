/**
 * Dev verification of the sector/asset-class enrichment against REAL positions +
 * the REAL security_sector cache, without the full drift pipeline (which needs
 * the GCS snapshot). Builds each account's equity-sleeve holdings the way the
 * comparator does, then runs the actual getClassificationMap +
 * computeSectorAllocation used by applySectorEnrichment. Read-only.
 *   npx tsx scripts/verifySectorAlloc.ts
 */
import 'dotenv/config';
import pool from '../src/db/pool.js';
import { fetchAccountPositions } from '../src/services/warehouse.js';
import { classifySymbol } from '../src/data/instruments.js';
import { normalizeTicker } from '../src/data/sicToSector.js';
import { getClassificationMap } from '../src/services/securitySector.js';
import { computeSectorAllocation } from '../src/services/sectorAllocation.js';

async function main(): Promise<void> {
  const positions = await fetchAccountPositions();

  // Equity-sleeve holdings per account (symbol + % of total account), mirroring
  // the comparator's equityHoldings.
  const perAccount = new Map<string, { symbol: string; positionPct: number }[]>();
  const allNorm = new Set<string>();
  for (const [accountId, acct] of positions) {
    const denom = acct.totalEquity || 0;
    if (denom <= 0) continue;
    const holdings: { symbol: string; positionPct: number }[] = [];
    for (const [symbol, dollar] of Object.entries(acct.positionsBySymbol)) {
      if (classifySymbol(symbol) !== 'equity') continue;
      if (!(dollar > 0)) continue;
      holdings.push({ symbol, positionPct: (dollar / denom) * 100 });
      const n = normalizeTicker(symbol);
      if (n) allNorm.add(n);
    }
    if (holdings.length) perAccount.set(accountId, holdings);
  }

  const classification = await getClassificationMap(pool, [...allNorm]);

  let accountsWithAlloc = 0;
  let sumClassified = 0;
  const sample: Array<{ id: string; classified: number; slices: number; top: string }> = [];
  for (const [id, holdings] of perAccount) {
    const a = computeSectorAllocation(holdings, classification, normalizeTicker);
    if (a.slices.length === 0) continue;
    accountsWithAlloc += 1;
    sumClassified +=
      a.classifiedPct + a.unclassifiedPct > 0 ? a.classifiedPct / (a.classifiedPct + a.unclassifiedPct) : 0;
    if (sample.length < 4) {
      const top = a.slices
        .slice(0, 5)
        .map((s) => `${s.label} ${s.pct.toFixed(0)}%`)
        .join(', ');
      sample.push({ id, classified: a.classifiedPct, slices: a.slices.length, top });
    }
  }

  console.log('\n=== sector/asset-class enrichment vs REAL data ===');
  console.log(
    `accounts: ${positions.size} | with equity sleeve: ${perAccount.size} | with allocation: ${accountsWithAlloc}`,
  );
  console.log(`cache classification hits for held symbols: ${classification.size} / ${allNorm.size}`);
  console.log('\nsample accounts:');
  for (const s of sample) {
    console.log(`  ${s.id} — ${s.slices} slices, classified ${s.classified.toFixed(0)}% of account`);
    console.log(`      ${s.top}`);
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('verifySectorAlloc failed:', err);
  process.exit(1);
});
