/**
 * Phase 0 read-only analysis: how many of today's per-account drift breaches
 * are locked by client exclusions, and how does the lock break down across
 * DNB-only / DNS-only / blanket / sign-mismatched cases?
 *
 * Strictly read-only: SELECTs only, no INSERT/UPDATE/DELETE, no external
 * service calls beyond Warehouse's `getCachedClients` cache hit.
 *
 * Usage (with Cloud SQL Auth Proxy on :5433 and Warehouse env set):
 *   PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGDATABASE=trade_request \
 *   PGPASSWORD=... \
 *   WAREHOUSE_URL=... WAREHOUSE_API_KEY=... \
 *   WAREHOUSE_CONTACTS_QUESTION_ID=... \
 *   WAREHOUSE_INVESTMENTS_QUESTION_ID=... \
 *   WAREHOUSE_BALANCES_QUESTION_ID=... \
 *   npx tsx server/scripts/analyzeExclusionDriftOverlap.ts
 *
 * See ticket for the spike rationale; see ticket for the Phase 1 build
 * this analysis gates.
 */
import { Pool } from 'pg';
import { getClientIdsByAccountUlid } from '../src/services/warehouse.js';

interface SymbolDetail {
  symbol: string;
  bucket: 'cash' | 'fixed' | 'equity';
  positionPct: number;
  targetPct?: number;
  deltaPct?: number;
  breach?: boolean;
}

interface AccountDriftDetails {
  symbolsWithTargets: SymbolDetail[];
  equityHoldings: { symbol: string; positionPct: number }[];
}

interface DriftRow {
  account_id: string;
  account_title: string;
  household_name: string;
  status: string;
  max_bucket_delta_pct: number | null;
  worst_bucket: string | null;
  symbol_breach_count: number;
  total_value_usd: number;
  details: AccountDriftDetails;
}

interface ExclusionRow {
  client_id: string;
  ticker: string;
  kind: 'advisor' | 'client';
  no_buy: boolean;
  no_sell: boolean;
}

type LockClass = 'actionable' | 'locked_blanket' | 'locked_dnb_under' | 'locked_dns_over' | 'sign_mismatch_unlocked';

function classifyBreach(positionPct: number, targetPct: number, exclusions: readonly ExclusionRow[]): LockClass {
  if (exclusions.length === 0) return 'actionable';
  // Union semantic: across all clients on the account, OR the DNB / DNS sides.
  const noBuy = exclusions.some((e) => e.no_buy);
  const noSell = exclusions.some((e) => e.no_sell);
  if (noBuy && noSell) return 'locked_blanket';
  // Sign of position - target: positive = over (need to sell to fix),
  // negative = under (need to buy to fix). Settlement-cash synthetic
  // rows (`__SETTLEMENT_CASH__`) DO reach this function (they carry a
  // targetPct), but always classify as `actionable` because no advisor
  // or client exclusion is ever keyed on the synthetic ticker —
  // `exclusionsByTicker.get('__SETTLEMENT_CASH__')` returns `[]`, the
  // caller never enters this branch.
  const isOver = positionPct > targetPct;
  if (noSell && isOver) return 'locked_dns_over';
  if (noBuy && !isOver) return 'locked_dnb_under';
  return 'sign_mismatch_unlocked';
}

