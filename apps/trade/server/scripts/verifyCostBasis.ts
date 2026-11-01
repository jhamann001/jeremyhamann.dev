/**
 * Dev verification harness for the cost-basis tax layer. Read-only — does NOT
 * write to the DB. Exercises the exact live fetch + enrichment path the nightly
 * drift runner uses, against the real Warehouse, so we can validate before prod.
 *
 * Run from server/:  npx tsx scripts/verifyCostBasis.ts
 *
 * Requires a REAL WAREHOUSE_API_KEY in env (server/.env). The placeholder key
 * yields 401s — which is itself a useful signal (the dev app has never reached
 * Warehouse). The script reports PASS/FAIL per step; the realized + ownership
 * steps specifically prove whether the API key has /api/dataset (native SQL)
 * permission — the one unverified prod dependency.
 */
import 'dotenv/config';
import {
  fetchAccountPositions,
  fetchCostBasisData,
  fetchRealizedGainsYtd,
  fetchOwnershipTypes,
  isWarehouseQueryConfigured,
} from '../src/services/warehouse.js';
import { enrichAccountsWithCostBasis } from '../src/services/costBasisEnrichment.js';
import { evaluateCostBasisFreshness } from '../src/services/costBasisFreshness.js';
import { isTaxableAccount } from '../src/services/householdConfig.js';

function line() {
  console.log('─'.repeat(72));
}
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  process.stdout.write(`▶ ${name} … `);
  try {
    const out = await fn();
    console.log('PASS');
    return out;
  } catch (err) {
    console.log('FAIL');
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function main() {
  line();
  console.log('Cost-basis tax layer — dev verification (read-only)');
  console.log(`  isWarehouseQueryConfigured: ${isWarehouseQueryConfigured()}`);
  line();

  // 1. Open lots (saved questions 6304/6172) → merge + freshness.
  const cb = await step('fetchCostBasisData (open-lot cards 6304/6172, merge)', () => fetchCostBasisData());
  if (cb) {
    console.log(`    lots=${cb.lots.length}  fullRefresh=${cb.fullRefreshLatest}  daily=${cb.dailyRefreshLatest}`);
    console.log(`    transferExternal lots=${cb.lots.filter((l) => l.isTransferExternal).length}`);
    const fresh = evaluateCostBasisFreshness({
      fullRefreshLatest: cb.fullRefreshLatest,
      dailyRefreshLatest: cb.dailyRefreshLatest,
      fullGlueRunLatest: cb.fullGlueRunLatest,
      dailyGlueRunLatest: cb.dailyGlueRunLatest,
      asOf: new Date(),
    });
    console.log(`    freshness=${fresh.level}  (${fresh.message})`);
  }

  // 2. Realized YTD — native /api/dataset query (THE prod-permission test).
  const realized = await step('fetchRealizedGainsYtd (native /api/dataset)', () => fetchRealizedGainsYtd());
  if (realized) {
    let total = 0;
    for (const r of realized.values()) total += r.realizedGainYtdUsd;
    console.log(`    accounts=${realized.size}  totalRealizedYtd=$${Math.round(total).toLocaleString()}`);
  }

  // 3. Ownership types — native /api/dataset query.
  const ownership = await step('fetchOwnershipTypes (native /api/dataset)', () => fetchOwnershipTypes());
  if (ownership) {
    const counts: Record<string, number> = {};
    for (const v of ownership.values()) counts[v] = (counts[v] ?? 0) + 1;
    console.log(`    accounts=${ownership.size}  byType=${JSON.stringify(counts)}`);
  }

  // 4. Positions → enrichment join (sanity on real data, no DB write).
  const positions = await step('fetchAccountPositions', () => fetchAccountPositions());
  if (positions && cb) {
    const enrichment = enrichAccountsWithCostBasis(positions, cb.lots);
    let enriched = 0;
    let withTransferIn = 0;
    let transitionCandidates = 0;
    const samples: string[] = [];
    for (const [accountId, e] of enrichment) {
      if (e.symbols.length === 0) continue;
      enriched += 1;
      if (e.transferInValueUsd > 0) withTransferIn += 1;
      const ownershipType = ownership?.get(accountId);
      const taxable = isTaxableAccount(ownershipType, undefined);
      // Transition candidate would also require status==='no_template' in the
      // runner; here we just exercise the taxable gate against real ownership.
      const wouldFlag = taxable && e.transferInPct >= 50;
      if (wouldFlag) transitionCandidates += 1;
      if (samples.length < 5 && e.unrealizedGainUsd !== 0) {
        samples.push(
          `      ${accountId.slice(-6)}  unreal=$${Math.round(e.unrealizedGainUsd).toLocaleString()}  ` +
            `xferIn=${e.transferInPct.toFixed(0)}%  ownership=${ownershipType ?? '?'}  taxable=${taxable}`,
        );
      }
    }
    console.log(
      `    enrichedAccounts=${enriched}  withTransferIn=${withTransferIn}  taxable+xfer≥50%=${transitionCandidates}`,
    );
    console.log('    samples:');
    samples.forEach((s) => console.log(s));
  }

  line();
  console.log('Done. (No DB writes.)');
  line();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
