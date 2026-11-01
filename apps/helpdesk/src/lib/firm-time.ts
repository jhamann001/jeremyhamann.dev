/**
 * The firm's clock (layer L1 — pure, edge- and browser-safe; imports nothing).
 *
 * Every other time helper in this repo reads the AMBIENT zone: `format.ts` renders with the process
 * or browser zone, and `new Date(y, m, d)` builds midnight in whatever zone the code happens to run
 * in. That is fine for a relative stamp ("3h ago") and wrong for anything a ticket is JUDGED by,
 * because the same ticket is rendered from both sides of the server/client boundary — a React Server
 * Component runs in the container's zone (UTC on Cloud Run) while a `"use client"` sibling runs in the
 * viewer's. A follow-up date compared against "the start of today" therefore answered two different
 * questions on one page: the header could say "Follow-up due" while the properties panel, three inches
 * below, said "Follow-up overdue", and the dashboard's Overdue filter — compiled in the server's zone —
 * agreed with neither.
 *
 * This module pins those calculations to ONE zone so the answer no longer depends on where the code ran:
 *
 *   - `startOfFirmDay` — the day boundary behind "overdue", used by `followUpState`
 *     (src/components/tickets/flag-state.ts) and by `followUpWhere` (src/server/tickets.ts), so the
 *     badge and the filter that claims to list it agree by construction.
 *   - `formatFirmDateTime` — the printed instant, suffixed with the zone label so a reader in Denver
 *     knows which clock they are reading.
 *   - `isoToFirmDateTimeLocal` / `firmDateTimeLocalToIso` — the `<input type="datetime-local">` pair, in
 *     the SAME zone, so the value the picker shows is the value the badge prints.
 *
 * Zone choice: Cedar Ridge's desk, its SLA policy and its custodians all run on US Eastern, and the repo
 * had no timezone convention at all. Eastern
 * is the recommended default, pending the owner's confirmation; it is a single constant here, and the one
 * place to change if the firm ever wants UTC or a per-user preference. It is deliberately NOT read from
 * the environment: an operator's badge and a colleague's badge for the same ticket must not disagree
 * because two containers were configured differently.
 *
 * Implementation note: `Intl.DateTimeFormat` with an explicit `timeZone` is the only zone conversion
 * available without a new dependency (date-fns v4 needs `@date-fns/tz`, which is not installed and
 * cannot be added during this wave). It carries the full IANA database in Node and every supported
 * browser, so DST is handled by the platform rather than by arithmetic here.
 */

/** IANA zone the desk's dates are judged and printed in. */
export const FIRM_TIME_ZONE = "America/New_York";

/**
 * How that zone is labelled to a human. Deliberately the DST-agnostic "ET" rather than EST/EDT: the
 * label is rendered next to instants on both sides of the hydration boundary, and a label that changes
 * with the date is one more string that can differ between the server's render and the browser's.
 */
export const FIRM_TIME_ZONE_LABEL = "ET";

/** A wall-clock reading in `FIRM_TIME_ZONE`. Months are 1-based, as a human writes them. */
export type FirmWallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Numeric parts in the firm zone. `hourCycle: "h23"` keeps midnight at 00 — "en-US" with `hour12: false`
 * still prints hour 24 on some ICU builds, which would push a midnight instant onto the previous day.
 */
const FIRM_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: FIRM_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function toDate(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  return new Date(value);
}

/** Valid means "names an instant" — `new Date("nonsense")` and `new Date(NaN)` do not. */
export function isValidInstant(value: string | number | Date): boolean {
  return !Number.isNaN(toDate(value).getTime());
}

/**
 * Wall-clock reading of `at` in the firm zone. Returns `null` for an invalid instant rather than
 * throwing: every caller here is a render path, and a render must not crash on a malformed column.
 */
export function firmWallClock(at: string | number | Date): FirmWallClock | null {
  const d = toDate(at);
  if (Number.isNaN(d.getTime())) return null;
  const parts = FIRM_PARTS.formatToParts(d);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  const hour = read("hour");
  const wc: FirmWallClock = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Belt and braces for an ICU build that still says 24 at midnight.
    hour: hour === 24 ? 0 : hour,
    minute: read("minute"),
    second: read("second"),
  };
  return Object.values(wc).some((v) => Number.isNaN(v)) ? null : wc;
}

/**
 * The firm zone's UTC offset at `at`, in milliseconds (negative west of Greenwich: -14_400_000 for EDT).
 * Derived by reading the wall clock and asking how far it sits from the same reading in UTC — the
 * standard trick, and the only one that stays correct across DST without a tz database of our own.
 */
function firmOffsetMs(at: Date): number {
  const wc = firmWallClock(at);
  if (wc === null) return 0;
  const asIfUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
  // The parts carry no milliseconds, so compare against the whole second `at` falls in.
  const wholeSecond = Math.floor(at.getTime() / 1000) * 1000;
  return asIfUtc - wholeSecond;
}

