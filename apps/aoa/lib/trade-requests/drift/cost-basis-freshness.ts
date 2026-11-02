/**
 * Cost-basis staleness evaluation. Pure function — no I/O.
 *
 * The two Apex cost-basis tables refresh on different cadences (RE-VERIFIED
 * 2026-08-04 against prod; an earlier note here claimed the weekly landed on
 * Thursdays and the daily was business-only — neither matched the data):
 *   - `apex_cost_basis_open_lot_full_refresh`: WEEKLY, `process_date` every
 *     FRIDAY, gap exactly 7 days (checked 2026-06-05 → 2026-07-24). Complete
 *     snapshot. The load day is moving Saturday → SUNDAY as of 2026-08.
 *   - `apex_cost_basis_open_lot_refresh`: DAILY deltas, `process_date` on every
 *     calendar day with no gaps (checked 2026-06-25 → 2026-08-03) — not
 *     business-days-only.
 *
 * Two kinds of timestamp matter, and they fail independently:
 *   - `process_date` = the business date the data REPRESENTS (content age).
 *   - `gluerundatetime` = when the Glue ETL job actually LOADED the rows
 *     (pipeline health). Both tables load at T+1, ~11:02 ET.
 *
 * Why both: in a quiet market the daily table gets no new lots, so its
 * `process_date` can lag even though the loader ran fine — `gluerundatetime`
 * stays current and prevents a false "stale" alarm. Conversely a dead loader
 * freezes `gluerundatetime` directly, the earliest/most reliable break signal.
 *
 * Thresholds are STRICT — stale cost basis can't be trusted, so warn early.
 * `DEFAULT_FRESHNESS_THRESHOLDS` below is the single source of truth for the
 * numbers and carries the full derivation; deliberately NOT restated here,
 * because the copy that used to live in this docstring silently went stale.
 * Tunable per-call via the `thresholds` arg.
 *
 * Staleness DEGRADES GRACEFULLY: the drift run still completes with the
 * best-available cost basis; this only drives a notification and a UI banner.
 */

export type FreshnessLevel = 'ok' | 'warn' | 'critical' | 'missing';

export interface FreshnessThresholds {
  fullWarnDays: number;
  fullCriticalDays: number;
  dailyWarnDays: number;
  dailyCriticalDays: number;
  /** Pipeline = freshest `gluerundatetime` (ETL load time) across both tables. */
  pipelineWarnDays: number;
  pipelineCriticalDays: number;
}

// Strict by policy: stale cost basis can't be relied on, so warn early.
//
// These day-counts are derived from three clocks, and go silently wrong when
// any of them moves: the upstream Glue load (~11:02 ET), this job's own run
// time (09:15 ET), and each table's cadence. Because the run fires ~1h45m
// BEFORE the day's load, the newest `process_date` a run can see is one day
// older than the table's true lag — upstream "T-1" presents as 2d here.
//
//   - full `process_date`: the most recent weekly snapshot. Content stays
//     Friday-dated but the Glue job runs SUNDAY ~11:02 (as of 2026-08), so
//     `process_date` = gluerun − 2. The Sunday load lands before Monday's run,
//     so the worst normal age is 7d — a Friday run, whose own Friday snapshot
//     does not load until Sunday. WARN at 8d (a weekly was missed), CRIT 11d.
//     COUPLING: those two numbers hold only while the Cloud Scheduler cron is
//     `15 9 * * 1-5`. Restoring 7-day runs puts a run inside the pre-load
//     Sunday 09:15 window, which legitimately reads 9d and would trip WARN;
//     that cadence needs WARN 10 / CRIT 13 instead.
//   - daily `process_date`: loads T-1 daily, but at 09:15 the newest visible
//     row is T-2 — so 1d AND 2d are both normal. WARN at 3d (a load was
//     genuinely missed), CRITICAL at 4d.
//   - pipeline `gluerundatetime` (did the ETL run at all): WARN 2d, CRITICAL 4d.
//     Caveat: this is `laterOf(full, daily)`, so a healthy daily load masks a
//     stalled weekly one — it read `ok` throughout the 2026-07-31 open-lot
//     full-refresh stall. Per-table pipeline ages would catch that.
//
// All env-tunable via the `thresholds` arg if weekend/holiday gaps prove noisy.
export const DEFAULT_FRESHNESS_THRESHOLDS: FreshnessThresholds = {
  fullWarnDays: 8,
  fullCriticalDays: 11,
  dailyWarnDays: 3,
  dailyCriticalDays: 4,
  pipelineWarnDays: 2,
  pipelineCriticalDays: 4,
};

