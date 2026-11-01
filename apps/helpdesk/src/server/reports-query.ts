/**
 * Report keys, firm-local date ranges and the tolerant URL parser — node-safe, layer L4, PURE
 * (docs/ARCHITECTURE.md §g shared convention 12).
 *
 * Split out of `reports.ts` for three reasons: the page, the export route and the metrics module all
 * need the same range arithmetic; none of it touches the database, so it is unit-testable without one;
 * and the bucket edges computed HERE are the same edges the SQL groups on, which is what makes a
 * report's chart and its CSV agree row for row.
 *
 * Everything in this module thinks in the FIRM clock (`src/lib/firm-time.ts`). A report
 * bucketed in the container's zone would move every ticket created after 20:00 ET into the next day and
 * quietly disagree with the follow-up badge, the dashboard filter and the SLA verdict on the same
 * screen. Civil-date arithmetic is done in UTC space on the `{y, m, d}` triple — a calendar day is a
 * property of the numbers, not of a zone — and only the final conversion to an instant goes through
 * `firmInstant`, which is where DST is handled.
 *
 * CONTRACT DEVIATION (recorded in the build record): `REPORT_KEYS` in
 * `src/types/domain.ts` (foundation-owned) carries eight keys, and the B7 brief asks for two metrics
 * that do not fit any of them — the resolution mix and the operational-health counters (held intake,
 * outbox failures, dead webhooks, complaints, voids). Rather than fold two dimensions into one table,
 * this module declares `EXTENDED_REPORT_KEYS = REPORT_KEYS + ["resolution-mix", "desk-health"]`. The
 * contract's `runReport(viewer, ReportQuery, ctx)` signature is unchanged and still returns
 * `ReportResult`; the two extra keys are reachable through `runExtendedReport`. The foundation is asked
 * to append them to `REPORT_KEYS`, after which the two types collapse into one.
 */
import type {
  QueueKey,
  ReportGranularity,
  ReportKey,
  ReportQuery,
  ReportResult,
  TicketCategory,
  TicketPriority,
} from "@/types/domain";
import {
  QUEUE_KEYS,
  REPORT_GRANULARITIES,
  REPORT_KEYS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
} from "@/types/domain";
import { firmInstant, firmWallClock } from "@/lib/firm-time";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * INTEGRATION: `REPORT_KEYS` in `src/types/domain.ts` now carries `resolution-mix` and
 * `desk-health`, so these are ALIASES of the canonical list rather than a second literal.
 * Re-spreading and re-appending would have produced a twelve-element array with both new keys twice,
 * and `EXTENDED_REPORT_KEYS` is what the /reports picker iterates. The names are kept because the
 * page, the export route and the tests import them; they are now exactly `REPORT_KEYS` / `ReportKey`.
 */
export const EXTENDED_REPORT_KEYS = REPORT_KEYS;
export type ExtendedReportKey = ReportKey;

/** `ReportQuery` widened to the two extra keys. Every `ReportQuery` is assignable to it. */
export type ExtendedReportQuery = Omit<ReportQuery, "key"> & { key: ExtendedReportKey };
/** `ReportResult` widened the same way. */
export type ExtendedReportResult = Omit<ReportResult, "key"> & { key: ExtendedReportKey };

export const EXTENDED_REPORT_LABELS: Readonly<Record<ExtendedReportKey, string>> = {
  volume: "Volume",
  backlog: "Backlog",
  "first-response": "First response time",
  resolution: "Resolution time",
  "sla-attainment": "SLA attainment",
  "agent-load": "Agent load",
  "category-mix": "Category mix",
  "reopen-rate": "Reopen rate",
  "resolution-mix": "Resolution mix",
  "desk-health": "Desk health",
};

/** One sentence per report, rendered under the picker so nobody has to guess what a number counts. */
export const REPORT_DESCRIPTIONS: Readonly<Record<ExtendedReportKey, string>> = {
  volume: "Tickets created and resolved per period, on the firm clock.",
  backlog: "Unresolved tickets standing at the end of each period, and how many were past an SLA clock.",
  "first-response":
    "Minutes from creation to the first staff response, median and 90th percentile. A recorded client callback counts as the response.",
  resolution: "Minutes from creation to resolution, median and 90th percentile, bucketed by when the ticket was resolved.",
  "sla-attainment": "Share of resolved tickets that met the first-response clock, the resolution clock, and both.",
  "agent-load": "Open tickets assigned to each agent now, and how many they resolved in the range.",
  "category-mix": "Which categories the range's tickets came in under.",
  "reopen-rate": "Resolved tickets that went back to Open, as a share of the tickets resolved in the same period.",
  "resolution-mix": "How the range's resolved tickets ended: answered, completed, duplicate, withdrawn, no response.",
  "desk-health": "Standing operational counters — complaints, held intake, failed outbound mail, dead webhooks, voided tickets.",
};

