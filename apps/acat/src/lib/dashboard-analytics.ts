import { AcatRecord, TERMINAL_STATUSES } from "./types";
import {
  AGING_HIGH_MULTIPLIER,
  AGING_WARN_MULTIPLIER,
  getDaysOpen,
  getExpectedProcessingDays,
  getIssueCount,
  isAging,
  isResidual,
  RESIDUAL_TYPE,
} from "./acat-derivations";
import { getObservedCompletionDays } from "./custodian-timing";

// `RESIDUAL_TYPE` / `isResidual` are defined in acat-derivations (the base
// module) so lower-level derivations can use them without a circular import.
// Re-exported here to keep the dashboard-analytics import surface stable.
export { RESIDUAL_TYPE, isResidual };

/**
 * Residual credits (cash settlement after the main transfer) complete fast
 * and skew Avg Days to Complete downward. Use this filter before computing
 * the headline avg-days metric.
 */
export function excludeResiduals(records: AcatRecord[]): AcatRecord[] {
  return records.filter((r) => !isResidual(r));
}

/**
 * Days a completed record took, using business dates first
 * (originalClientRequestDate → apexCompletionDate) and falling back to
 * the ACAT reference date as the start anchor. Returns null if either
 * anchor is missing.
 *
 * Note: ticket removed the legacy `completedDate` fallback. The only
 * completion stamp we track is `apexCompletionDate`.
 */
export function getCompletionDays(record: AcatRecord): number | null {
  return getObservedCompletionDays(record);
}

const DAY_MS = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Rolling 7-day count of records whose `dateField` falls within the trailing
 * window. Returns one entry per day across `days` days ending at `now`. The
 * rolling window smooths out daily noise and surfaces the trend.
 */
export function rollingWindowSeries(
  records: AcatRecord[],
  dateField: (r: AcatRecord) => string | undefined,
  now: number,
  days: number,
  windowDays: number = 7
): { date: number; count: number; value: number }[] {
  const todayStart = startOfDay(now);
  const stamps = records
    .map((r) => {
      const raw = dateField(r);
      if (!raw) return null;
      const t = new Date(raw).getTime();
      if (Number.isNaN(t)) return null;
      return { ts: startOfDay(t), value: r.statementAmount ?? 0 };
    })
    .filter((s): s is { ts: number; value: number } => s !== null);

  const out: { date: number; count: number; value: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayEnd = todayStart - i * DAY_MS;
    const windowStart = dayEnd - (windowDays - 1) * DAY_MS;
    let count = 0;
    let value = 0;
    for (const s of stamps) {
      if (s.ts >= windowStart && s.ts <= dayEnd) {
        count++;
        value += s.value;
      }
    }
    out.push({ date: dayEnd, count, value });
  }
  return out;
}

/**
 * Bin completed records by completion week and compute the average completion
 * days within each week. Used for the Avg Days sparkline. Residuals are
 * excluded so the trend reflects full-transfer ops time.
 */
export function avgDaysByWeek(
  records: AcatRecord[],
  now: number,
  weeks: number
): { weekStart: number; avgDays: number | null; count: number }[] {
  const todayStart = startOfDay(now);
  const todayDow = new Date(todayStart).getDay();
  const thisWeekStart = todayStart - todayDow * DAY_MS;

  const bins: { weekStart: number; total: number; count: number }[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    bins.push({ weekStart: thisWeekStart - i * 7 * DAY_MS, total: 0, count: 0 });
  }

  const earliest = bins[0].weekStart;
  for (const r of excludeResiduals(records)) {
    const completionRaw = r.apexCompletionDate;
    if (!completionRaw) continue;
    const days = getCompletionDays(r);
    if (days === null) continue;
    const completedAt = startOfDay(new Date(completionRaw).getTime());
    if (completedAt < earliest) continue;
    const idx = Math.floor((completedAt - earliest) / (7 * DAY_MS));
    if (idx < 0 || idx >= bins.length) continue;
    bins[idx].total += days;
    bins[idx].count++;
  }

  return bins.map((b) => ({
    weekStart: b.weekStart,
    avgDays: b.count > 0 ? b.total / b.count : null,
    count: b.count,
  }));
}