export interface CostBasisFreshnessInput {
  /** Latest `process_date` in the full-refresh table (YYYY-MM-DD or ISO), or null if none/unknown. */
  fullRefreshLatest: string | null;
  /** Latest `process_date` in the daily-refresh table (YYYY-MM-DD or ISO), or null if none/unknown. */
  dailyRefreshLatest: string | null;
  /**
   * Latest `gluerundatetime` (ETL load timestamp) in the full-refresh table.
   * Optional — when both gluerun inputs are omitted/null the pipeline signal is
   * not evaluated (reports `ok`) so the check stays purely additive.
   */
  fullGlueRunLatest?: string | null;
  /** Latest `gluerundatetime` (ETL load timestamp) in the daily-refresh table. */
  dailyGlueRunLatest?: string | null;
  /** Evaluation time (the drift run timestamp). */
  asOf: Date;
  thresholds?: Partial<FreshnessThresholds>;
}

export interface TableFreshness {
  latest: string | null;
  ageDays: number | null;
  level: FreshnessLevel;
}

export interface CostBasisFreshnessResult {
  /** Worst level across content (full/daily process_date) and pipeline (gluerun). */
  level: FreshnessLevel;
  /** Full-refresh content age (process_date). */
  full: TableFreshness;
  /** Daily-refresh content age (process_date). */
  daily: TableFreshness;
  /** ETL pipeline health — freshest `gluerundatetime` across both tables. */
  pipeline: TableFreshness;
  /** Human-readable one-liner suitable for a Slack alert / UI banner. */
  message: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole calendar days between a process_date and `asOf` (floored, never negative). */
function ageInDays(latest: string | null, asOf: Date): number | null {
  if (!latest) return null;
  // Date-only comparison: take the calendar date of both sides in UTC to avoid
  // tz-boundary off-by-one. process_date is a midnight timestamp.
  const latestMs = Date.parse(latest);
  if (Number.isNaN(latestMs)) return null;
  const latestDay = Math.floor(latestMs / MS_PER_DAY);
  const asOfDay = Math.floor(asOf.getTime() / MS_PER_DAY);
  return Math.max(0, asOfDay - latestDay);
}

function levelFor(ageDays: number | null, warnDays: number, criticalDays: number): FreshnessLevel {
  if (ageDays === null) return 'missing';
  if (ageDays >= criticalDays) return 'critical';
  if (ageDays >= warnDays) return 'warn';
  return 'ok';
}

const SEVERITY: Record<FreshnessLevel, number> = { ok: 0, warn: 1, critical: 2, missing: 3 };

function worst(...levels: FreshnessLevel[]): FreshnessLevel {
  return levels.reduce((acc, l) => (SEVERITY[l] >= SEVERITY[acc] ? l : acc), 'ok' as FreshnessLevel);
}

/** The later of two timestamps (by parsed epoch ms), tolerant of nulls/garbage. */
function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  const am = a ? Date.parse(a) : NaN;
  const bm = b ? Date.parse(b) : NaN;
  if (Number.isNaN(am) && Number.isNaN(bm)) return null;
  if (Number.isNaN(am)) return b ?? null;
  if (Number.isNaN(bm)) return a ?? null;
  return am >= bm ? (a as string) : (b as string);
}

function describe(label: string, t: TableFreshness): string {
  if (t.level === 'missing') return `${label}: no data`;
  return `${label}: ${t.ageDays}d old (${t.latest})`;
}

/** One source's own staleness, independent of the merged result. */
export interface SourceFreshness {
  databaseId: number;
  fullLevel: FreshnessLevel;
  fullAgeDays: number | null;
  dailyLevel: FreshnessLevel;
  dailyAgeDays: number | null;
  /** Worst of the two, for a single at-a-glance verdict. */
  level: FreshnessLevel;
  baselineSource: boolean;
}

