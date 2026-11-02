import { withIngestScope } from "@/lib/ingest/scope";
import {
  previousTradingDay,
  tradingDaysBetween,
} from "@/lib/market-calendar";
import { RF_SOURCE, RF_TENOR } from "@/lib/twr/risk-free-rate";

/**
 * Freshness monitor for the Treasury series used by the performance reports.
 *
 * This is deliberately separate from the report path. A report with stale or
 * incomplete rate coverage already fails safe by omitting the Sharpe ratio; the
 * monitor makes that safe failure LOUD so Operations does not have to notice a
 * missing statistic on a client report.
 */

/** At a 09:30 ET health check, a missed 07:00 ET run is more than 26h old. */
export const DEFAULT_RF_SYNC_MAX_AGE_HOURS = 26;

export type RiskFreeFreshnessReason =
  | "ok"
  | "empty"
  | "stale_rate_date"
  | "stale_sync";

export type RiskFreeFreshnessResult = {
  ok: boolean;
  reason: RiskFreeFreshnessReason;
  /** Previous NYSE trading day: the minimum rate date expected by the check. */
  expectedMinRateDate: string;
  maxRateDate: string | null;
  maxSyncedAt: Date | null;
  staleByTradingDays: number;
  rowCount: number;
  syncAgeHours: number | null;
};

export type EvaluateRiskFreeFreshnessInput = {
  maxRateDate: string | null;
  maxSyncedAt: Date | null;
  rowCount: number;
  nowEt: string;
  nowInstant: Date;
  syncMaxAgeHours?: number;
};

/** Pure decision function; no DB and no clock, so every boundary is testable. */
export function evaluateRiskFreeFreshness(
  input: EvaluateRiskFreeFreshnessInput,
): RiskFreeFreshnessResult {
  const {
    maxRateDate,
    maxSyncedAt,
    rowCount,
    nowEt,
    nowInstant,
    syncMaxAgeHours = DEFAULT_RF_SYNC_MAX_AGE_HOURS,
  } = input;
  const expectedMinRateDate = previousTradingDay(nowEt);
  const syncAgeHours =
    maxSyncedAt == null
      ? null
      : (nowInstant.getTime() - maxSyncedAt.getTime()) / 3_600_000;

  if (rowCount === 0) {
    return {
      ok: false,
      reason: "empty",
      expectedMinRateDate,
      maxRateDate,
      maxSyncedAt,
      staleByTradingDays: 0,
      rowCount,
      syncAgeHours,
    };
  }

  if (maxRateDate == null || maxRateDate < expectedMinRateDate) {
    return {
      ok: false,
      reason: "stale_rate_date",
      expectedMinRateDate,
      maxRateDate,
      maxSyncedAt,
      staleByTradingDays:
        maxRateDate == null
          ? 0
          : tradingDaysBetween(maxRateDate, expectedMinRateDate),
      rowCount,
      syncAgeHours,
    };
  }

  // The date can look current even if a workflow stopped after writing it. The
  // synced_at check catches that silent missed-schedule case independently.
  if (syncAgeHours == null || syncAgeHours > syncMaxAgeHours) {
    return {
      ok: false,
      reason: "stale_sync",
      expectedMinRateDate,
      maxRateDate,
      maxSyncedAt,
      staleByTradingDays: 0,
      rowCount,
      syncAgeHours,
    };
  }

  return {
    ok: true,
    reason: "ok",
    expectedMinRateDate,
    maxRateDate,
    maxSyncedAt,
    staleByTradingDays: 0,
    rowCount,
    syncAgeHours,
  };
}

type StatsRow = {
  max_rate_date: string | null;
  max_synced_at: Date | null;
  n: bigint | number;
};

export async function getRiskFreeFeedStats(): Promise<{
  maxRateDate: string | null;
  maxSyncedAt: Date | null;
  rowCount: number;
}> {
  const rows = await withIngestScope((tx) =>
    tx.$queryRaw<StatsRow[]>`
      SELECT
        to_char(max(rate_date), 'YYYY-MM-DD') AS max_rate_date,
        max(synced_at)                        AS max_synced_at,
        count(*)::bigint                      AS n
      FROM mirror.risk_free_rate
      WHERE tenor = ${RF_TENOR}
        AND source = ${RF_SOURCE}
    `,
  );
  const row = rows[0];
  return {
    maxRateDate: row?.max_rate_date ?? null,
    maxSyncedAt: row?.max_synced_at ?? null,
    rowCount: Number(row?.n ?? 0),
  };
}

export async function checkRiskFreeFreshness(
  nowInstant: Date = new Date(),
): Promise<RiskFreeFreshnessResult> {
  const stats = await getRiskFreeFeedStats();
  const nowEt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(nowInstant);
  return evaluateRiskFreeFreshness({ ...stats, nowEt, nowInstant });
}
