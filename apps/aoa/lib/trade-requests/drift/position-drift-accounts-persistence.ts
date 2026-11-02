import type { Pool, PoolClient } from '@/lib/trade-requests/pg-compat';
import logger from '@/lib/trade-requests/log';
import type { DriftTables } from '@/lib/trade-requests/drift/targets';
import type { AccountDriftResult } from '@/lib/trade-requests/drift/position-drift-accounts';
import type {
  AccountDriftCoverage,
  AccountDriftHistoryRow,
  AccountDriftRunDetail,
  AccountDriftRunRow,
  AccountDriftStatus,
  CostBasisFreshnessSummary,
} from '@/lib/trade-requests/shared-types';

/**
 * v2 per-account drift persistence. Mirrors `registryDriftRunner.persistDriftRows`
 * (one row per (run_date_local, account_id), ON CONFLICT DO UPDATE refreshing
 * `run_started_at` so `fetchAccountDriftHistory`'s latest-per-date dedup keeps
 * working) but targets the new `position_drift_accounts` table.
 *
 * The schema version on every row is `ACCOUNT_DRIFT_SCHEMA_VERSION`; the
 * column is NOT NULL with no default, so callers MUST pass `schemaVersion`
 * on every INSERT (B1 regression guard from the v1 review).
 */

export const ACCOUNT_DRIFT_SCHEMA_VERSION = 1;

const HISTORY_DEFAULT_DAYS = 30;
// 180 rather than 90 so the window can reach the first drift runs (v1
// 2026-05-13, v2 2026-05-14) — at 90 the history stopped ~8 days short of
// launch. Rows are never pruned, so the data has always been there; only the
// query window hid it. The DEFAULT stays 30: the v2 tab holds the whole
// window in memory and refilters client-side, so a long window is opt-in.
const HISTORY_MAX_DAYS = 180;
/**
 * Sized for the per-account scale: ~200 active accounts × 90 days = ~18k
 * rows in steady state. 50k leaves headroom for ~6 months of history
 * before truncation kicks in. The v1 cap (5k) was sized for one row per
 * household per day; per-account scale needs more headroom.
 */
const HISTORY_ROW_CAP = 50_000;

export function clampHistoryDays(rawDays: unknown): number {
  const parsed = typeof rawDays === 'string' ? parseInt(rawDays, 10) : typeof rawDays === 'number' ? rawDays : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= HISTORY_MAX_DAYS ? parsed : HISTORY_DEFAULT_DAYS;
}

export interface PersistAccountDriftRowsInput {
  pool: Pool;
  runDateLocal: string;
  runStartedAt: Date;
  snapshotSource: string;
  snapshotAsOf: string | null;
  tolerancePct: number;
  uninvestedCashThresholdPct: number;
  /**
   * REQUIRED — the `schema_version` column on `position_drift_accounts` is
   * NOT NULL with no default. Callers pass `ACCOUNT_DRIFT_SCHEMA_VERSION`
   * (B1 fix from the v1 review: missing this argument made the INSERT fail
   * with SQLSTATE 23502).
   */
  schemaVersion: number;
  accounts: readonly AccountDriftResult[];
}

interface PersistedRowIdentity {
  account_id: string;
  inserted: boolean;
}

function deriveCoverage(account: AccountDriftResult): AccountDriftCoverage {
  if (account.unmapped) return 'unmapped';
  if (account.templateMissing) return 'positions_only';
  if (account.totalValue <= 0) return 'template_only';
  return 'both';
}

