import "server-only";
import { CronExpressionParser } from "cron-parser";
import { safeCron, safeTimezone } from "./http";

/**
 * Only deterministic ordinary cron fields. Hashed/jittered, provider-specific
 * syntax and DOM+DOW combinations fail closed rather than guessing semantics.
 * n8n interval triggers also carry an unexposed seconds anchor and cannot be
 * converted into exact cron start times from their cadence alone.
 */
export function nextCronRun(expression: unknown, timezone: unknown, now: Date): string | null {
  const cron = safeCron(expression);
  const tz = safeTimezone(timezone);
  if (!cron || !tz || !Number.isFinite(now.getTime())) return null;
  const numeric = cron.replace(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT)\b/gi, "0");
  if (!/^[0-9*?,/\- ]+$/.test(numeric)) return null;
  const fields = cron.split(/\s+/);
  const six = fields.length === 5 ? ["0", ...fields] : fields;
  if (six[3] !== "*" && six[3] !== "?" && six[5] !== "*" && six[5] !== "?") return null;
  try {
    return CronExpressionParser.parse(six.join(" "), {
      currentDate: now, tz, endDate: new Date(now.getTime() + 366 * 86_400_000),
    }).next().toISOString();
  } catch { return null; }
}
