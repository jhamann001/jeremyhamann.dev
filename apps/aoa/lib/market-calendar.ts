/**
 * Shared NYSE trading-calendar helpers for data freshness and trade reconciliation.
 *
 * Everything here is CALENDAR-DATE based (no intraday times): a "date" is a
 * `YYYY-MM-DD` string interpreted in the America/New_York (ET) calendar. The
 * feed we monitor (`mirror.client_account_aum`) carries an `as_of` SOD date, and
 * the freshness rule is expressed in whole trading days — so ET calendar dates,
 * not instants, are the right unit.
 *
 * A trading day = a weekday (Mon–Fri) that is NOT a NYSE holiday. We deliberately
 * do NOT model the NYSE half-days (day after Thanksgiving, Christmas Eve, July 3
 * early closes): a shortened session still PRODUCES an SOD `as_of`, so it counts
 * as a full trading day for freshness purposes.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️ MAINTENANCE (MUST READ): the holiday table below is HARDCODED for 2025–2028,
 * using the NYSE-published closure dates. It is intentionally a static table
 * rather than an algorithmic computation (nth-weekday rules + Easter/Good-Friday)
 * because a small audited table is easier to verify by eye and cannot drift on a
 * subtle date-math bug. THE COST is that it MUST be extended by hand each year.
 * The annual `nyse-calendar-maintenance.yml` workflow runs the calendar tests and
 * requires coverage through two years beyond the current ET year. `holidaysForYear`
 * also THROWS outside the table so a lapse fails loud instead of silently treating
 * every holiday as a normal trading day. Official source:
 * https://www.nyse.com/markets/hours-calendars
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * NYSE holidays with their OBSERVED dates (weekend-observance already applied:
 * a holiday falling on Saturday is observed the preceding Friday; on Sunday, the
 * following Monday — the NYSE convention). A normal year lists 10 closures:
 * New Year's Day, MLK Day (3rd Mon Jan), Washington's Birthday / Presidents' Day
 * (3rd Mon Feb), Good Friday, Memorial Day (last Mon May), Juneteenth (Jun 19 obs),
 * Independence Day (Jul 4 obs), Labor Day (1st Mon Sep), Thanksgiving (4th Thu Nov),
 * and Christmas (Dec 25 obs). NYSE publishes exceptions explicitly: 2028 has nine
 * closures because New Year's Day falls on Saturday and is not observed.
 *
 * Verified examples: 2026 Jul 4 (Sat) → observed Fri Jul 3; 2027 Juneteenth (Sat)
 * → observed Fri Jun 18; 2027 Christmas (Sat) → observed Fri Dec 24; 2028 Jan 1
 * (Sat) → no observed closure.
 */
const NYSE_HOLIDAYS_BY_YEAR: Record<number, readonly string[]> = {
  2025: [
    "2025-01-01", // New Year's Day
    "2025-01-20", // MLK Day
    "2025-02-17", // Washington's Birthday
    "2025-04-18", // Good Friday
    "2025-05-26", // Memorial Day
    "2025-06-19", // Juneteenth
    "2025-07-04", // Independence Day
    "2025-09-01", // Labor Day
    "2025-11-27", // Thanksgiving
    "2025-12-25", // Christmas
  ],
  2026: [
    "2026-01-01", // New Year's Day
    "2026-01-19", // MLK Day
    "2026-02-16", // Washington's Birthday
    "2026-04-03", // Good Friday
    "2026-05-25", // Memorial Day
    "2026-06-19", // Juneteenth
    "2026-07-03", // Independence Day (Jul 4 is a Saturday → observed Fri)
    "2026-09-07", // Labor Day
    "2026-11-26", // Thanksgiving
    "2026-12-25", // Christmas
  ],
  2027: [
    "2027-01-01", // New Year's Day
    "2027-01-18", // MLK Day
    "2027-02-15", // Washington's Birthday
    "2027-03-26", // Good Friday
    "2027-05-31", // Memorial Day
    "2027-06-18", // Juneteenth (Jun 19 is a Saturday → observed Fri)
    "2027-07-05", // Independence Day (Jul 4 is a Sunday → observed Mon)
    "2027-09-06", // Labor Day
    "2027-11-25", // Thanksgiving
    "2027-12-24", // Christmas (Dec 25 is a Saturday → observed Fri)
  ],
  2028: [
    // No New Year's Day closure: Jan 1 is Saturday and NYSE does not observe it.
    "2028-01-17", // MLK Day
    "2028-02-21", // Washington's Birthday
    "2028-04-14", // Good Friday
    "2028-05-29", // Memorial Day
    "2028-06-19", // Juneteenth
    "2028-07-04", // Independence Day
    "2028-09-04", // Labor Day
    "2028-11-23", // Thanksgiving
    "2028-12-25", // Christmas
  ],
};

const SUPPORTED_YEARS = Object.keys(NYSE_HOLIDAYS_BY_YEAR)
  .map(Number)
  .sort((a, b) => a - b);

/** A `Set<YYYY-MM-DD>` of every observed holiday across all supported years. */
const HOLIDAY_SET: ReadonlySet<string> = new Set(
  Object.values(NYSE_HOLIDAYS_BY_YEAR).flat(),
);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize a `string | Date` input to a `YYYY-MM-DD` ET calendar-date string.
 * A `Date` (an instant) is projected onto the America/New_York calendar via
 * `en-CA` (which formats as `YYYY-MM-DD`), so callers can pass `new Date()` and
 * get "today in New York". A string is validated and returned as-is.
 */
