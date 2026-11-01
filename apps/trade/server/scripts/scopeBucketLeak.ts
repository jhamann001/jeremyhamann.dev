/**
 * Scope the bond/MMF-ETF bucket leak: held symbols that classifySymbol() routes
 * to 'equity' by default, but the security_sector cache says are really a
 * fixed-income or cash fund (asset_class → fixed/cash). Shows the $ impact and
 * how many accounts shift, so we can see the blast radius before changing the
 * comparator's bucket math. Read-only.
 *   npx tsx scripts/scopeBucketLeak.ts
 */
import 'dotenv/config';
import pool from '../src/db/pool.js';
import { fetchAccountPositions } from '../src/services/warehouse.js';
import { classifySymbol } from '../src/data/instruments.js';
import { normalizeTicker } from '../src/data/sicToSector.js';
import { getClassificationMap } from '../src/services/securitySector.js';

async function main(): Promise<void> {
  const positions = await fetchAccountPositions();

  // Held equity-bucket symbols + their dollars + which accounts hold them.
  const valueBySymbol = new Map<string, number>();
  const accountsBySymbol = new Map<string, Set<string>>();
  const norms = new Set<string>();
  for (const [accountId, acct] of positions) {
    for (const [sym, dollar] of Object.entries(acct.positionsBySymbol)) {
      if (classifySymbol(sym) !== 'equity') continue; // only the default-to-equity path can leak
      if (!(dollar > 0)) continue;
      valueBySymbol.set(sym, (valueBySymbol.get(sym) ?? 0) + dollar);
      (accountsBySymbol.get(sym) ?? accountsBySymbol.set(sym, new Set()).get(sym)!).add(accountId);
      const n = normalizeTicker(sym);
      if (n) norms.add(n);
    }
  }

  const cls = await getClassificationMap(pool, [...norms]);

  // Leak = classifySymbol says equity, cache says fixed/cash.
  const leaks: Array<{ sym: string; bucket: string; assetClass: string; usd: number; accounts: number }> = [];
  const movedAccounts = new Set<string>();
  let toFixed = 0;
  let toCash = 0;
  for (const [sym, usd] of valueBySymbol) {
    const n = normalizeTicker(sym);
    const hit = n ? cls.get(n) : undefined;
    if (hit?.kind === 'fund' && (hit.bucket === 'fixed' || hit.bucket === 'cash')) {
      leaks.push({
        sym,
        bucket: hit.bucket,
        assetClass: hit.assetClass ?? '?',
        usd,
        accounts: accountsBySymbol.get(sym)?.size ?? 0,
      });
      for (const a of accountsBySymbol.get(sym) ?? []) movedAccounts.add(a);
      if (hit.bucket === 'fixed') toFixed += usd;
      else toCash += usd;
    }
  }

  leaks.sort((a, b) => b.usd - a.usd);
  const usd = (n: number) => `$${(n / 1_000_000).toFixed(2)}M`;
  console.log('\n=== BOND/MMF-ETF BUCKET LEAK (equity → should be fixed/cash) ===');
  console.log(`leaking symbols: ${leaks.length} | accounts affected: ${movedAccounts.size} / ${positions.size}`);
  console.log(
    `$ moving equity → fixed: ${usd(toFixed)} | equity → cash: ${usd(toCash)} | total: ${usd(toFixed + toCash)}`,
  );
  console.log('\n  ticker     →bucket   asset class           held $        #accts');
  for (const l of leaks.slice(0, 40)) {
    console.log(
      `  ${l.sym.padEnd(9)} ${l.bucket.padEnd(8)} ${l.assetClass.padEnd(20)} ${usd(l.usd).padStart(9)}   ${l.accounts}`,
    );
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('scopeBucketLeak failed:', err);
  process.exit(1);
});
