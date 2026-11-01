import type { Pool } from 'pg';
import type { AccountDriftStatus, ExclusionOverlapAccountSummary, ExclusionOverlapReport } from '@trade-request/shared';
import { getClientIdsByAccountUlid } from './warehouse.js';

interface SymbolDetail {
  symbol: string;
  positionPct: number;
  targetPct?: number;
  breach?: boolean;
}

interface AccountDriftDetails {
  symbolsWithTargets?: SymbolDetail[];
}

interface DriftRow {
  account_id: string;
  account_title: string;
  household_name: string;
  status: AccountDriftStatus;
  max_bucket_delta_pct: number | null;
  symbol_breach_count: number;
  details: AccountDriftDetails;
}

interface ExclusionRow {
  client_id: string;
  ticker: string;
  no_buy: boolean;
  no_sell: boolean;
}

interface AccountExclusionRow {
  account_id: string;
  ticker: string;
  no_buy: boolean;
  no_sell: boolean;
}

interface RestrictionRow {
  ticker: string;
  no_buy: boolean;
  no_sell: boolean;
}

interface RestrictionSide {
  no_buy: boolean;
  no_sell: boolean;
}

export type LockClass =
  'actionable' | 'locked_blanket' | 'locked_dnb_under' | 'locked_dns_over' | 'sign_mismatch_unlocked';

interface AnalyzeOptions {
  runDateLocal?: string;
}

interface LatestRunDateRow {
  latest: string | null;
}

const LOCKED_CLASSES = new Set<LockClass>(['locked_blanket', 'locked_dnb_under', 'locked_dns_over']);

const EMPTY_COUNTS: ExclusionOverlapReport['counts'] = {
  actionable: 0,
  locked_blanket: 0,
  locked_dnb_under: 0,
  locked_dns_over: 0,
  sign_mismatch_unlocked: 0,
};

function cloneEmptyCounts(): ExclusionOverlapReport['counts'] {
  return { ...EMPTY_COUNTS };
}

function toOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export function classifyBreach(
  positionPct: number,
  targetPct: number,
  exclusions: readonly RestrictionSide[],
): LockClass {
  if (exclusions.length === 0) return 'actionable';
  const noBuy = exclusions.some((e) => e.no_buy);
  const noSell = exclusions.some((e) => e.no_sell);
  if (noBuy && noSell) return 'locked_blanket';
  const isOver = positionPct > targetPct;
  if (noSell && isOver) return 'locked_dns_over';
  if (noBuy && !isOver) return 'locked_dnb_under';
  return 'sign_mismatch_unlocked';
}

async function resolveRunDate(pool: Pool, runDateLocal?: string): Promise<string | null> {
  if (runDateLocal) return runDateLocal;
  const { rows } = await pool.query<LatestRunDateRow>(
    `SELECT TO_CHAR(MAX(run_date_local), 'YYYY-MM-DD') AS latest FROM position_drift_accounts`,
  );
  return rows[0]?.latest ?? null;
}

function buildExclusionsByClient(rows: readonly ExclusionRow[]): Map<string, ExclusionRow[]> {
  const byClient = new Map<string, ExclusionRow[]>();
  for (const row of rows) {
    const list = byClient.get(row.client_id) ?? [];
    list.push(row);
    byClient.set(row.client_id, list);
  }
  return byClient;
}

function buildExclusionsByAccount(rows: readonly AccountExclusionRow[]): Map<string, AccountExclusionRow[]> {
  const byAccount = new Map<string, AccountExclusionRow[]>();
  for (const row of rows) {
    const list = byAccount.get(row.account_id) ?? [];
    list.push(row);
    byAccount.set(row.account_id, list);
  }
  return byAccount;
}

function buildExclusionsByTicker<T extends RestrictionRow>(rows: readonly T[]): Map<string, T[]> {
  const byTicker = new Map<string, T[]>();
  for (const row of rows) {
    const list = byTicker.get(row.ticker) ?? [];
    list.push(row);
    byTicker.set(row.ticker, list);
  }
  return byTicker;
}

function buildWorstAccounts(summaries: readonly ExclusionOverlapAccountSummary[]): ExclusionOverlapAccountSummary[] {
  return summaries
    .filter((s) => s.maxDelta !== null)
    .sort((a, b) => (b.maxDelta ?? 0) - (a.maxDelta ?? 0))
    .slice(0, 10);
}