/** Whether the firm clock at `ms` reads exactly these fields. */
function readsAs(ms: number, year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  const wc = firmWallClock(new Date(ms));
  return (
    wc !== null &&
    wc.year === year &&
    wc.month === month &&
    wc.day === day &&
    wc.hour === hour &&
    wc.minute === minute &&
    wc.second === second
  );
}

/**
 * The instant at which the firm zone's clock reads the given wall-clock time.
 *
 * Two candidates: the offset measured at the naive guess, and the offset measured at the instant that
 * guess corrects to. Away from a DST change-over both agree. At one they do not, and the rule is the
 * one every date library settles on, because both cases have to answer deterministically for a
 * follow-up date:
 *
 *   - Repeated hour (fall back — 01:30 on 1 Nov happens twice): take the FIRST occurrence, i.e. the
 *     candidate that still reproduces the requested reading, which is the earlier instant.
 *   - Skipped hour (spring forward — 02:30 on 8 Mar never happens): NEITHER candidate reads back as
 *     asked, so map forward into the hour that does exist (02:30 → 03:30) rather than rejecting an
 *     operator's perfectly reasonable input or silently moving it an hour earlier.
 */
export function firmInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = naive - firmOffsetMs(new Date(naive));
  const secondPass = naive - firmOffsetMs(new Date(first));
  if (first === secondPass) return new Date(first);
  if (readsAs(first, year, month, day, hour, minute, second)) return new Date(first);
  if (readsAs(secondPass, year, month, day, hour, minute, second)) return new Date(secondPass);
  // A gap: both readings overshoot. The later instant is the forward mapping.
  return new Date(Math.max(first, secondPass));
}

/**
 * Midnight of `now`'s firm-zone date, as an instant. This is the "overdue" boundary: a follow-up before
 * it belongs to a day the desk has already worked through, wherever the code asking the question runs.
 */
export function startOfFirmDay(now: Date = new Date()): Date {
  const wc = firmWallClock(now);
  if (wc === null) return new Date(Number.NaN);
  return firmInstant(wc.year, wc.month, wc.day, 0, 0, 0);
}

/**
 * "Sep 19, 2026 14:30 ET" — `formatDateTime`'s pattern plus an explicit zone. Em dash for an instant
 * that cannot be read, matching `formatDateTime`.
 */
export function formatFirmDateTime(value: string | number | Date): string {
  const wc = firmWallClock(value);
  if (wc === null) return "—";
  const month = MONTH_ABBREVIATIONS[wc.month - 1] ?? pad(wc.month);
  return `${month} ${wc.day}, ${wc.year} ${pad(wc.hour)}:${pad(wc.minute)} ${FIRM_TIME_ZONE_LABEL}`;
}

/** "Sep 19, 2026 ET" — the date alone, for a surface that does not care about the minute. */
export function formatFirmDate(value: string | number | Date): string {
  const wc = firmWallClock(value);
  if (wc === null) return "—";
  const month = MONTH_ABBREVIATIONS[wc.month - 1] ?? pad(wc.month);
  return `${month} ${wc.day}, ${wc.year}`;
}

// ---------------------------------------------------------------------------
// <input type="datetime-local"> ⇄ ISO instant, in the firm zone
// ---------------------------------------------------------------------------

const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

/**
 * Whether these fields name a real civil date-and-time — 2026-02-31 and 25:00 do not. Checked in UTC
 * on purpose: calendar validity is a property of the numbers, not of any zone, and doing it here means
 * `firmDateTimeLocalToIso` never has to reject a legitimate value that merely falls in a DST gap.
 */
function isRealCivilTime(year: number, month: number, day: number, hour: number, minute: number): boolean {
  const ms = Date.UTC(year, month - 1, day, hour, minute);
  const d = new Date(ms);
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day &&
    d.getUTCHours() === hour &&
    d.getUTCMinutes() === minute
  );
}

/** ISO instant → "YYYY-MM-DDTHH:mm" on the firm clock. Empty string for null/unparseable. */
export function isoToFirmDateTimeLocal(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return "";
  const wc = firmWallClock(iso);
  if (wc === null) return "";
  return `${pad(wc.year, 4)}-${pad(wc.month)}-${pad(wc.day)}T${pad(wc.hour)}:${pad(wc.minute)}`;
}

/** "YYYY-MM-DDTHH:mm" on the firm clock → ISO instant. `null` for an empty or impossible value. */
export function firmDateTimeLocalToIso(value: string): string | null {
  const m = DATETIME_LOCAL_PATTERN.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (!isRealCivilTime(year, month, day, hour, minute)) return null;
  const at = firmInstant(year, month, day, hour, minute, 0);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
