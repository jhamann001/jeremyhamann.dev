export const EMPLOYEE_ROSTER_REMINDER_HREF = "/crm/employees";
export const EMPLOYEE_ROSTER_OVERDUE_BUSINESS_DAYS = 10;

export type EmployeeRosterReminderState = "CURRENT" | "DUE" | "OVERDUE";

export type EmployeeRosterReminder = {
  state: EmployeeRosterReminderState;
  requiredThrough: string;
  dueDate: string;
  overdueDate: string;
  nextReminderDate: string;
  activeEffectiveDate: string | null;
  notification: null | {
    id: string;
    title: string;
    body: string;
    href: typeof EMPLOYEE_ROSTER_REMINDER_HREF;
    tone: "amber" | "red";
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_TIME_ZONE = "America/New_York";

function dateOnly(value: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value);
  const part = (type: "year" | "month" | "day") => Number(
    parts.find((candidate) => candidate.type === type)?.value,
  );
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isNewYearsHoliday(value: Date): boolean {
  if (value.getUTCMonth() !== 0) return false;
  if (value.getUTCDate() === 1) return true;
  return value.getUTCDate() === 2
    && value.getUTCDay() === 1
    && new Date(Date.UTC(value.getUTCFullYear(), 0, 1)).getUTCDay() === 0;
}

function isBusinessDay(value: Date): boolean {
  return value.getUTCDay() !== 0 && value.getUTCDay() !== 6 && !isNewYearsHoliday(value);
}

function firstBusinessDayAfter(value: Date): Date {
  const next = new Date(value.getTime() + DAY_MS);
  while (!isBusinessDay(next)) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function addBusinessDays(value: Date, days: number): Date {
  const result = new Date(value);
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (isBusinessDay(result)) remaining -= 1;
  }
  return result;
}

function priorQuarterEnd(today: Date): Date {
  const quarterStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(today.getUTCFullYear(), quarterStartMonth, 0));
}

function currentQuarterEnd(today: Date): Date {
  const quarterStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(today.getUTCFullYear(), quarterStartMonth + 3, 0));
}

/**
 * Compute the single quarterly roster action from the authoritative applied
 * snapshot. This is intentionally pure: every page load derives the same
 * reminder, so there is nothing to duplicate, dismiss, or silently lose.
 */
export function evaluateEmployeeRosterReminder(input: {
  activeEffectiveDate: string | null;
  now?: Date;
}): EmployeeRosterReminder {
  const today = dateOnly(input.now ?? new Date());
  const requiredThroughDate = priorQuarterEnd(today);
  const dueDate = firstBusinessDayAfter(requiredThroughDate);
  const overdueDate = addBusinessDays(dueDate, EMPLOYEE_ROSTER_OVERDUE_BUSINESS_DAYS);
  const nextReminderDate = firstBusinessDayAfter(currentQuarterEnd(today));
  const activeDate = input.activeEffectiveDate && /^\d{4}-\d{2}-\d{2}$/.test(input.activeEffectiveDate)
    ? new Date(`${input.activeEffectiveDate}T00:00:00.000Z`)
    : null;
  const covered = activeDate != null
    && !Number.isNaN(activeDate.valueOf())
    && activeDate >= requiredThroughDate;
  const reminderHasStarted = today >= dueDate;
  const state: EmployeeRosterReminderState = covered || !reminderHasStarted
    ? "CURRENT"
    : today >= overdueDate ? "OVERDUE" : "DUE";
  const requiredThrough = isoDate(requiredThroughDate);

  return {
    state,
    requiredThrough,
    dueDate: isoDate(dueDate),
    overdueDate: isoDate(overdueDate),
    nextReminderDate: isoDate(nextReminderDate),
    activeEffectiveDate: input.activeEffectiveDate,
    notification: state === "CURRENT" ? null : {
      id: `employee-roster:${requiredThrough}`,
      title: state === "OVERDUE"
        ? "Employee roster refresh overdue"
        : "Quarterly employee roster refresh due",
      body: `Upload and apply a complete Rippling report covering changes through ${requiredThrough}.`,
      href: EMPLOYEE_ROSTER_REMINDER_HREF,
      tone: state === "OVERDUE" ? "red" : "amber",
    },
  };
}
