/**
 * Dev-only: run the full drift check against the dev DB and report whether the
 * new sector/asset-class enrichment landed in the persisted `details` JSONB.
 * Read-mostly (writes position_drift_accounts in dev). Run from server/:
 *   npx tsx scripts/runDriftDev.ts
 */
import 'dotenv/config';
import pool from '../src/db/pool.js';
import { runDriftCheck } from '../src/services/registryDriftRunner.js';

async function main(): Promise<void> {
  const summary = await runDriftCheck({ pool });
  console.log('\n=== drift run summary ===');
  console.log(JSON.stringify(summary, null, 2).slice(0, 800));

  const { rows: counts } = await pool.query<{ total: string; with_alloc: string }>(
    `SELECT count(*)::text total,
            count(*) FILTER (WHERE details ? 'sectorAllocation')::text with_alloc
       FROM position_drift_accounts
      WHERE run_date_local = (SELECT max(run_date_local) FROM position_drift_accounts)`,
  );
  console.log('\n=== latest run: accounts with sectorAllocation ===');
  console.log(counts[0]);

  const { rows: samples } = await pool.query<{ account_id: string; sa: unknown }>(
    `SELECT account_id, details->'sectorAllocation' AS sa
       FROM position_drift_accounts
      WHERE run_date_local = (SELECT max(run_date_local) FROM position_drift_accounts)
        AND details ? 'sectorAllocation'
        AND jsonb_array_length(details->'sectorAllocation'->'slices') > 0
      ORDER BY jsonb_array_length(details->'sectorAllocation'->'slices') DESC
      LIMIT 3`,
  );
  console.log('\n=== sample account allocations (most diverse) ===');
  for (const r of samples) {
    const sa = r.sa as { slices: { label: string; kind: string; pct: number }[]; classifiedPct: number };
    console.log(`\n  account ${r.account_id} — classified ${sa.classifiedPct}%`);
    for (const s of sa.slices.slice(0, 8)) console.log(`    ${s.label.padEnd(24)} ${s.kind.padEnd(12)} ${s.pct}%`);
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('runDriftDev failed:', err);
  process.exit(1);
});
