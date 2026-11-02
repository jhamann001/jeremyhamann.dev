import { isTradingDay, previousTradingDay } from "@/lib/market-calendar";

/**
 * Resolve the source trade date shown beside a user-selected operational run
 * date. Invalid, future, weekend, holiday, and unsupported dates stay blank;
 * the server action repeats this validation before querying either source.
 */
export function tradeDateForRunDate(runDate: string, maximumRunDate: string): string | null {
  if (!runDate || runDate > maximumRunDate) return null;
  try {
    return isTradingDay(runDate) ? previousTradingDay(runDate) : null;
  } catch {
    return null;
  }
}
