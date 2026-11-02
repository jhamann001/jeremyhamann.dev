import { withIngestScope } from "@/lib/ingest/scope";
import {
  previousTradingDay,
  tradingDaysBetween,
} from "@/lib/market-calendar";
import { FIRM_ACCOUNT_IDS, FIRM_HOUSEHOLD_ID } from "./firm-household";

/**
 * Data-freshness / health monitor for the account-AUM feed
 * (`mirror.client_account_aum`, written daily by POST /api/cron/account-aum from
 * Warehouse card 6601).
 *
 * The rule the owner asked for — "alert when the feed is older than T-1, or T-3 on
 * Mondays" — generalizes, via a NYSE trading calendar, to a single robust test:
 *
 *     the freshest `as_of` must be at least as recent as the PREVIOUS NYSE
 *     trading day (`expectedMinAsOf = previousTradingDay(today ET)`).
 *
 * On Tue–Fri the previous trading day is yesterday (T-1); on Monday it is the
 * prior Friday (T-3 in calendar days); the day after a holiday it steps back
 * over the holiday. Because weekends and market holidays are NON-trading days,
 * the expectation never advances across them, so a closed market never trips a
 * false alert.
 */

/** Default max age of the freshest `synced_at` before we call the cron dead. */
export const DEFAULT_SYNC_MAX_AGE_HOURS = 30;

export type FreshnessReason =
  | "ok"
  | "empty"
  | "stale_as_of"
  | "stale_sync"
  | "incomplete_coverage"
  | "reconciliation_failed"
  | "close_date_missing";

export type AumFreshnessResult = {
  ok: boolean;
  reason: FreshnessReason;
  /** The previous NYSE trading day (YYYY-MM-DD) — the minimum acceptable as_of. */
  expectedMinAsOf: string;
  /** Freshest as_of in the feed (YYYY-MM-DD), or null when the feed is empty. */
  maxAsOf: string | null;
  /** # trading days maxAsOf lags expectedMinAsOf (0 when fresh or empty). */
  staleByTradingDays: number;
  rowCount: number;
  /** Hours since the freshest synced_at, or null when unknown/empty. */
  syncAgeHours: number | null;
  openAccountCount: number | null;
  currentOpenAccountCount: number | null;
  corporateCurrentCount: number | null;
  missingCloseDateCount: number | null;
  reconciliationFailureCount: number | null;
  expectedRowCount: number | null;
};

export type EvaluateAumFreshnessInput = {
  maxAsOf: string | null;
  maxSyncedAt: Date | null;
  rowCount: number;
  /** Today's date in ET (YYYY-MM-DD). */
  nowEt: string;
  /** The instant "now" — used to age `maxSyncedAt`. */
  nowInstant: Date;
  /** Override the dead-cron threshold (defaults to DEFAULT_SYNC_MAX_AGE_HOURS). */
  syncMaxAgeHours?: number;
  openAccountCount?: number;
  currentOpenAccountCount?: number;
  corporateCurrentCount?: number;
  missingCloseDateCount?: number;
  reconciliationFailureCount?: number;
  expectedRowCount?: number;
};

/**
 * PURE freshness decision (no DB, no clock — everything is an argument, so this
 * is exhaustively unit-testable). Precedence of stale reasons:
 *   1. `empty`       — the feed has no rows at all.
 *   2. `stale_as_of` — the freshest as_of is older than the previous trading day.
 *   3. `stale_sync`  — the cron hasn't written in > syncMaxAgeHours (catches a
 *                      dead cron even if upstream as_of coincidentally looks ok).
 * Otherwise `ok`.
 */