export function toDateStr(d: string | Date): string {
  if (typeof d === "string") {
    if (!DATE_RE.test(d)) {
      throw new Error(`market-calendar: expected YYYY-MM-DD, got "${d}"`);
    }
    return d;
  }
  // en-CA renders as YYYY-MM-DD; the timeZone projects the instant onto ET.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Parse `YYYY-MM-DD` as a UTC-midnight Date purely for weekday/step math. */
function parseUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

/** Add `n` whole days to a `YYYY-MM-DD` string (UTC math, TZ-agnostic). */
function addDays(dateStr: string, n: number): string {
  const d = parseUtc(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Sat/Sun in the calendar sense (UTC-midnight parse keeps the weekday stable). */
function isWeekend(dateStr: string): boolean {
  const dow = parseUtc(dateStr).getUTCDay(); // 0 = Sun, 6 = Sat
  return dow === 0 || dow === 6;
}

/**
 * Observed NYSE holidays for a supported year. THROWS for an unsupported year so
 * a lapsed table fails loud rather than silently classifying holidays as trading
 * days (see the MAINTENANCE note at the top of this file).
 */
export function holidaysForYear(year: number): readonly string[] {
  const holidays = NYSE_HOLIDAYS_BY_YEAR[year];
  if (!holidays) {
    throw new Error(
      `market-calendar: no NYSE holiday table for ${year}; supported years are ` +
        `${SUPPORTED_YEARS.join(", ")}. Extend NYSE_HOLIDAYS_BY_YEAR (see the ` +
        `MAINTENANCE note in lib/market-calendar.ts).`,
    );
  }
  return holidays;
}

/** True when `d` is a NYSE observed holiday (within the supported table). */
export function isHoliday(d: string | Date): boolean {
  return HOLIDAY_SET.has(toDateStr(d));
}

/** True when `d` is a NYSE trading day: a weekday that is not a holiday.
 * Fails loud for a year outside the maintained table: holidaysForYear throws,
 * which the freshness route's catch maps to a 500 — rather than silently
 * treating that year's holidays as trading days and mis-firing the monitor. */
export function isTradingDay(d: string | Date): boolean {
  const dateStr = toDateStr(d);
  holidaysForYear(Number(dateStr.slice(0, 4))); // throws on an unsupported year
  return !isWeekend(dateStr) && !HOLIDAY_SET.has(dateStr);
}

/**
 * The latest trading day STRICTLY BEFORE `d`. On a Tuesday this is Monday (T-1);
 * on a Monday it steps back over the weekend to Friday (the "T-3" case); after a
 * holiday it steps back over the holiday too. Bounded to ~10 steps so a run of
 * consecutive non-trading days (weekend + holidays) can never loop unbounded.
 */
export function previousTradingDay(d: string | Date): string {
  const from = toDateStr(d);
  holidaysForYear(Number(from.slice(0, 4))); // fail loud on an unsupported input year
  let cur = addDays(from, -1);
  for (let i = 0; i < 10; i++) {
    if (isTradingDay(cur)) return cur;
    cur = addDays(cur, -1);
  }
  throw new Error(
    `market-calendar: no trading day found within 10 days before ${toDateStr(d)} ` +
      `(holiday table likely lapsed — see MAINTENANCE note)`,
  );
}

/**
 * The earliest trading day STRICTLY AFTER `d`. This is the operational run
 * date for a reconciliation whose source records belong to trade date `d`.
 */
export function nextTradingDay(d: string | Date): string {
  const from = toDateStr(d);
  holidaysForYear(Number(from.slice(0, 4)));
  let cur = addDays(from, 1);
  for (let i = 0; i < 10; i++) {
    if (isTradingDay(cur)) return cur;
    cur = addDays(cur, 1);
  }
  throw new Error(
    `market-calendar: no trading day found within 10 days after ${toDateStr(d)} ` +
      `(holiday table likely lapsed — see MAINTENANCE note)`,
  );
}

/**
 * `d` itself if it is a trading day, otherwise the latest trading day before it.
 * (For a weekend/holiday `d`, this equals `previousTradingDay(d)`.)
 */
export function mostRecentTradingDay(d: string | Date): string {
  const dateStr = toDateStr(d);
  return isTradingDay(dateStr) ? dateStr : previousTradingDay(dateStr);
}

/**
 * Count trading days in the half-open range (`startExclusive`, `endInclusive`].
 * Returns 0 when `endInclusive <= startExclusive`. Used to express "how many
 * trading days stale" as the number of trading days between the freshest `as_of`
 * (exclusive) and the expected minimum `as_of` (inclusive).
 */
export function tradingDaysBetween(
  startExclusive: string | Date,
  endInclusive: string | Date,
): number {
  const start = toDateStr(startExclusive);
  const end = toDateStr(endInclusive);
  if (end <= start) return 0;
  let count = 0;
  let cur = addDays(start, 1);
  // Bounded: never walk more than ~1 year of calendar days.
  for (let i = 0; i < 400 && cur <= end; i++) {
    if (isTradingDay(cur)) count++;
    cur = addDays(cur, 1);
  }
  return count;
}
