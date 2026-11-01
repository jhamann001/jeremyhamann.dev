import type { Pool } from 'pg';
import type { DriftHistoryRow, DriftCoverageStatus, DriftRunDetail } from '@trade-request/shared';

/**
 * Shared SQL helpers for the registry-drift dashboard surfaces. Both the
 * Cloud Scheduler-protected `/api/internal/drift/history` route and the
 * session-protected `/api/drift/*` routes delegate to these so the wire
 * contract is computed in one place.
 *
 * NOTE on `clampDays`: this matches the semantics of the original handler at
 * `server/src/routes/internal.ts:222-223` — any non-finite, zero, negative,
 * or out-of-range value falls back to the default (30). This is deliberately
 * NOT `Math.max/min` clamping because the existing `internal.test.ts` cases
 * assert that `?days=0` and `?days=999` both fall back to 30. Changing the
 * semantics here would silently regress that contract.
 */

const HISTORY_DEFAULT_DAYS = 30;
// 180 rather than 90 so the window can reach the first drift runs (v1
// 2026-05-13, v2 2026-05-14) — at 90 the history stopped ~8 days short of
// launch. Rows are never pruned, so the data has always been there; only the
// query window hid it. The DEFAULT stays 30: the v2 tab holds the whole
// window in memory and refilters client-side, so a long window is opt-in.
const HISTORY_MAX_DAYS = 180;
const HISTORY_ROW_CAP = 5000;

export function clampHistoryDays(rawDays: unknown): number {
  const parsed = typeof rawDays === 'string' ? parseInt(rawDays, 10) : typeof rawDays === 'number' ? rawDays : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= HISTORY_MAX_DAYS ? parsed : HISTORY_DEFAULT_DAYS;
}

interface HistoryRowSql {
  run_date_local: string;
  household_name: string;
  max_delta_pct: string;
  breach: boolean;
  coverage_status: DriftCoverageStatus;
  schema_version: number;
  snapshot_source: string;
  snapshot_as_of: string | null;
}

/**
 * Returns rows only from the latest `run_started_at` per `run_date_local`.
 *
 * Earlier same-day runs are masked from the dashboard because their
 * `__unmapped__:<ULID>` synthetic household names don't collide with later
 * runs' rows under the unique key `(run_date_local, household_name)`. That
 * leaves stale buckets in `registry_drift_runs` that this read path would
 * otherwise stack on top of the latest run's rows. The inner-join scopes
 * the result to the most recent run for each calendar date while
 * preserving the existing wire contract (same columns, same ordering, same
 * row cap).
 *
 * This relies on the runner updating `run_started_at` on conflict (see
 * `registryDriftRunner.ts persistDriftRows`: `ON CONFLICT (...) DO UPDATE
 * SET run_started_at = EXCLUDED.run_started_at`). Rows from earlier
 * same-day runs whose `household_name` did not appear in the latest run
 * keep their old `run_started_at` and are correctly masked here.
 *
 * See `docs/plans/2026-q3-drift-refresh-and-dedup.md` for the full
 * write-up and the ticket dashboard wiring lineage.
 */
const HISTORY_SQL = `SELECT
       to_char(r.run_date_local, 'YYYY-MM-DD') AS run_date_local,
       r.household_name,
       r.max_delta_pct::text                   AS max_delta_pct,
       r.breach,
       r.coverage_status,
       r.schema_version,
       r.snapshot_source,
       r.snapshot_as_of
     FROM registry_drift_runs r
     INNER JOIN (
       SELECT run_date_local, MAX(run_started_at) AS latest
       FROM registry_drift_runs
       WHERE run_date_local >= (CURRENT_DATE - ($1::int - 1))
       GROUP BY run_date_local
     ) latest ON latest.run_date_local = r.run_date_local
             AND latest.latest = r.run_started_at
     ORDER BY r.run_date_local DESC, r.household_name ASC
     LIMIT ${HISTORY_ROW_CAP}`;

export async function fetchDriftHistory(pool: Pool, days: number): Promise<DriftHistoryRow[]> {
  const { rows } = await pool.query<HistoryRowSql>(HISTORY_SQL, [days]);
  return rows.map((row) => ({
    runDateLocal: row.run_date_local,
    householdName: row.household_name,
    maxDeltaPct: parseFloat(row.max_delta_pct),
    breach: row.breach,
    coverageStatus: row.coverage_status,
    schemaVersion: row.schema_version,
    snapshotSource: row.snapshot_source,
    snapshotAsOf: row.snapshot_as_of,
  }));
}

interface DetailRowSql extends HistoryRowSql {
  run_started_at: string;
  account_count: number;
  details: unknown;
}

const DETAIL_SQL = `SELECT
       to_char(run_date_local, 'YYYY-MM-DD') AS run_date_local,
       run_started_at,
       household_name,
       account_count,
       max_delta_pct::text                   AS max_delta_pct,
       breach,
       coverage_status,
       schema_version,
       snapshot_source,
       snapshot_as_of,
       details
     FROM registry_drift_runs
     WHERE run_date_local = $1::date
       AND household_name = $2
     LIMIT 1`;

export async function fetchDriftRunDetail(
  pool: Pool,
  runDateLocal: string,
  householdName: string,
): Promise<DriftRunDetail | null> {
  const { rows } = await pool.query<DetailRowSql>(DETAIL_SQL, [runDateLocal, householdName]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    runDateLocal: row.run_date_local,
    runStartedAt:
      typeof row.run_started_at === 'string' ? row.run_started_at : new Date(row.run_started_at).toISOString(),
    householdName: row.household_name,
    accountCount: row.account_count,
    maxDeltaPct: parseFloat(row.max_delta_pct),
    breach: row.breach,
    coverageStatus: row.coverage_status,
    schemaVersion: row.schema_version,
    snapshotSource: row.snapshot_source,
    snapshotAsOf: row.snapshot_as_of,
    details: row.details,
  };
}