/**
 * Approximation of historical aging-count using only present-day data.
 * For each day in the trailing window, count today's still-open records
 * whose age as of that day exceeded the per-custodian warn threshold
 * (`expectedProcessingDays * AGING_WARN_MULTIPLIER`).
 *
 * Caveat: this misses records that completed during the window (they don't
 * appear in today's open set). Without an audit log of status transitions
 * we can't reconstruct the true historical count, but this approximation is
 * directionally honest for trend purposes.
 *
 * ticket: previously took a flat `staleAfterDays` threshold; now uses each
 * record's per-custodian expected processing days so a slow contra
 * (BNY ~8d) doesn't get flagged as aggressively as a fast one
 * (Fidelity ~5d).
 */
export function stalledTrendApprox(
  records: AcatRecord[],
  now: number,
  days: number
): { date: number; count: number }[] {
  const open = records.filter((r) => !TERMINAL_STATUSES.has(r.status));
  const todayStart = startOfDay(now);
  // Pre-compute each record's warn threshold so the hot loop stays cheap.
  const thresholds = open.map((r) => ({
    record: r,
    warnAfter: getExpectedProcessingDays(r) * AGING_WARN_MULTIPLIER,
  }));
  const out: { date: number; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const asOf = todayStart - i * DAY_MS;
    let count = 0;
    for (const { record, warnAfter } of thresholds) {
      const startRaw = record.originalClientRequestDate ?? record.acatDate;
      const startTs = new Date(startRaw).getTime();
      if (Number.isNaN(startTs)) continue;
      const ageOnDay = Math.round((asOf - startTs) / DAY_MS);
      if (ageOnDay > warnAfter) count++;
    }
    out.push({ date: asOf, count });
  }
  return out;
}

/**
 * Cumulative AUM completed series. For each day in the window, returns the
 * running total of `statementAmount` (cents) across records whose completion
 * date is on or before that day. Callers convert cents → dollars for display
 * via `formatCentsAsDollar`.
 */
export function cumulativeCompletedAum(
  records: AcatRecord[],
  now: number,
  days: number
): { date: number; total: number }[] {
  const todayStart = startOfDay(now);
  const earliest = todayStart - (days - 1) * DAY_MS;
  const sortedCompletions = records
    .map((r) => {
      const raw = r.apexCompletionDate;
      if (!raw) return null;
      const ts = startOfDay(new Date(raw).getTime());
      if (Number.isNaN(ts)) return null;
      return { ts, value: r.statementAmount ?? 0 };
    })
    .filter((s): s is { ts: number; value: number } => s !== null)
    .sort((a, b) => a.ts - b.ts);

  // Pre-window total (running total at start of window). Advance cursor past
  // these so the day loop doesn't double-count them.
  let running = 0;
  let cursor = 0;
  while (cursor < sortedCompletions.length && sortedCompletions[cursor].ts < earliest) {
    running += sortedCompletions[cursor].value;
    cursor++;
  }

  const out: { date: number; total: number }[] = [];
  for (let i = 0; i < days; i++) {
    const dayEnd = earliest + i * DAY_MS;
    while (cursor < sortedCompletions.length && sortedCompletions[cursor].ts <= dayEnd) {
      running += sortedCompletions[cursor].value;
      cursor++;
    }
    out.push({ date: dayEnd, total: running });
  }
  return out;
}

/**
 * Split a list of values into the trailing "current" period and the
 * preceding "prior" period of equal length. Returns a percent change
 * suitable for KPI trend arrows.
 */