export async function persistAccountDriftRows(input: PersistAccountDriftRowsInput, target: DriftTables): Promise<Set<string>> {
  const {
    pool,
    runDateLocal,
    runStartedAt,
    snapshotSource,
    snapshotAsOf,
    tolerancePct,
    uninvestedCashThresholdPct,
    schemaVersion,
    accounts,
  } = input;

  const inserted = new Set<string>();
  try {
    await pool.transaction(async (client: PoolClient) => {
      for (const account of accounts) {
        const coverage = deriveCoverage(account);
        const { rows } = await client.query<PersistedRowIdentity>(
          `INSERT INTO ${target.accountRuns} (
             run_date_local,
             run_started_at,
             account_id,
             account_title,
             household_name,
             coverage,
             status,
             total_value_usd,
             position_cash_pct,
             position_fixed_pct,
             position_equity_pct,
             template_cash_pct,
             template_fixed_pct,
             template_equity_pct,
             max_bucket_delta_pct,
             worst_bucket,
             symbol_breach_count,
             tolerance_pct,
             uninvested_cash_threshold_pct,
             schema_version,
             snapshot_source,
             snapshot_as_of,
             details
           )
           VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::timestamptz, $23::jsonb)
           ON CONFLICT (run_date_local, account_id) DO UPDATE
             SET run_started_at = EXCLUDED.run_started_at,
                 account_title = EXCLUDED.account_title,
                 household_name = EXCLUDED.household_name,
                 coverage = EXCLUDED.coverage,
                 status = EXCLUDED.status,
                 total_value_usd = EXCLUDED.total_value_usd,
                 position_cash_pct = EXCLUDED.position_cash_pct,
                 position_fixed_pct = EXCLUDED.position_fixed_pct,
                 position_equity_pct = EXCLUDED.position_equity_pct,
                 template_cash_pct = EXCLUDED.template_cash_pct,
                 template_fixed_pct = EXCLUDED.template_fixed_pct,
                 template_equity_pct = EXCLUDED.template_equity_pct,
                 max_bucket_delta_pct = EXCLUDED.max_bucket_delta_pct,
                 worst_bucket = EXCLUDED.worst_bucket,
                 symbol_breach_count = EXCLUDED.symbol_breach_count,
                 tolerance_pct = EXCLUDED.tolerance_pct,
                 uninvested_cash_threshold_pct = EXCLUDED.uninvested_cash_threshold_pct,
                 schema_version = EXCLUDED.schema_version,
                 snapshot_source = EXCLUDED.snapshot_source,
                 snapshot_as_of = EXCLUDED.snapshot_as_of,
                 details = EXCLUDED.details
           RETURNING account_id, (xmax = 0) AS inserted`,
          [
            runDateLocal,
            runStartedAt,
            account.accountId,
            account.accountTitle,
            account.household,
            coverage,
            account.status,
            account.totalValue,
            account.details.buckets.cash.positionPct,
            account.details.buckets.fixed.positionPct,
            account.details.buckets.equity.positionPct,
            account.details.buckets.cash.templatePct,
            account.details.buckets.fixed.templatePct,
            account.details.buckets.equity.templatePct,
            account.maxBucketDeltaPct,
            account.worstBucket,
            account.symbolBreachCount,
            tolerancePct,
            uninvestedCashThresholdPct,
            schemaVersion,
            snapshotSource,
            snapshotAsOf,
            JSON.stringify(account.details),
          ],
        );
        if (rows.length > 0 && rows[0].inserted === true) {
          inserted.add(account.accountId);
        }
      }
    });
  } catch (err) {
    // Prisma has already rolled the transaction back; log and rethrow as the standalone service did.
    {
      logger.error(
        {
          event: 'drift_v2_run_persistence_failed',
          runDateLocal,
          message: err instanceof Error ? err.message : String(err),
        },
        'drift v2 persistence failed, transaction rolled back',
      );
      throw err;
    }
  }

  return inserted;
}

