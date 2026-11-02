// Ported from trade-request server/src/services/digest.ts:5 and :88-97 (ticket).
const DIGEST_TZ = "America/New_York";

/**
 * Compute the run_date as a YYYY-MM-DD string in America/New_York. We use
 * Intl.DateTimeFormat rather than toLocaleDateString so the format is stable
 * regardless of the server locale, and so DST transitions are handled by the
 * tz database rather than by the app.
 */
export function computeRunDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DIGEST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