export async function analyzeExclusionOverlapForRun(
  pool: Pool,
  options: AnalyzeOptions = {},
): Promise<ExclusionOverlapReport | null> {
  const runDateLocal = await resolveRunDate(pool, options.runDateLocal);
  if (!runDateLocal) return null;

  const { rows: driftRows } = await pool.query<DriftRow>(
    `SELECT
       account_id,
       account_title,
       household_name,
       status,
       max_bucket_delta_pct::float8 AS max_bucket_delta_pct,
       symbol_breach_count,
       details
     FROM position_drift_accounts
     WHERE run_date_local = $1::date
     ORDER BY max_bucket_delta_pct DESC NULLS LAST, account_id ASC`,
    [runDateLocal],
  );
  if (driftRows.length === 0) return null;

  const { rows: exclusionRows } = await pool.query<ExclusionRow>(
    `SELECT client_id, ticker, no_buy, no_sell FROM client_exclusions`,
  );
  const accountIds = driftRows.map((row) => row.account_id);
  const { rows: accountExclusionRows } = await pool.query<AccountExclusionRow>(
    `SELECT account_id, ticker, no_buy, no_sell
     FROM account_exclusions
     WHERE account_id = ANY($1::varchar[])`,
    [accountIds],
  );
  const exclusionsByClient = buildExclusionsByClient(exclusionRows);
  const exclusionsByAccount = buildExclusionsByAccount(accountExclusionRows);
  const clientIdsByAccountUlid = await getClientIdsByAccountUlid(accountIds);

  const counts = cloneEmptyCounts();
  let totalBreaches = 0;
  let totalAccounts = 0;
  let outAccounts = 0;

  const summaries: ExclusionOverlapAccountSummary[] = [];
  for (const row of driftRows) {
    totalAccounts++;
    if (row.status === 'out') outAccounts++;

    // Exclusion overlap is only meaningful for OUT-OF-TOLERANCE accounts. An
    // `uninvested` account (cash-heavy, not yet invested) has large cash-vs-
    // target "breaches" that aren't actionable and would otherwise dominate the
    // worst-accounts list by raw Δ; `no_template`/`in` accounts have nothing to
    // act on either. Skip them so the breach counts, locked-share, and the
    // account list all reflect real, actionable drift.
    if (row.status !== 'out') continue;

    const accountClientIds = clientIdsByAccountUlid[row.account_id] ?? [];
    const clientScopedExclusions = accountClientIds.flatMap((clientId) => exclusionsByClient.get(clientId) ?? []);
    const clientExclusionsByTicker = buildExclusionsByTicker(clientScopedExclusions);
    const accountExclusionsByTicker = buildExclusionsByTicker(exclusionsByAccount.get(row.account_id) ?? []);

    let lockedCount = 0;
    const symbolsWithTargets = row.details?.symbolsWithTargets ?? [];
    for (const symbol of symbolsWithTargets) {
      if (symbol.breach !== true || symbol.targetPct === undefined) continue;
      totalBreaches++;
      const matchingExclusions = [
        ...(clientExclusionsByTicker.get(symbol.symbol) ?? []),
        ...(accountExclusionsByTicker.get(symbol.symbol) ?? []),
      ];
      const lockClass = classifyBreach(symbol.positionPct, symbol.targetPct, matchingExclusions);
      counts[lockClass]++;
      if (LOCKED_CLASSES.has(lockClass)) lockedCount++;
    }

    summaries.push({
      accountId: row.account_id,
      accountTitle: row.account_title,
      household: row.household_name,
      status: row.status,
      maxDelta: row.max_bucket_delta_pct,
      breachCount: row.symbol_breach_count,
      lockedCount,
    });
  }

  const lockedTotal = counts.locked_blanket + counts.locked_dnb_under + counts.locked_dns_over;
  const lockedSharePct = totalBreaches > 0 ? toOneDecimal((lockedTotal / totalBreaches) * 100) : 0;

  return {
    runDateLocal,
    totalAccounts,
    outAccounts,
    totalExclusions: exclusionRows.length + accountExclusionRows.length,
    totalBreaches,
    lockedTotal,
    lockedSharePct,
    counts,
    worstAccounts: buildWorstAccounts(summaries),
  };
}