export function evaluateAumFreshness(
  input: EvaluateAumFreshnessInput,
): AumFreshnessResult {
  const {
    maxAsOf,
    maxSyncedAt,
    rowCount,
    nowEt,
    nowInstant,
    syncMaxAgeHours = DEFAULT_SYNC_MAX_AGE_HOURS,
    openAccountCount,
    currentOpenAccountCount,
    corporateCurrentCount,
    missingCloseDateCount,
    reconciliationFailureCount,
    expectedRowCount,
  } = input;

  const expectedMinAsOf = previousTradingDay(nowEt);

  const syncAgeHours =
    maxSyncedAt == null
      ? null
      : (nowInstant.getTime() - maxSyncedAt.getTime()) / 3_600_000;

  // 1. Empty feed — nothing to be fresh.
  if (rowCount === 0) {
    return {
      ok: false,
      reason: "empty",
      expectedMinAsOf,
      maxAsOf,
      staleByTradingDays: 0,
      rowCount,
      syncAgeHours,
      openAccountCount: openAccountCount ?? null,
      currentOpenAccountCount: currentOpenAccountCount ?? null,
      corporateCurrentCount: corporateCurrentCount ?? null,
      missingCloseDateCount: missingCloseDateCount ?? null,
      reconciliationFailureCount: reconciliationFailureCount ?? null,
      expectedRowCount: expectedRowCount ?? null,
    };
  }

  // 2. Stale as_of — freshest data date is behind the previous trading day.
  if (maxAsOf == null || maxAsOf < expectedMinAsOf) {
    // With no valid as_of at all, we can't measure the gap in trading days.
    const staleByTradingDays =
      maxAsOf == null ? 0 : tradingDaysBetween(maxAsOf, expectedMinAsOf);
    return {
      ok: false,
      reason: "stale_as_of",
      expectedMinAsOf,
      maxAsOf,
      staleByTradingDays,
      rowCount,
      syncAgeHours,
      openAccountCount: openAccountCount ?? null,
      currentOpenAccountCount: currentOpenAccountCount ?? null,
      corporateCurrentCount: corporateCurrentCount ?? null,
      missingCloseDateCount: missingCloseDateCount ?? null,
      reconciliationFailureCount: reconciliationFailureCount ?? null,
      expectedRowCount: expectedRowCount ?? null,
    };
  }

  const base = {
    expectedMinAsOf,
    maxAsOf,
    staleByTradingDays: 0,
    rowCount,
    syncAgeHours,
    openAccountCount: openAccountCount ?? null,
    currentOpenAccountCount: currentOpenAccountCount ?? null,
    corporateCurrentCount: corporateCurrentCount ?? null,
    missingCloseDateCount: missingCloseDateCount ?? null,
    reconciliationFailureCount: reconciliationFailureCount ?? null,
    expectedRowCount: expectedRowCount ?? null,
  };

  if ((reconciliationFailureCount ?? 0) > 0) {
    return { ...base, ok: false, reason: "reconciliation_failed" };
  }
  if ((missingCloseDateCount ?? 0) > 0) {
    return { ...base, ok: false, reason: "close_date_missing" };
  }
  if (
    openAccountCount != null &&
    currentOpenAccountCount != null &&
    corporateCurrentCount != null &&
    (openAccountCount === 0 ||
      (expectedRowCount != null && rowCount !== expectedRowCount) ||
      currentOpenAccountCount !== openAccountCount ||
      corporateCurrentCount !== FIRM_ACCOUNT_IDS.size)
  ) {
    return { ...base, ok: false, reason: "incomplete_coverage" };
  }

  // 3. Stale sync — as_of looks current but the cron stopped writing.
  if (syncAgeHours != null && syncAgeHours > syncMaxAgeHours) {
    return { ...base, ok: false, reason: "stale_sync" };
  }

  return { ...base, ok: true, reason: "ok" };
}

export type AumFeedStats = {
  maxAsOf: string | null;
  maxSyncedAt: Date | null;
  rowCount: number;
  openAccountCount: number;
  currentOpenAccountCount: number;
  corporateCurrentCount: number;
  missingCloseDateCount: number;
  reconciliationFailureCount: number;
  expectedRowCount: number | null;
};

type StatsRow = {
  max_as_of: string | null;
  max_synced_at: Date | null;
  n: bigint | number;
  open_n: bigint | number;
  current_open_n: bigint | number;
  corporate_current_n: bigint | number;
  missing_close_date_n: bigint | number;
  reconciliation_failure_n: bigint | number;
  expected_n: bigint | number | null;
};