export function periodOverPeriodPct(
  current: number,
  prior: number
): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  // Divide by the magnitude of `prior`, not its signed value. With negative
  // prior totals now possible (an ACAT Out nets the window negative), dividing
  // by a signed negative would flip the arrow — making a rise from -$930K to
  // +$1.3M read as a decrease. The magnitude keeps the sign of (current - prior).
  return Math.round(((current - prior) / Math.abs(prior)) * 100);
}

export interface FlowMetric {
  /** Records counted in the trailing window. */
  count: number;
  /** Sum of statementAmount (cents) for records in the trailing window. */
  value: number;
  /** Same metric for the equally-sized period immediately preceding. */
  countPrior: number;
  valuePrior: number;
  countDeltaPct: number | null;
  valueDeltaPct: number | null;
  series: { date: number; count: number; value: number }[];
  /** The window length in days that produced these numbers. */
  days: number;
}

/**
 * Which records a flow metric counts, by the sign of their statement amount:
 *   "in"  — positive amounts only (assets transferring in)
 *   "out" — negative amounts only (ACAT Out / transfers), summed as magnitude
 *   "all" — every record, summing the signed amount (net)
 */
type FlowFilter = "in" | "out" | "all";

/**
 * Value (cents) a record contributes to a flow metric, or `null` if it doesn't
 * belong to this flow at all (excluded from both count and value). Outflows
 * return a positive magnitude so the Outflow card reads "$930K out", not
 * "-$930K". A record with no amount belongs to neither "in" nor "out".
 */
function flowContribution(amountCents: number, flow: FlowFilter): number | null {
  if (flow === "in") return amountCents > 0 ? amountCents : null;
  if (flow === "out") return amountCents < 0 ? -amountCents : null;
  return amountCents;
}

/**
 * Inflow: ACATs bringing assets in (positive statement amount), keyed on the
 * initiation date (originalClientRequestDate ?? acatDate). Higher is good.
 * Compares the trailing `days` window vs the prior equally-sized window.
 */
export function inflowMetric(
  records: AcatRecord[],
  now: number,
  days: number = 30
): FlowMetric {
  return computeFlowMetric(
    records,
    (r) => r.originalClientRequestDate ?? r.acatDate,
    now,
    days,
    "in"
  );
}

/**
 * Outflow: ACAT Out / transfers (negative statement amount), keyed on the same
 * initiation date as inflow and reported as a positive magnitude. Tracked
 * separately from inflow rather than netted against it.
 */
export function outflowMetric(
  records: AcatRecord[],
  now: number,
  days: number = 30
): FlowMetric {
  return computeFlowMetric(
    records,
    (r) => r.originalClientRequestDate ?? r.acatDate,
    now,
    days,
    "out"
  );
}

/**
 * Completed: ACATs that settled in the window (keyed on apexCompletionDate).
 * Counts every completed transfer and sums the net value that landed. ticket
 * dropped the legacy `completedDate` fallback — apexCompletionDate is now the
 * only source of truth for "when did this settle".
 */
export function throughputMetric(
  records: AcatRecord[],
  now: number,
  days: number = 30
): FlowMetric {
  return computeFlowMetric(
    records.filter((r) => r.status === "Completed"),
    (r) => r.apexCompletionDate,
    now,
    days,
    "all"
  );
}