/** How each report is drawn. `bars` = one grouped bar per bucket; `rank` = a horizontal bar per row. */
export const REPORT_CHART_KINDS: Readonly<Record<ExtendedReportKey, "bars" | "line" | "rank">> = {
  volume: "bars",
  backlog: "line",
  "first-response": "line",
  resolution: "line",
  "sla-attainment": "line",
  "agent-load": "rank",
  "category-mix": "rank",
  "reopen-rate": "bars",
  "resolution-mix": "rank",
  "desk-health": "rank",
};

/** Reports whose rows are periods on the firm clock; the rest are ranked dimensions and ignore granularity. */
export const TIME_SERIES_REPORTS: readonly ExtendedReportKey[] = [
  "volume",
  "backlog",
  "first-response",
  "resolution",
  "sla-attainment",
  "reopen-rate",
];

export function isTimeSeriesReport(key: ExtendedReportKey): boolean {
  return TIME_SERIES_REPORTS.includes(key);
}

export function isReportKey(v: string): v is ExtendedReportKey {
  return (EXTENDED_REPORT_KEYS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Civil-date arithmetic on the firm clock
// ---------------------------------------------------------------------------

/** A calendar date with no zone attached. Months are 1-based, as a human writes them. */
export type CivilDate = { y: number; m: number; d: number };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** "YYYY-MM-DD" → the triple, or null when the text is not a real calendar date (2026-02-31 is not). */
export function parseCivilDate(raw: string): CivilDate | null {
  const m = DATE_PATTERN.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export function civilToString(c: CivilDate): string {
  return `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`;
}

/** The firm-local calendar date an instant falls on. */
export function civilFromInstant(at: Date): CivilDate {
  const wc = firmWallClock(at);
  if (wc === null) return { y: 1970, m: 1, d: 1 };
  return { y: wc.year, m: wc.month, d: wc.day };
}

export function addCivilDays(c: CivilDate, days: number): CivilDate {
  const at = new Date(Date.UTC(c.y, c.m - 1, c.d + days));
  return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
}

/** Monday of the ISO week `c` falls in. Postgres `date_trunc('week', …)` truncates to the same Monday. */
export function startOfCivilWeek(c: CivilDate): CivilDate {
  const dow = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay(); // 0 = Sunday
  return addCivilDays(c, -(dow === 0 ? 6 : dow - 1));
}

export function startOfCivilMonth(c: CivilDate): CivilDate {
  return { y: c.y, m: c.m, d: 1 };
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
}

/** Whole days from `a` to `b` (negative when b precedes a). Exact: both endpoints are civil midnights. */
export function civilDaysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** Midnight of this firm-local date, as the instant the database stores. DST is `firmInstant`'s problem. */
export function firmDayStart(c: CivilDate): Date {
  return firmInstant(c.y, c.m, c.d, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Ranges and buckets
// ---------------------------------------------------------------------------

/** How long a range may be. Two years of daily buckets is already 730 rows; beyond that, aggregate. */
export const MAX_RANGE_DAYS = 731;
/** How many buckets a chart may carry. A day-granularity year is 365; a week-granularity decade is not. */
export const MAX_BUCKETS = 800;

export type ReportRange = {
  /** Firm-local calendar date, inclusive. */
  fromDate: string;
  /** Firm-local calendar date, inclusive. */
  toDate: string;
  /** Instant of `fromDate` 00:00 firm time. Every query uses `>= fromAt`. */
  fromAt: Date;
  /** Instant of the day AFTER `toDate` at 00:00 firm time. Every query uses `< toAt` — exclusive. */
  toAt: Date;
  /** Whole days covered, inclusive of both ends. */
  days: number;
};

export function resolveRange(query: { from: string; to: string }): ReportRange {
  const fallbackTo = civilFromInstant(new Date());
  let from = parseCivilDate(query.from) ?? addCivilDays(fallbackTo, -29);
  let to = parseCivilDate(query.to) ?? fallbackTo;
  // A backwards range is an operator slip, not an error worth a 500: read it the way they meant it.
  if (compareCivil(from, to) > 0) [from, to] = [to, from];
  if (civilDaysBetween(from, to) + 1 > MAX_RANGE_DAYS) from = addCivilDays(to, -(MAX_RANGE_DAYS - 1));
  return {
    fromDate: civilToString(from),
    toDate: civilToString(to),
    fromAt: firmDayStart(from),
    toAt: firmDayStart(addCivilDays(to, 1)),
    days: civilDaysBetween(from, to) + 1,
  };
}

/** One period of a time-series report. `start`/`end` are instants; `end` is exclusive. */
export type ReportBucket = {
  /** The bucket's firm-local start date, "YYYY-MM-DD". This is the key the SQL `date_trunc` returns. */
  key: string;
  label: string;
  start: Date;
  end: Date;
};

/**
 * Every bucket in the range, in order, including the empty ones — a report with a gap in the middle of
 * a week should show the gap, not close it up.
 *
 * A week or month bucket at either end is PARTIAL: its natural start can precede `fromAt` and its
 * natural end can follow `toAt`, because `date_trunc` truncates to the natural boundary and the key has
 * to match what the database returns. Rows are always filtered to the range, so a partial bucket counts
 * only the days inside it; `partial` says so, and the UI marks it.
 */
export function reportBuckets(range: ReportRange, granularity: ReportGranularity): ReportBucket[] {
  const from = parseCivilDate(range.fromDate) ?? civilFromInstant(range.fromAt);
  const to = parseCivilDate(range.toDate) ?? civilFromInstant(range.toAt);

  const startOf = (c: CivilDate): CivilDate =>
    granularity === "day" ? c : granularity === "week" ? startOfCivilWeek(c) : startOfCivilMonth(c);
  const next = (c: CivilDate): CivilDate =>
    granularity === "day"
      ? addCivilDays(c, 1)
      : granularity === "week"
        ? addCivilDays(c, 7)
        : c.m === 12
          ? { y: c.y + 1, m: 1, d: 1 }
          : { y: c.y, m: c.m + 1, d: 1 };

  const out: ReportBucket[] = [];
  let cursor = startOf(from);
  const last = startOf(to);
  while (compareCivil(cursor, last) <= 0 && out.length < MAX_BUCKETS) {
    const after = next(cursor);
    out.push({
      key: civilToString(cursor),
      label: bucketLabel(cursor, granularity),
      start: firmDayStart(cursor),
      end: firmDayStart(after),
    });
    cursor = after;
  }
  return out;
}

/** "Sep 19" · "Week of Sep 14" · "Sep 2026". The year is added to a day label once it is not this year. */
export function bucketLabel(c: CivilDate, granularity: ReportGranularity, now: Date = new Date()): string {
  const month = MONTHS[c.m - 1] ?? pad(c.m);
  const thisYear = civilFromInstant(now).y;
  switch (granularity) {
    case "day":
      return c.y === thisYear ? `${month} ${c.d}` : `${month} ${c.d}, ${c.y}`;
    case "week":
      return c.y === thisYear ? `Week of ${month} ${c.d}` : `Week of ${month} ${c.d}, ${c.y}`;
    case "month":
      return `${month} ${c.y}`;
    default: {
      const exhaustive: never = granularity;
      return exhaustive;
    }
  }
}

/**
 * "Sep 1, 2026" from a firm-local "YYYY-MM-DD".
 *
 * Deliberately NOT `formatFirmDate`: that helper takes an INSTANT, and `new Date("2026-09-01")` is
 * parsed as UTC midnight, which is 20:00 the previous evening on the firm clock — a range labelled
 * "Aug 31 to Sep 29" for the thirty days of September. A date string is a calendar date; it never
 * becomes an instant on the way to a label.
 */
export function formatReportDate(date: string): string {
  const c = parseCivilDate(date);
  if (c === null) return date;
  const month = MONTHS[c.m - 1] ?? pad(c.m);
  return `${month} ${c.d}, ${c.y}`;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const REPORT_PRESETS = ["last-7", "last-30", "last-90", "this-month", "last-month", "ytd"] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const REPORT_PRESET_LABELS: Readonly<Record<ReportPreset, string>> = {
  "last-7": "Last 7 days",
  "last-30": "Last 30 days",
  "last-90": "Last 90 days",
  "this-month": "This month",
  "last-month": "Last month",
  ytd: "Year to date",
};

/** Firm-local dates for a preset, with the granularity that reads well over that span. */
export function presetRange(preset: ReportPreset, now: Date = new Date()): {
  from: string;
  to: string;
  granularity: ReportGranularity;
} {
  const today = civilFromInstant(now);
  switch (preset) {
    case "last-7":
      return { from: civilToString(addCivilDays(today, -6)), to: civilToString(today), granularity: "day" };
    case "last-30":
      return { from: civilToString(addCivilDays(today, -29)), to: civilToString(today), granularity: "day" };
    case "last-90":
      return { from: civilToString(addCivilDays(today, -89)), to: civilToString(today), granularity: "week" };
    case "this-month":
      return { from: civilToString(startOfCivilMonth(today)), to: civilToString(today), granularity: "day" };
    case "last-month": {
      const firstOfThis = startOfCivilMonth(today);
      const lastOfPrev = addCivilDays(firstOfThis, -1);
      return {
        from: civilToString(startOfCivilMonth(lastOfPrev)),
        to: civilToString(lastOfPrev),
        granularity: "day",
      };
    }
    case "ytd":
      return { from: civilToString({ y: today.y, m: 1, d: 1 }), to: civilToString(today), granularity: "month" };
    default: {
      const exhaustive: never = preset;
      return exhaustive;
    }
  }
}

/** Which preset a range corresponds to, for highlighting the button. Null when the dates are custom. */
export function activePreset(query: { from: string; to: string }, now: Date = new Date()): ReportPreset | null {
  for (const preset of REPORT_PRESETS) {
    const r = presetRange(preset, now);
    if (r.from === query.from && r.to === query.to) return preset;
  }
  return null;
}

// ---------------------------------------------------------------------------
// URL parsing (shared convention 12: repeated bare keys, also split on ",")
// ---------------------------------------------------------------------------

type SearchParamsLike = Record<string, string | string[] | undefined> | URLSearchParams;

function multiValue(sp: SearchParamsLike, key: string): string[] {
  const raw: string[] = sp instanceof URLSearchParams ? sp.getAll(key) : toArray(sp[key]);
  return raw
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function singleValue(sp: SearchParamsLike, key: string): string | undefined {
  const raw = sp instanceof URLSearchParams ? sp.get(key) : sp[key];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first === null || first === undefined) return undefined;
  const trimmed = first.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pickAllowed<T extends string>(values: readonly string[], allowed: readonly T[]): T[] {
  const set = new Set<T>();
  for (const v of values) if ((allowed as readonly string[]).includes(v)) set.add(v as T);
  return [...set];
}

/**
 * Tolerant, exactly like `parseTicketListQuery`: an unknown value is DROPPED and the key behaves as if
 * it were absent, so a hand-edited or stale URL renders a default report rather than a 500.
 *
 * Defaults: `volume`, the last 30 firm-local days, `day` granularity. A bare `preset=` is expanded here
 * (and never round-tripped), so a link someone pastes tomorrow shows the dates it showed today.
 */
export function parseReportQuery(sp: SearchParamsLike, now: Date = new Date()): ExtendedReportQuery {
  const keyRaw = singleValue(sp, "report") ?? singleValue(sp, "key");
  const key: ExtendedReportKey = keyRaw !== undefined && isReportKey(keyRaw) ? keyRaw : "volume";

  const presetRaw = singleValue(sp, "preset");
  const preset =
    presetRaw !== undefined && (REPORT_PRESETS as readonly string[]).includes(presetRaw)
      ? (presetRaw as ReportPreset)
      : null;
  const fallback = preset !== null ? presetRange(preset, now) : presetRange("last-30", now);

  const from = parseCivilDate(singleValue(sp, "from") ?? "") ?? parseCivilDate(fallback.from);
  const to = parseCivilDate(singleValue(sp, "to") ?? "") ?? parseCivilDate(fallback.to);
  const range = resolveRange({
    from: from === null ? fallback.from : civilToString(from),
    to: to === null ? fallback.to : civilToString(to),
  });

  const granularity =
    (pickAllowed<ReportGranularity>(multiValue(sp, "granularity"), REPORT_GRANULARITIES)[0] as
      | ReportGranularity
      | undefined) ?? fallback.granularity;

  const query: ExtendedReportQuery = {
    key,
    from: range.fromDate,
    to: range.toDate,
    granularity,
  };

  const queueKeys = pickAllowed<QueueKey>(multiValue(sp, "queueKey"), QUEUE_KEYS);
  if (queueKeys.length > 0) query.queueKey = queueKeys;
  const priorities = pickAllowed<TicketPriority>(multiValue(sp, "priority"), TICKET_PRIORITIES);
  if (priorities.length > 0) query.priority = priorities;
  const categories = pickAllowed<TicketCategory>(multiValue(sp, "category"), TICKET_CATEGORIES);
  if (categories.length > 0) query.category = categories;

  return query;
}

/**
 * The part of the query that SELECTS rows — what belongs on the `REPORT_EXPORTED` ledger row
 * (CONTRACT §3.2: `metadata {filters, range}`). The key and the range travel separately, so they are
 * stripped here rather than recorded twice.
 */
export function reportFilters(query: ExtendedReportQuery): {
  queueKey?: QueueKey[];
  priority?: TicketPriority[];
  category?: TicketCategory[];
  granularity: ReportGranularity;
} {
  const out: ReturnType<typeof reportFilters> = { granularity: query.granularity };
  if (query.queueKey !== undefined && query.queueKey.length > 0) out.queueKey = [...query.queueKey];
  if (query.priority !== undefined && query.priority.length > 0) out.priority = [...query.priority];
  if (query.category !== undefined && query.category.length > 0) out.category = [...query.category];
  return out;
}

/** `ReportKey` narrowing for the eight contract keys, used where `ReportResult` is the declared type. */
export function isContractReportKey(key: ExtendedReportKey): key is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(key);
}