export interface SourceFreshnessInput {
  databaseId: number;
  fullRefreshLatest: string | null;
  dailyRefreshLatest: string | null;
  baselineSource: boolean;
}

/**
 * Evaluate each cost-basis source on its own, using the same thresholds as the
 * merged check. Pure.
 *
 * WHY THIS EXISTS: merging two warehouse sources fixes the DATA but destroys the
 * SIGNAL. On 2026-08-27 db 4's weekly open-lot loader had been dead for 12 days;
 * merging db 101's newer snapshot over the top makes the merged view healthy and
 * the alert go quiet, so nobody would ever fix db 4. This lets the runner say
 * "merged data is fine AND source 4 is 13 days stale" at the same time.
 *
 * A source being stale is NOT a user-facing data-quality problem when another
 * source covers it — it is an infrastructure problem. Callers should log/alert
 * it separately from the merged banner, not fold it into the same level.
 */
export function evaluateSourceFreshness(
  sources: readonly SourceFreshnessInput[],
  asOf: Date,
  thresholds?: Partial<FreshnessThresholds>,
): SourceFreshness[] {
  const t = { ...DEFAULT_FRESHNESS_THRESHOLDS, ...(thresholds ?? {}) };
  const rank: Record<FreshnessLevel, number> = { ok: 0, warn: 1, critical: 2, missing: 3 };
  return sources.map((s) => {
    const fullAgeDays = ageInDays(s.fullRefreshLatest, asOf);
    const dailyAgeDays = ageInDays(s.dailyRefreshLatest, asOf);
    const fullLevel = levelFor(fullAgeDays, t.fullWarnDays, t.fullCriticalDays);
    const dailyLevel = levelFor(dailyAgeDays, t.dailyWarnDays, t.dailyCriticalDays);
    return {
      databaseId: s.databaseId,
      fullLevel,
      fullAgeDays,
      dailyLevel,
      dailyAgeDays,
      level: rank[fullLevel] >= rank[dailyLevel] ? fullLevel : dailyLevel,
      baselineSource: s.baselineSource,
    };
  });
}

export function evaluateCostBasisFreshness(input: CostBasisFreshnessInput): CostBasisFreshnessResult {
  const t = { ...DEFAULT_FRESHNESS_THRESHOLDS, ...(input.thresholds ?? {}) };

  const fullAge = ageInDays(input.fullRefreshLatest, input.asOf);
  const dailyAge = ageInDays(input.dailyRefreshLatest, input.asOf);

  const full: TableFreshness = {
    latest: input.fullRefreshLatest,
    ageDays: fullAge,
    level: levelFor(fullAge, t.fullWarnDays, t.fullCriticalDays),
  };
  const daily: TableFreshness = {
    latest: input.dailyRefreshLatest,
    ageDays: dailyAge,
    level: levelFor(dailyAge, t.dailyWarnDays, t.dailyCriticalDays),
  };

  // Pipeline = freshest ETL load across both tables. Only evaluated when a
  // gluerun timestamp is supplied; otherwise it stays 'ok' (additive).
  const pipelineLatest = laterOf(input.fullGlueRunLatest, input.dailyGlueRunLatest);
  const pipelineAge = ageInDays(pipelineLatest, input.asOf);
  const pipelineSupplied = input.fullGlueRunLatest != null || input.dailyGlueRunLatest != null;
  const pipeline: TableFreshness = {
    latest: pipelineLatest,
    ageDays: pipelineAge,
    level: pipelineSupplied ? levelFor(pipelineAge, t.pipelineWarnDays, t.pipelineCriticalDays) : 'ok',
  };

  const level = worst(full.level, daily.level, pipeline.level);
  const parts = [describe('full', full), describe('daily', daily)];
  if (pipelineSupplied) parts.push(describe('pipeline', pipeline));
  const message =
    level === 'ok'
      ? `Cost-basis data fresh — ${parts.join(', ')}`
      : `Cost-basis data stale (${level}) — ${parts.join(', ')}`;

  return { level, full, daily, pipeline, message };
}
