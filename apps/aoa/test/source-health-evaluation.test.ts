import { describe, expect, it } from "vitest";
import {
  evaluateAumCompletion,
  evaluateHourlyWeekdayCompletion,
  evaluateScheduledSource,
  evaluateUnverifiedSchedule,
  expectedAumCompletionDate,
  expectedHourlyWeekdayCompletionSlot,
  formatOperationalTimestamp,
  formatSourceBusinessDate,
} from "@/lib/data/source-health-evaluation";

const NOW = new Date("2026-08-19T16:00:00.000Z");

describe("source-health persisted-evidence classification", () => {
  it("requires a committed success instead of inferring health", () => {
    expect(evaluateScheduledSource({
      latestSuccessAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
    }, NOW)).toEqual({ status: "UNKNOWN", reason: "missing_success" });
  });

  it("marks a recent committed success healthy", () => {
    expect(evaluateScheduledSource({
      latestSuccessAt: "2026-08-19T15:00:00.000Z",
      lastAttemptAt: null,
      lastFailureAt: null,
    }, NOW)).toEqual({ status: "HEALTHY", reason: "recent_success" });
  });

  it("uses the 26-hour schedule-completion threshold independently of source dates", () => {
    expect(evaluateScheduledSource({
      latestSuccessAt: "2026-08-18T13:59:59.000Z",
      lastAttemptAt: null,
      lastFailureAt: null,
    }, NOW)).toEqual({ status: "ATTENTION", reason: "stale_success" });
  });

  it("lets a newer failure supersede an older success", () => {
    expect(evaluateScheduledSource({
      latestSuccessAt: "2026-08-19T12:00:00.000Z",
      lastAttemptAt: "2026-08-19T14:00:00.000Z",
      lastFailureAt: "2026-08-19T14:05:00.000Z",
    }, NOW)).toEqual({ status: "ATTENTION", reason: "newer_failure" });
  });

  it("allows one hour for an in-progress attempt before calling it stalled", () => {
    expect(evaluateScheduledSource({
      latestSuccessAt: "2026-08-19T12:00:00.000Z",
      lastAttemptAt: "2026-08-19T15:30:00.000Z",
      lastFailureAt: null,
    }, NOW)).toEqual({ status: "HEALTHY", reason: "recent_success" });
    expect(evaluateScheduledSource({
      latestSuccessAt: "2026-08-19T12:00:00.000Z",
      lastAttemptAt: "2026-08-19T14:30:00.000Z",
      lastFailureAt: null,
    }, NOW)).toEqual({ status: "ATTENTION", reason: "stalled_attempt" });
  });
});

describe("AUM weekday completion schedule", () => {
  const fridaySuccess = "2026-08-21T13:15:00.000Z"; // Friday 9:15 AM ET

  it("does not require an unscheduled weekend completion", () => {
    const saturday = new Date("2026-08-22T16:00:00.000Z");
    const sunday = new Date("2026-08-23T16:00:00.000Z");
    expect(expectedAumCompletionDate(saturday)).toBe("2026-08-21");
    expect(expectedAumCompletionDate(sunday)).toBe("2026-08-21");
    for (const now of [saturday, sunday]) {
      expect(evaluateAumCompletion({
        latestSuccessAt: fridaySuccess,
        lastAttemptAt: null,
        lastFailureAt: null,
      }, now)).toEqual({ status: "HEALTHY", reason: "recent_success" });
    }
  });

  it("keeps Friday current Monday before the 11:00 ET dashboard boundary", () => {
    const mondayBefore = new Date("2026-08-24T14:59:00.000Z");
    expect(expectedAumCompletionDate(mondayBefore)).toBe("2026-08-21");
    expect(evaluateAumCompletion({
      latestSuccessAt: fridaySuccess,
      lastAttemptAt: null,
      lastFailureAt: null,
    }, mondayBefore)).toEqual({ status: "HEALTHY", reason: "recent_success" });
  });

  it("requires Monday's completion after 11:00 ET", () => {
    const mondayAfter = new Date("2026-08-24T15:01:00.000Z");
    expect(expectedAumCompletionDate(mondayAfter)).toBe("2026-08-24");
    expect(evaluateAumCompletion({
      latestSuccessAt: fridaySuccess,
      lastAttemptAt: null,
      lastFailureAt: null,
    }, mondayAfter)).toEqual({ status: "ATTENTION", reason: "stale_success" });
  });
});