interface HistoryRowSql {
  run_date_local: string;
  account_id: string;
  account_title: string;
  household_name: string;
  status: AccountDriftStatus;
  worst_bucket: 'cash' | 'fixed' | 'equity' | null;
  /**
   * `null` for rows with no allocation target to measure against —
   * `no_template` and the no-template variant of `negligible`. Postgres'
   * default ORDER BY behavior is NULLS LAST under DESC, which is what we
   * want — these rows sort to the bottom of the table. (`template_invalid`
   * is NOT null: it keeps its computed delta so the magnitude stays
   * inspectable.)
   */
  max_bucket_delta_pct: string | null;
  symbol_breach_count: number;
  total_value_usd: string;
  coverage: AccountDriftCoverage;
  snapshot_source: string;
  snapshot_as_of: string | null;
  schema_version: number;
  // Cost-basis tax layer, extracted from the `details` JSONB (null when the
  // feed was unconfigured at run time).
  unrealized_gain_usd: string | null;
  realized_gain_ytd_usd: string | null;
  transfer_in_pct: string | null;
  taxable: boolean | null;
  transition_candidate: boolean | null;
  transition_confirmed: boolean | null;
  template_name: string | null;
  template_total_pct: string | null;
  cost_basis_freshness: CostBasisFreshnessSummary | null;
}

// Shared projection of the cost-basis fields out of `details` JSONB, reused by
// the history and detail queries. `details->'tax'->>k` yields text; the
// freshness object comes back as parsed JSON from pg.
const COST_BASIS_SELECT = `
       (r.details->'tax'->>'unrealizedGainUsd')   AS unrealized_gain_usd,
       (r.details->'tax'->>'realizedGainYtdUsd')  AS realized_gain_ytd_usd,
       (r.details->'tax'->>'transferInPct')       AS transfer_in_pct,
       (r.details->'tax'->>'taxable')::boolean    AS taxable,
       (r.details->'tax'->>'transitionCandidate')::boolean AS transition_candidate,
       (r.details->'tax'->>'transitionConfirmed')::boolean AS transition_confirmed,
       (r.details->>'templateName')               AS template_name,
       (r.details->>'templateTotalPct')           AS template_total_pct,
       r.details->'costBasisFreshness'            AS cost_basis_freshness`;

const HISTORY_SQL = `SELECT
       to_char(r.run_date_local, 'YYYY-MM-DD') AS run_date_local,
       r.account_id,
       r.account_title,
       r.household_name,
       r.status,
       r.worst_bucket,
       r.max_bucket_delta_pct::text          AS max_bucket_delta_pct,
       r.symbol_breach_count,
       r.total_value_usd::text               AS total_value_usd,
       r.coverage,
       r.snapshot_source,
       r.snapshot_as_of,
       r.schema_version,${COST_BASIS_SELECT}
     FROM trade_request.position_drift_accounts r
     INNER JOIN (
       SELECT run_date_local, MAX(run_started_at) AS latest
       FROM trade_request.position_drift_accounts
       WHERE run_date_local >= (CURRENT_DATE - ($1::int - 1))
       GROUP BY run_date_local
     ) latest ON latest.run_date_local = r.run_date_local
             AND latest.latest = r.run_started_at
     ORDER BY r.run_date_local DESC, r.max_bucket_delta_pct DESC, r.account_id ASC
     LIMIT ${HISTORY_ROW_CAP + 1}`;

function mapHistoryRow(row: HistoryRowSql): AccountDriftHistoryRow {
  return {
    runDateLocal: row.run_date_local,
    accountId: row.account_id,
    accountTitle: row.account_title,
    householdName: row.household_name,
    status: row.status,
    worstBucket: row.worst_bucket,
    maxBucketDeltaPct: row.max_bucket_delta_pct === null ? null : parseFloat(row.max_bucket_delta_pct),
    symbolBreachCount: row.symbol_breach_count,
    totalValueUsd: parseFloat(row.total_value_usd),
    coverage: row.coverage,
    snapshotSource: row.snapshot_source,
    snapshotAsOf: row.snapshot_as_of,
    schemaVersion: row.schema_version,
    unrealizedGainUsd: row.unrealized_gain_usd == null ? null : parseFloat(row.unrealized_gain_usd),
    realizedGainYtdUsd: row.realized_gain_ytd_usd == null ? null : parseFloat(row.realized_gain_ytd_usd),
    transferInPct: row.transfer_in_pct == null ? null : parseFloat(row.transfer_in_pct),
    // null (no tax data) stays undefined so the UI distinguishes "not enriched"
    // from "enriched, not a candidate".
    taxable: row.taxable == null ? undefined : row.taxable,
    transitionCandidate: row.transition_candidate == null ? undefined : row.transition_candidate,
    transitionConfirmed: row.transition_confirmed == null ? undefined : row.transition_confirmed,
    templateName: row.template_name ?? null,
    templateTotalPct: row.template_total_pct == null ? null : parseFloat(row.template_total_pct),
    costBasisFreshness: row.cost_basis_freshness ?? null,
  };
}

