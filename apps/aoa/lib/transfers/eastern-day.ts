// Client-safe: the workspace's "today" is the Eastern calendar day, as in the mockup.
const EASTERN_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

export function easternToday(now: Date = new Date()): string {
  return EASTERN_DAY.format(now);
}

/** A strict YYYY-MM-DD as a UTC-midnight Date, or null. */
export function parseIsoDay(text: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text ? null : day;
}