async function main(): Promise<void> {
  const pool = new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 2,
  });

  try {
    const { rows: latestRows } = await pool.query<{ latest: string | null }>(
      `SELECT TO_CHAR(MAX(run_date_local), 'YYYY-MM-DD') AS latest FROM position_drift_accounts`,
    );
    const latest = latestRows[0]?.latest ?? null;
    if (!latest) {
      console.log('No drift runs found. Run the nightly job first.');
      return;
    }

    const { rows: driftRows } = await pool.query<DriftRow>(
      `SELECT
         account_id, account_title, household_name, status,
         max_bucket_delta_pct::float8 AS max_bucket_delta_pct,
         worst_bucket, symbol_breach_count,
         total_value_usd::float8 AS total_value_usd,
         details
       FROM position_drift_accounts
       WHERE run_date_local = $1
       ORDER BY max_bucket_delta_pct DESC NULLS LAST`,
      [latest],
    );

    const { rows: exclusionRows } = await pool.query<ExclusionRow>(
      `SELECT client_id, ticker, kind, no_buy, no_sell FROM client_exclusions`,
    );

    const exclusionsByClient = new Map<string, ExclusionRow[]>();
    for (const e of exclusionRows) {
      const list = exclusionsByClient.get(e.client_id) ?? [];
      list.push(e);
      exclusionsByClient.set(e.client_id, list);
    }

    const accountIds = driftRows.map((r) => r.account_id);
    const clientsByAccount = await getClientIdsByAccountUlid(accountIds);

    const counts: Record<LockClass, number> = {
      actionable: 0,
      locked_blanket: 0,
      locked_dnb_under: 0,
      locked_dns_over: 0,
      sign_mismatch_unlocked: 0,
    };
    let totalBreaches = 0;
    let totalAccounts = 0;
    let outAccounts = 0;
    const accountSummaries: Array<{
      accountId: string;
      accountTitle: string;
      household: string;
      status: string;
      maxDelta: number | null;
      breachCount: number;
      lockedCount: number;
    }> = [];

    for (const row of driftRows) {
      totalAccounts++;
      if (row.status === 'out') outAccounts++;
      const clientIds = clientsByAccount[row.account_id] ?? [];
      const accountExclusions = clientIds.flatMap((cid) => exclusionsByClient.get(cid) ?? []);
      // Group exclusions by ticker so a per-symbol lookup is O(1).
      const exclusionsByTicker = new Map<string, ExclusionRow[]>();
      for (const e of accountExclusions) {
        const list = exclusionsByTicker.get(e.ticker) ?? [];
        list.push(e);
        exclusionsByTicker.set(e.ticker, list);
      }
      let lockedThisAccount = 0;
      for (const sym of row.details.symbolsWithTargets ?? []) {
        if (sym.breach !== true) continue;
        if (sym.targetPct === undefined) continue; // settlement-cash style row
        totalBreaches++;
        const matching = exclusionsByTicker.get(sym.symbol) ?? [];
        const cls = classifyBreach(sym.positionPct, sym.targetPct, matching);
        counts[cls]++;
        if (cls === 'locked_blanket' || cls === 'locked_dnb_under' || cls === 'locked_dns_over') {
          lockedThisAccount++;
        }
      }
      accountSummaries.push({
        accountId: row.account_id,
        accountTitle: row.account_title,
        household: row.household_name,
        status: row.status,
        maxDelta: row.max_bucket_delta_pct,
        breachCount: row.symbol_breach_count,
        lockedCount: lockedThisAccount,
      });
    }

    const lockedTotal = counts.locked_blanket + counts.locked_dnb_under + counts.locked_dns_over;
    const lockedPct = totalBreaches > 0 ? (lockedTotal / totalBreaches) * 100 : 0;

    console.log('────────── Phase 0 overlap report ──────────');
    console.log(`Run date: ${latest}`);
    console.log(`Accounts: ${totalAccounts} total, ${outAccounts} status=out`);
    console.log(`Distinct exclusion rows: ${exclusionRows.length}`);
    console.log(`Per-symbol breaches (breach=true with a target): ${totalBreaches}`);
    console.log('');
    console.log('Lock classification:');
    console.log(`  actionable               ${counts.actionable}`);
    console.log(`  locked_blanket           ${counts.locked_blanket}`);
    console.log(`  locked_dnb_under         ${counts.locked_dnb_under}`);
    console.log(`  locked_dns_over          ${counts.locked_dns_over}`);
    console.log(`  sign_mismatch_unlocked   ${counts.sign_mismatch_unlocked}`);
    console.log('');
    console.log(`Locked share of breaches: ${lockedTotal}/${totalBreaches} = ${lockedPct.toFixed(1)}%`);
    console.log('');
    console.log('────────── worst 10 accounts by max Δpp ──────────');
    const worstTen = accountSummaries
      .filter((s) => s.maxDelta !== null)
      .sort((a, b) => (b.maxDelta ?? 0) - (a.maxDelta ?? 0))
      .slice(0, 10);
    for (const s of worstTen) {
      const titleShort = s.accountTitle.length > 32 ? s.accountTitle.slice(0, 31) + '…' : s.accountTitle;
      console.log(
        `${(s.maxDelta ?? 0).toFixed(2).padStart(6)}%  ${s.status.padEnd(11)}  ${titleShort.padEnd(33)}  ${s.household.padEnd(28)}  breaches=${s.breachCount} locked=${s.lockedCount}`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
