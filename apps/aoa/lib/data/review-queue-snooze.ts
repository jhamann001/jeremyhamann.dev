const BUSINESS_TIME_ZONE = "America/New_York";
const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function partsAt(instant: Date): Record<string, number> {
  return Object.fromEntries(
    dateTimeFormatter.formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function newYorkMidnightUtc(year: number, month: number, day: number): Date {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const local = partsAt(new Date(guess));
    const represented = Date.UTC(
      local.year, local.month - 1, local.day, local.hour, local.minute, local.second,
    );
    guess += target - represented;
  }
  return new Date(guess);
}

/** Wake at 00:00 America/New_York on the day after the selected business date. */
export function snoozeUntilForBusinessDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const selected = new Date(Date.UTC(year, month - 1, day));
  if (
    selected.getUTCFullYear() !== year ||
    selected.getUTCMonth() !== month - 1 ||
    selected.getUTCDate() !== day
  ) return null;
  selected.setUTCDate(selected.getUTCDate() + 1);
  return newYorkMidnightUtc(
    selected.getUTCFullYear(), selected.getUTCMonth() + 1, selected.getUTCDate(),
  );
}
