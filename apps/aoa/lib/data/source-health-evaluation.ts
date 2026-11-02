export const SOURCE_HEALTH_MAX_AGE_HOURS = 26;
export const SOURCE_HEALTH_ATTEMPT_GRACE_HOURS = 1;

export type SourceHealthStatus =
  | "HEALTHY"
  | "ATTENTION"
  | "UNKNOWN"
  | "AVAILABLE";

export type ScheduledSourceEvidence = {
  latestSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastFailureAt: string | null;
  maxAgeHours?: number;
  attemptGraceHours?: number;
};

export type ScheduledSourceDecision = {
  status: Exclude<SourceHealthStatus, "AVAILABLE">;
  reason:
    | "recent_success"
    | "missing_success"
    | "stale_success"
    | "newer_failure"
    | "stalled_attempt"
    | "schedule_unverified";
};

function instant(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Classify only persisted operational evidence. A fresh source row is not a
 * substitute for a committed-success record, and a failed/newer attempt wins
 * over an older success until another success is recorded.
 */
export function evaluateScheduledSource(
  evidence: ScheduledSourceEvidence,
  now: Date = new Date(),
): ScheduledSourceDecision {
  const success = instant(evidence.latestSuccessAt);
  const attempt = instant(evidence.lastAttemptAt);
  const failure = instant(evidence.lastFailureAt);
  const maxAgeMs =
    (evidence.maxAgeHours ?? SOURCE_HEALTH_MAX_AGE_HOURS) * 3_600_000;
  const attemptGraceMs =
    (evidence.attemptGraceHours ?? SOURCE_HEALTH_ATTEMPT_GRACE_HOURS) *
    3_600_000;

  if (failure != null && (success == null || failure > success)) {
    return { status: "ATTENTION", reason: "newer_failure" };
  }
  if (
    attempt != null &&
    (success == null || attempt > success) &&
    now.getTime() - attempt > attemptGraceMs
  ) {
    return { status: "ATTENTION", reason: "stalled_attempt" };
  }
  if (success == null) {
    return { status: "UNKNOWN", reason: "missing_success" };
  }
  if (now.getTime() - success > maxAgeMs) {
    return { status: "ATTENTION", reason: "stale_success" };
  }
  return { status: "HEALTHY", reason: "recent_success" };
}

function etParts(value: Date): {
  date: string;
  weekday: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const weekdays: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    weekday: weekdays[part("weekday")] ?? 0,
    hour: Number(part("hour")),
    minute: Number(part("minute")),
  };
}