export async function fetchAccountDriftHistory(pool: Pool, days: number): Promise<AccountDriftHistoryRow[]> {
  const { rows } = await pool.query<HistoryRowSql>(HISTORY_SQL, [days]);
  if (rows.length > HISTORY_ROW_CAP) {
    logger.warn(
      {
        event: 'drift_v2_history_row_cap_exceeded',
        days,
        rowCap: HISTORY_ROW_CAP,
        observedRows: rows.length,
      },
      'drift v2 history row cap exceeded; truncating',
    );
  }
  return rows.slice(0, HISTORY_ROW_CAP).map(mapHistoryRow);
}

interface DetailRowSql extends HistoryRowSql {
  run_started_at: string;
  tolerance_pct: string;
  uninvested_cash_threshold_pct: string;
  details: unknown;
}

const DETAIL_SQL = `SELECT
       to_char(run_date_local, 'YYYY-MM-DD') AS run_date_local,
       run_started_at,
       account_id,
       account_title,
       household_name,
       status,
       worst_bucket,
       max_bucket_delta_pct::text          AS max_bucket_delta_pct,
       symbol_breach_count,
       total_value_usd::text               AS total_value_usd,
       coverage,
       tolerance_pct::text                 AS tolerance_pct,
       uninvested_cash_threshold_pct::text AS uninvested_cash_threshold_pct,
       snapshot_source,
       snapshot_as_of,
       schema_version,
       (details->'tax'->>'unrealizedGainUsd')   AS unrealized_gain_usd,
       (details->'tax'->>'realizedGainYtdUsd')  AS realized_gain_ytd_usd,
       (details->'tax'->>'transferInPct')       AS transfer_in_pct,
       (details->'tax'->>'taxable')::boolean    AS taxable,
       (details->'tax'->>'transitionCandidate')::boolean AS transition_candidate,
       (details->'tax'->>'transitionConfirmed')::boolean AS transition_confirmed,
       (details->>'templateName')               AS template_name,
       (details->>'templateTotalPct')           AS template_total_pct,
       details->'costBasisFreshness'            AS cost_basis_freshness,
       details
     FROM trade_request.position_drift_accounts
     WHERE run_date_local = $1::date
       AND run_started_at = (
         SELECT MAX(run_started_at)
         FROM trade_request.position_drift_accounts
         WHERE run_date_local = $1::date
       )
     ORDER BY max_bucket_delta_pct DESC, account_id ASC`;

export async function fetchAccountDriftRun(pool: Pool, runDateLocal: string): Promise<AccountDriftRunDetail | null> {
  const { rows } = await pool.query<DetailRowSql>(DETAIL_SQL, [runDateLocal]);
  if (rows.length === 0) return null;
  const first = rows[0];
  const accounts: AccountDriftRunRow[] = rows.map((row) => ({
    ...mapHistoryRow(row),
    // details is JSONB; pg parses it for us, but accept passthrough.
    details: row.details as AccountDriftRunRow['details'],
  }));
  const runStartedAt =
    typeof first.run_started_at === 'string' ? first.run_started_at : new Date(first.run_started_at).toISOString();
  return {
    runDateLocal: first.run_date_local,
    runStartedAt,
    snapshotSource: first.snapshot_source,
    snapshotAsOf: first.snapshot_as_of,
    tolerancePct: parseFloat(first.tolerance_pct),
    uninvestedCashThresholdPct: parseFloat(first.uninvested_cash_threshold_pct),
    accounts,
  };
}

