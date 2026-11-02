// Turns the sample data's "days before the seed's day" back into dates. The nightly reset seeds the demo each morning
// (New York time), so the seed's day is the business day on or before today there, and the seed counts recent
// activity in business days (seed/activity.ts) and account openings in calendar days (seed/people.ts). `now` is the
// seed's clock where the caller has it (clock.ts reads it, server side), so the samples keep the database's day;
// otherwise the wall clock. Safe to import from client code.

import { isBusinessDay } from "../stand-ins/tracker-analytics";

const FIRM_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** Beyond this many days a sample date is an account's opening or funding, counted in calendar days. */
export const RECENT_DAYS = 60;

/** The seed's day: the business day on or before today in New York, at UTC midnight. */
export function seedDay(now = new Date()): Date {
  const day = new Date(`${FIRM_DAY.format(now)}T00:00:00Z`);
  while (!isBusinessDay(day)) day.setUTCDate(day.getUTCDate() - 1);
  return day;
}

/** The date `daysAgo` before the seed's day: business days for recent activity, calendar days beyond RECENT_DAYS. */
export function sampleDate(daysAgo: number, now = new Date()): Date {
  const day = seedDay(now);
  if (daysAgo > RECENT_DAYS) {
    day.setUTCDate(day.getUTCDate() - daysAgo);
    return day;
  }
  for (let left = daysAgo; left > 0; ) {
    day.setUTCDate(day.getUTCDate() - 1);
    if (isBusinessDay(day)) left--;
  }
  return day;
}

/** "Today", "Oct 28" within RECENT_DAYS, "Oct 2023" beyond. */
export function sampleWhen(daysAgo: number, now = new Date()): string {
  if (daysAgo <= 0) return "Today";
  const date = sampleDate(daysAgo, now);
  return daysAgo > RECENT_DAYS ? MONTH.format(date) : SHORT.format(date);
}

export const sampleShortDate = (daysAgo: number, now = new Date()): string => SHORT.format(sampleDate(daysAgo, now));
export const sampleLongDate = (daysAgo: number, now = new Date()): string => LONG.format(sampleDate(daysAgo, now));
export const sampleIsoDate = (daysAgo: number, now = new Date()): string => sampleDate(daysAgo, now).toISOString().slice(0, 10);
