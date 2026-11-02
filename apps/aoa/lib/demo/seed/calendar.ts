// The firm's calendar for the demo seed: New York days and DTCC ACATS business days, ported from the Transfer
// Tracker demo (src/lib/demo/universe.ts) so a ported plan lands on the same days. Every date the seed writes is
// relative to the seed's `now`, so the data never looks stale after a reset.

import { isBusinessDay } from "../stand-ins/tracker-analytics";
import { seededInt } from "./universe";

const FIRM_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });

/** Today's date in New York, YYYY-MM-DD. */
export const firmToday = (now: Date): string => FIRM_DAY.format(now);

const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

export const isFirmBusinessDay = (day: string): boolean => isBusinessDay(utc(day));

/** The business day on or before `day`. */
export function businessDayOnOrBefore(day: string): string {
  const cursor = utc(day);
  while (!isBusinessDay(cursor)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  return iso(cursor);
}

/** `n` business days after `day` (before it when negative), counting only market days. */
export function addBusinessDays(day: string, n: number): string {
  const cursor = utc(day);
  const step = n < 0 ? -1 : 1;
  for (let left = Math.abs(n); left > 0; ) {
    cursor.setUTCDate(cursor.getUTCDate() + step);
    if (isBusinessDay(cursor)) left--;
  }
  return iso(cursor);
}

/** How many business days `later` is after `earlier` (0 when the same day). */
export function businessDaysBetween(earlier: string, later: string): number {
  let count = 0;
  for (let cursor = utc(earlier); iso(cursor) < later; ) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isBusinessDay(cursor)) count++;
  }
  return count;
}

/** `n` calendar days after `day` (before it when negative). */
export function addCalendarDays(day: string, n: number): string {
  const cursor = utc(day);
  cursor.setUTCDate(cursor.getUTCDate() + n);
  return iso(cursor);
}

/** Calendar days from `earlier` to `later` (YYYY-MM-DD). */
export const calendarDaysBetween = (earlier: string, later: string): number =>
  Math.round((utc(later).getTime() - utc(earlier).getTime()) / 86_400_000);

const NEW_YORK_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });

/** Hours New York is behind UTC on `day`: 4 during daylight saving, 5 outside it (read at noon UTC, clear of the switch). */
export function newYorkOffsetHours(day: string): number {
  const noon = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 12));
  return 12 - Number(NEW_YORK_HOUR.format(noon));
}

/** A New York business day at a working-hours time (9:00 to 16:59 in New York), as an instant. */
export function businessInstant(day: string, key: string): Date {
  const hour = seededInt(`${key}:hour`, 9, 16);
  const minute = seededInt(`${key}:minute`, 0, 59);
  const offset = newYorkOffsetHours(day);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hour + offset, minute));
}

/**
 * A business instant that is never after `now`. When the seed runs before the working day, today's working hours
 * haven't happened yet; they are squeezed into the time since midnight in New York, in the same order, so the day
 * still reads as history.
 */
export function pastBusinessInstant(day: string, key: string, now: Date): Date {
  const at = businessInstant(day, key);
  if (at.getTime() <= now.getTime()) return at;
  const [y, m, d] = [Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))];
  const offset = newYorkOffsetHours(day);
  const midnight = Date.UTC(y, m, d, offset);
  const open = Date.UTC(y, m, d, 9 + offset);
  const close = Date.UTC(y, m, d, 17 + offset);
  const room = Math.max(0, now.getTime() - midnight - 60_000);
  return new Date(Math.min(now.getTime(), Math.round(midnight + ((at.getTime() - open) / (close - open)) * room)));
}