function priorWeekday(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  do date.setUTCDate(date.getUTCDate() - 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}

/** Whether today's weekday run is past its documented ET grace boundary. */
export function isWeekdayRunDue(
  now: Date,
  boundaryHourEt: number,
): boolean {
  const et = etParts(now);
  return et.weekday >= 1 && et.weekday <= 5 && et.hour >= boundaryHourEt;
}

/**
 * Latest weekday calendar date whose run should be complete. This is a run
 * schedule calculation, not a source business-date or trading-calendar rule.
 */
export function expectedWeekdayCompletionDate(
  now: Date,
  boundaryHourEt: number,
): string {
  const et = etParts(now);
  return isWeekdayRunDue(now, boundaryHourEt) ? et.date : priorWeekday(et.date);
}

/**
 * Calendar date of the latest weekday AUM run that should already be complete.
 * The production sequence finishes by 10:15 ET; 11:00 ET is the dashboard's
 * explicit grace boundary. Weekends and Monday before that boundary expect the
 * preceding Friday, avoiding a false stale result while no run is scheduled.
 */
export function expectedAumCompletionDate(now: Date): string {
  return expectedWeekdayCompletionDate(now, 11);
}

function evaluateCompletionDate(
  evidence: Omit<ScheduledSourceEvidence, "maxAgeHours">,
  now: Date,
  expectedDate: string,
): ScheduledSourceDecision {
  const success = instant(evidence.latestSuccessAt);
  const attempt = instant(evidence.lastAttemptAt);
  const failure = instant(evidence.lastFailureAt);
  const attemptGraceMs =
    (evidence.attemptGraceHours ?? SOURCE_HEALTH_ATTEMPT_GRACE_HOURS) *
    3_600_000;

  if (failure != null && (success == null || failure > success)) {
    return { status: "ATTENTION", reason: "newer_failure" };
  }
  if (
    attempt != null &&
    (success == null || attempt > success) &&
    now.getTime() - attempt > attemptGraceMs
  ) {
    return { status: "ATTENTION", reason: "stalled_attempt" };
  }
  if (success == null) {
    return { status: "UNKNOWN", reason: "missing_success" };
  }
  const successDate = etParts(new Date(success)).date;
  if (successDate < expectedDate) {
    return { status: "ATTENTION", reason: "stale_success" };
  }
  return { status: "HEALTHY", reason: "recent_success" };
}

/** Classify durable AUM completion evidence against its weekday ET schedule. */
export function evaluateAumCompletion(
  evidence: Omit<ScheduledSourceEvidence, "maxAgeHours">,
  now: Date = new Date(),
): ScheduledSourceDecision {
  return evaluateCompletionDate(
    evidence,
    now,
    expectedAumCompletionDate(now),
  );
}

/** Classify a recurring weekday completion, with an explicit ET grace hour. */
export function evaluateWeekdayCompletion(
  evidence: Omit<ScheduledSourceEvidence, "maxAgeHours">,
  now: Date,
  boundaryHourEt: number,
): ScheduledSourceDecision {
  return evaluateCompletionDate(
    evidence,
    now,
    expectedWeekdayCompletionDate(now, boundaryHourEt),
  );
}

function hourSlot(date: string, hour: number): string {
  return `${date}T${String(hour).padStart(2, "0")}`;
}

/**
 * Latest hourly weekday run slot that should have completed. The scheduler runs
 * at minute zero. During the grace window the prior scheduled hour remains
 * current; weekends expect Friday's final 23:00 run through Monday's first-run
 * grace.
 */
export function expectedHourlyWeekdayCompletionSlot(
  now: Date,
  graceMinutes: number,
): string {
  const et = etParts(now);
  const weekday = et.weekday >= 1 && et.weekday <= 5;
  if (!weekday) return hourSlot(priorWeekday(et.date), 23);
  if (et.minute >= graceMinutes) return hourSlot(et.date, et.hour);
  if (et.hour > 0) return hourSlot(et.date, et.hour - 1);
  return hourSlot(priorWeekday(et.date), 23);
}

/** Classify an every-hour weekday completion with an explicit minute grace. */
export function evaluateHourlyWeekdayCompletion(
  evidence: Omit<ScheduledSourceEvidence, "maxAgeHours">,
  now: Date,
  graceMinutes: number,
): ScheduledSourceDecision {
  const success = instant(evidence.latestSuccessAt);
  const attempt = instant(evidence.lastAttemptAt);
  const failure = instant(evidence.lastFailureAt);
  const attemptGraceMs =
    (evidence.attemptGraceHours ?? SOURCE_HEALTH_ATTEMPT_GRACE_HOURS) *
    3_600_000;

  if (failure != null && (success == null || failure > success)) {
    return { status: "ATTENTION", reason: "newer_failure" };
  }
  if (
    attempt != null &&
    (success == null || attempt > success) &&
    now.getTime() - attempt > attemptGraceMs
  ) {
    return { status: "ATTENTION", reason: "stalled_attempt" };
  }
  if (success == null) {
    return { status: "UNKNOWN", reason: "missing_success" };
  }
  const successEt = etParts(new Date(success));
  if (
    hourSlot(successEt.date, successEt.hour) <
    expectedHourlyWeekdayCompletionSlot(now, graceMinutes)
  ) {
    return { status: "ATTENTION", reason: "stale_success" };
  }
  return { status: "HEALTHY", reason: "recent_success" };
}

/**
 * Preserve recorded evidence without claiming freshness until Operations has
 * durably established that the recurring caller is active.
 */
export function evaluateUnverifiedSchedule(
  evidence: ScheduledSourceEvidence,
): ScheduledSourceDecision {
  const success = instant(evidence.latestSuccessAt);
  const failure = instant(evidence.lastFailureAt);
  if (failure != null && (success == null || failure > success)) {
    return { status: "ATTENTION", reason: "newer_failure" };
  }
  return { status: "UNKNOWN", reason: "schedule_unverified" };
}

const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Format a source-owned calendar date without ever constructing a Date. */
export function formatSourceBusinessDate(value: string | null): string {
  if (!value) return "Not available";
  const match = BUSINESS_DATE.exec(value);
  if (!match) return value;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return value;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[month - 1]} ${day}, ${match[1]}`;
}

/** Format operational instants explicitly in the business timezone. */
export function formatOperationalTimestamp(value: string | null): string {
  if (!value) return "Not available";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(parsed);
}