function computeFlowMetric(
  records: AcatRecord[],
  dateField: (r: AcatRecord) => string | undefined,
  now: number,
  days: number,
  flow: FlowFilter
): FlowMetric {
  const todayStart = startOfDay(now);
  const cutoffWindow = todayStart - days * DAY_MS;
  const cutoffPrior = todayStart - 2 * days * DAY_MS;

  let count = 0;
  let value = 0;
  let countPrior = 0;
  let valuePrior = 0;
  for (const r of records) {
    const contribution = flowContribution(r.statementAmount ?? 0, flow);
    if (contribution === null) continue;
    const raw = dateField(r);
    if (!raw) continue;
    const ts = new Date(raw).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts >= cutoffWindow && ts <= todayStart) {
      count++;
      value += contribution;
    } else if (ts >= cutoffPrior && ts < cutoffWindow) {
      countPrior++;
      valuePrior += contribution;
    }
  }

  // Sparkline window mirrors the metric window. For very short windows we
  // use daily counts; for long windows the rolling 7-day average smooths
  // the line so individual events don't dominate.
  const sparklineWindow = Math.min(days, 90);
  const rollingDays = days <= 14 ? 1 : 7;
  const seriesRecords =
    flow === "all"
      ? records
      : records.filter(
          (r) => flowContribution(r.statementAmount ?? 0, flow) !== null
        );

  return {
    count,
    value,
    countPrior,
    valuePrior,
    countDeltaPct: periodOverPeriodPct(count, countPrior),
    valueDeltaPct: periodOverPeriodPct(value, valuePrior),
    series: rollingWindowSeries(seriesRecords, dateField, now, sparklineWindow, rollingDays),
    days,
  };
}

/**
 * Direction mix: incoming vs outgoing ACAT counts. Records without a
 * direction value bucket into `unset`.
 */
export function directionMix(records: AcatRecord[]): {
  incoming: number;
  outgoing: number;
  unset: number;
} {
  let incoming = 0;
  let outgoing = 0;
  let unset = 0;
  for (const r of records) {
    if (r.direction === "In") incoming++;
    else if (r.direction === "Out") outgoing++;
    else unset++;
  }
  return { incoming, outgoing, unset };
}

/**
 * Avg days to complete with residuals excluded. Returns null when there are
 * no eligible completions.
 */
export function avgDaysExResiduals(records: AcatRecord[]): {
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
} {
  const days: number[] = [];
  for (const r of excludeResiduals(records)) {
    const d = getCompletionDays(r);
    if (d !== null) days.push(d);
  }
  if (days.length === 0) {
    return { avg: null, min: null, max: null, count: 0 };
  }
  const avg = days.reduce((a, b) => a + b, 0) / days.length;
  return {
    avg,
    min: Math.min(...days),
    max: Math.max(...days),
    count: days.length,
  };
}

/**
 * Same as `avgDaysExResiduals` but including residuals — surfaced as a
 * compare-against figure in the KPI footnote.
 */
export function avgDaysAllIn(records: AcatRecord[]): number | null {
  const days: number[] = [];
  for (const r of records) {
    const d = getCompletionDays(r);
    if (d !== null) days.push(d);
  }
  if (days.length === 0) return null;
  return days.reduce((a, b) => a + b, 0) / days.length;
}

/**
 * Aging snapshot: counts of currently-open records that have overshot
 * their per-custodian SLA. `count` is everything in `warn` or `high`;
 * `over10` is the subset in the `high` tier (more than HIGH_MULTIPLIER ×
 * the custodian's expected processing days), so the dashboard tile can
 * still show a sub-headline like "N over SLA × 1.75".
 *
 * ticket: previously took a flat `staleAfterDays` threshold; the
 * per-custodian aging tier now lives in `getAgingTier` and this function
 * just rolls it up across the list. The legacy field name `over10` is
 * preserved so the KpiStalledTile UI keeps building without churn — it
 * now means "over the HIGH SLA threshold" rather than "over 10 days".
 */
export function stalledSnapshot(
  records: AcatRecord[],
  now: number
): { count: number; over10: number; ids: string[] } {
  const ids: string[] = [];
  let high = 0;
  for (const r of records) {
    if (TERMINAL_STATUSES.has(r.status)) continue;
    if (!isAging(r, now)) continue;
    ids.push(r.id);
    const expected = getExpectedProcessingDays(r);
    if (getDaysOpen(r, now) > expected * AGING_HIGH_MULTIPLIER) high++;
  }
  return { count: ids.length, over10: high, ids };
}

/**
 * Single re-export of the `getIssueCount` helper so consumers of this lib
 * don't need a second import for action-item filtering.
 */
export { getIssueCount };