describe("CRM hourly weekday completion schedule", () => {
  const fridayFinalSuccess = "2026-08-22T03:05:00.000Z"; // Friday 23:05 ET

  it("suspends after Friday's final run through Monday's first-run grace", () => {
    for (const now of [
      new Date("2026-08-22T16:00:00.000Z"),
      new Date("2026-08-24T04:14:00.000Z"),
    ]) {
      expect(expectedHourlyWeekdayCompletionSlot(now, 15)).toBe("2026-08-21T23");
      expect(evaluateHourlyWeekdayCompletion({
        latestSuccessAt: fridayFinalSuccess,
        lastAttemptAt: null,
        lastFailureAt: null,
      }, now, 15)).toEqual({ status: "HEALTHY", reason: "recent_success" });
    }
  });

  it("requires Monday's midnight run after its 15-minute grace", () => {
    const mondayAfter = new Date("2026-08-24T04:16:00.000Z");
    expect(expectedHourlyWeekdayCompletionSlot(mondayAfter, 15)).toBe("2026-08-24T00");
    expect(evaluateHourlyWeekdayCompletion({
      latestSuccessAt: fridayFinalSuccess,
      lastAttemptAt: null,
      lastFailureAt: null,
    }, mondayAfter, 15)).toEqual({ status: "ATTENTION", reason: "stale_success" });
  });

  it("requires each weekday hourly run after its grace window", () => {
    const priorHourSuccess = "2026-08-19T15:05:00.000Z"; // 11:05 ET
    const beforeGrace = new Date("2026-08-19T16:14:00.000Z");
    const afterGrace = new Date("2026-08-19T16:16:00.000Z");
    expect(expectedHourlyWeekdayCompletionSlot(beforeGrace, 15)).toBe("2026-08-19T11");
    expect(evaluateHourlyWeekdayCompletion({
      latestSuccessAt: priorHourSuccess,
      lastAttemptAt: null,
      lastFailureAt: null,
    }, beforeGrace, 15)).toEqual({ status: "HEALTHY", reason: "recent_success" });
    expect(expectedHourlyWeekdayCompletionSlot(afterGrace, 15)).toBe("2026-08-19T12");
    expect(evaluateHourlyWeekdayCompletion({
      latestSuccessAt: priorHourSuccess,
      lastAttemptAt: null,
      lastFailureAt: null,
    }, afterGrace, 15)).toEqual({ status: "ATTENTION", reason: "stale_success" });
  });
});

describe("unverified recurring schedule", () => {
  it("does not infer health from a recent manual completion", () => {
    expect(evaluateUnverifiedSchedule({
      latestSuccessAt: "2026-08-19T15:00:00.000Z",
      lastAttemptAt: "2026-08-19T15:00:00.000Z",
      lastFailureAt: null,
    })).toEqual({ status: "UNKNOWN", reason: "schedule_unverified" });
  });

  it("still surfaces a newer recorded failure", () => {
    expect(evaluateUnverifiedSchedule({
      latestSuccessAt: "2026-08-19T14:00:00.000Z",
      lastAttemptAt: "2026-08-19T15:00:00.000Z",
      lastFailureAt: "2026-08-19T15:05:00.000Z",
    })).toEqual({ status: "ATTENTION", reason: "newer_failure" });
  });
});

describe("source-health date semantics", () => {
  it("renders date-only source values without timezone conversion", () => {
    expect(formatSourceBusinessDate("2026-08-14")).toBe("Aug 14, 2026");
  });

  it("renders operational instants in America/New_York", () => {
    const shown = formatOperationalTimestamp("2026-08-15T00:30:00.000Z");
    expect(shown).toContain("Aug 14, 2026");
    expect(shown).toContain("8:30 PM");
    expect(shown).toContain("EDT");
  });
});