/**
 * Current allocation + target + drift for a set of accounts, read from the
 * latest drift run only. Used by the trade-request modal to show read-only
 * household-sibling context alongside the editable selected-account holdings.
 *
 * Returns a `Map` keyed by Apex ULID; accounts with no row in the latest run
 * are simply absent (callers render them as "no model data"). An empty input
 * or an empty table yields an empty map — never throws on missing data.
 */
export interface DriftAllocation {
  runDateLocal: string;
  status: AccountDriftStatus;
  totalValueUsd: number;
  positionCashPct: number;
  positionFixedPct: number;
  positionEquityPct: number;
  /** Null for `no_template` rows (no target to measure against). */
  templateCashPct: number | null;
  templateFixedPct: number | null;
  templateEquityPct: number | null;
  maxBucketDeltaPct: number | null;
  worstBucket: 'cash' | 'fixed' | 'equity' | null;
}

interface AllocationRowSql {
  account_id: string;
  run_date_local: string;
  status: AccountDriftStatus;
  total_value_usd: string;
  position_cash_pct: string;
  position_fixed_pct: string;
  position_equity_pct: string;
  template_cash_pct: string | null;
  template_fixed_pct: string | null;
  template_equity_pct: string | null;
  max_bucket_delta_pct: string | null;
  worst_bucket: 'cash' | 'fixed' | 'equity' | null;
}

// Latest run = max (run_date_local, then run_started_at) — mirrors the
// latest-per-date dedup `fetchAccountDriftRun` relies on.
const ALLOCATIONS_SQL = `SELECT
       account_id,
       to_char(run_date_local, 'YYYY-MM-DD') AS run_date_local,
       status,
       total_value_usd::text     AS total_value_usd,
       position_cash_pct::text   AS position_cash_pct,
       position_fixed_pct::text  AS position_fixed_pct,
       position_equity_pct::text AS position_equity_pct,
       template_cash_pct::text   AS template_cash_pct,
       template_fixed_pct::text  AS template_fixed_pct,
       template_equity_pct::text AS template_equity_pct,
       max_bucket_delta_pct::text AS max_bucket_delta_pct,
       worst_bucket
     FROM trade_request.position_drift_accounts
     WHERE account_id = ANY($1::text[])
       AND run_date_local = (SELECT MAX(run_date_local) FROM trade_request.position_drift_accounts)
       AND run_started_at = (
         SELECT MAX(run_started_at)
         FROM trade_request.position_drift_accounts
         WHERE run_date_local = (SELECT MAX(run_date_local) FROM trade_request.position_drift_accounts)
       )`;

export async function fetchLatestDriftAllocationsByAccountId(
  pool: Pool,
  accountIds: string[],
): Promise<Map<string, DriftAllocation>> {
  const result = new Map<string, DriftAllocation>();
  if (accountIds.length === 0) return result;
  const { rows } = await pool.query<AllocationRowSql>(ALLOCATIONS_SQL, [accountIds]);
  const parseNullable = (v: string | null): number | null => (v === null ? null : parseFloat(v));
  for (const row of rows) {
    result.set(row.account_id, {
      runDateLocal: row.run_date_local,
      status: row.status,
      totalValueUsd: parseFloat(row.total_value_usd),
      positionCashPct: parseFloat(row.position_cash_pct),
      positionFixedPct: parseFloat(row.position_fixed_pct),
      positionEquityPct: parseFloat(row.position_equity_pct),
      templateCashPct: parseNullable(row.template_cash_pct),
      templateFixedPct: parseNullable(row.template_fixed_pct),
      templateEquityPct: parseNullable(row.template_equity_pct),
      maxBucketDeltaPct: parseNullable(row.max_bucket_delta_pct),
      worstBucket: row.worst_bucket,
    });
  }
  return result;
}
