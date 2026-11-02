// America/New_York rules for the Trade Request cutover (ticket): the weekday morning job window
// (07:30-10:00, the digest at 08:00 and the drift check at 09:15) and the 60-minute freeze window.

export const CUTOVER_TIME_ZONE = "America/New_York";
export const FREEZE_WINDOW_MS = 60 * 60_000;
const MORNING_START_MINUTE = 7 * 60 + 30;
const MORNING_END_MINUTE = 10 * 60;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: CUTOVER_TIME_ZONE,
  hourCycle: "h23",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export type NewYorkTime = { date: string; weekday: number; minuteOfDay: number; second: number };

export function newYorkTime(at: Date): NewYorkTime {
  const parts = Object.fromEntries(formatter.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[parts.weekday] ?? -1,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    second: Number(parts.second),
  };
}

/** True from 07:30:00 up to (not including) 10:00:00 America/New_York, Monday to Friday. */
export function inMorningWindow(at: Date): boolean {
  const t = newYorkTime(at);
  return t.weekday >= 1 && t.weekday <= 5 && t.minuteOfDay >= MORNING_START_MINUTE && t.minuteOfDay < MORNING_END_MINUTE;
}

/**
 * A freeze starting at `start` occupies [start, start + 60 min]. It is refused when any instant of that window
 * falls in a weekday morning window. Sampling every minute from `start` through the end is exact: the morning
 * window starts on a minute boundary and lasts 150 minutes, so a window that enters it contains a sample in it.
 */
export function freezeWindowRefusal(start: Date): string | null {
  for (let minute = 0; minute <= FREEZE_WINDOW_MS / 60_000; minute++) {
    if (inMorningWindow(new Date(start.getTime() + minute * 60_000))) {
      return "a freeze's 60-minute window may not touch 07:30-10:00 America/New_York on a weekday";
    }
  }
  return null;
}

/**
 * Inside a weekday morning window, the instant of 10:00:00 America/New_York that day; otherwise null.
 * Daylight-saving changes happen at 02:00 on Sundays, never between 07:30 and 10:00 on a weekday, so
 * adding the remaining local minutes is exact.
 */
export function morningRelease(at: Date): Date | null {
  if (!inMorningWindow(at)) return null;
  const t = newYorkTime(at);
  const msIntoSecond = at.getTime() % 1000;
  return new Date(at.getTime() + (MORNING_END_MINUTE - t.minuteOfDay) * 60_000 - t.second * 1000 - msIntoSecond);
}