/**
 * Read the freshness stats off `mirror.client_account_aum`.
 *
 * Runs under `withIngestScope` (ingest_rw), NOT `withUserScope`: this is an
 * unauthenticated cron health check with no user identity, and ingest_rw's
 * `client_account_aum_ingest_all` policy (USING true) admits a read of the whole
 * table. `to_char(max(as_of), 'YYYY-MM-DD')` formats the DATE server-side so we
 * never wrestle a Prisma `Date` back into an ET calendar string; count is cast
 * to bigint (Prisma → BigInt) and coerced to Number.
 */
export async function getAumFeedStats(): Promise<AumFeedStats> {
  const rows = await withIngestScope(
    (tx) =>
      tx.$queryRaw<StatsRow[]>`
        SELECT
          to_char(max(source_snapshot_as_of) FILTER (WHERE source_present), 'YYYY-MM-DD') AS max_as_of,
          max(synced_at) FILTER (WHERE source_present) AS max_synced_at,
          count(*) FILTER (WHERE source_present)::bigint AS n,
          count(*) FILTER (
            WHERE source_present AND account_status IS DISTINCT FROM 'CLOSED'
          )::bigint AS open_n,
          count(*) FILTER (
            WHERE source_present AND account_status IS DISTINCT FROM 'CLOSED' AND balance_current
              AND balance_as_of = source_snapshot_as_of
              AND account_cash IS NOT NULL AND account_securities IS NOT NULL
              AND account_aum IS NOT NULL
          )::bigint AS current_open_n,
          count(*) FILTER (
            WHERE source_present AND balance_current
              AND household_sf_id = ${FIRM_HOUSEHOLD_ID}
          )::bigint AS corporate_current_n,
          count(*) FILTER (
            WHERE source_present AND account_status = 'CLOSED' AND close_date IS NULL
          )::bigint AS missing_close_date_n,
          count(*) FILTER (
            WHERE source_present AND account_aum IS NOT NULL
              AND account_cash IS NOT NULL AND account_securities IS NOT NULL
              AND abs(account_aum - account_cash - account_securities) > 0.01
          )::bigint AS reconciliation_failure_n,
          max(expected_snapshot_rows) FILTER (WHERE source_present)::bigint AS expected_n
        FROM mirror.client_account_aum
      `,
  );

  const row = rows[0];
  if (!row) return {
    maxAsOf: null, maxSyncedAt: null, rowCount: 0, openAccountCount: 0,
    currentOpenAccountCount: 0, corporateCurrentCount: 0,
    missingCloseDateCount: 0, reconciliationFailureCount: 0,
    expectedRowCount: null,
  };

  return {
    maxAsOf: row.max_as_of ?? null,
    maxSyncedAt: row.max_synced_at ?? null,
    rowCount: Number(row.n),
    openAccountCount: Number(row.open_n),
    currentOpenAccountCount: Number(row.current_open_n),
    corporateCurrentCount: Number(row.corporate_current_n),
    missingCloseDateCount: Number(row.missing_close_date_n),
    reconciliationFailureCount: Number(row.reconciliation_failure_n),
    expectedRowCount: row.expected_n == null ? null : Number(row.expected_n),
  };
}

/**
 * Compose the DB read + the pure decision. Derives `nowEt` (YYYY-MM-DD in
 * America/New_York) from `nowInstant` so a 6am-ET-window check reads "today" in
 * the same calendar the `as_of` dates live in.
 */
export async function checkAumFreshness(
  nowInstant: Date = new Date(),
): Promise<AumFreshnessResult & { maxSyncedAt: Date | null }> {
  const stats = await getAumFeedStats();
  const nowEt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(nowInstant);

  const result = evaluateAumFreshness({
    maxAsOf: stats.maxAsOf,
    maxSyncedAt: stats.maxSyncedAt,
    rowCount: stats.rowCount,
    nowEt,
    nowInstant,
    openAccountCount: stats.openAccountCount,
    currentOpenAccountCount: stats.currentOpenAccountCount,
    corporateCurrentCount: stats.corporateCurrentCount,
    missingCloseDateCount: stats.missingCloseDateCount,
    reconciliationFailureCount: stats.reconciliationFailureCount,
    expectedRowCount: stats.expectedRowCount ?? undefined,
  });

  return { ...result, maxSyncedAt: stats.maxSyncedAt };
}
