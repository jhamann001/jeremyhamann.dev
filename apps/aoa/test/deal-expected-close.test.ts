import { afterEach, describe, expect, it, vi } from "vitest";
import { DEAL_STAGES } from "@/lib/data/deal-types";
import { expectedCloseDay, isExpectedCloseOverdue } from "@/lib/deals/expected-close";
import { toDateStr } from "@/lib/market-calendar";

const date = (day: string) => new Date(`${day}T00:00:00.000Z`);

afterEach(() => vi.useRealTimers());

describe("expected-close calendar rule", () => {
  it.each(DEAL_STAGES)("classifies yesterday/today/tomorrow/missing for %s", (stage) => {
    const today = "2026-09-21";
    const open = stage !== "WON" && stage !== "LOST";
    expect(isExpectedCloseOverdue(stage, date("2026-09-20"), today)).toBe(open);
    expect(isExpectedCloseOverdue(stage, date(today), today)).toBe(false);
    expect(isExpectedCloseOverdue(stage, date("2026-09-22"), today)).toBe(false);
    expect(isExpectedCloseOverdue(stage, null, today)).toBe(false);
  });

  it("preserves database calendar dates and treats an invalid date as unavailable", () => {
    const close = date("2026-09-21");
    expect(expectedCloseDay(close)).toBe("2026-09-21");
    expect(close.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(expectedCloseDay(null)).toBeNull();
    expect(expectedCloseDay(new Date("invalid"))).toBeNull();
    expect(isExpectedCloseOverdue("POTENTIAL", new Date("invalid"), "2026-09-21"))
      .toBe(false);
  });

  it.each([
    ["2026-09-21T00:30:00Z", "2026-09-20", "2026-09-20", false],
    ["2026-09-21T03:59:59Z", "2026-09-20", "2026-09-20", false],
    ["2026-09-21T04:00:00Z", "2026-09-21", "2026-09-20", true],
    ["2027-01-01T02:30:00Z", "2026-12-31", "2026-12-31", false],
    ["2027-01-01T05:00:00Z", "2027-01-01", "2026-12-31", true],
    // Spring forward: midnight and the skipped local hour are separate events.
    ["2026-03-08T04:59:59Z", "2026-03-07", "2026-03-07", false],
    ["2026-03-08T05:00:00Z", "2026-03-08", "2026-03-07", true],
    ["2026-03-08T06:59:59Z", "2026-03-08", "2026-03-08", false],
    ["2026-03-08T07:00:00Z", "2026-03-08", "2026-03-08", false],
    // Fall back: both occurrences of 01:00 still belong to November 1.
    ["2026-11-01T03:59:59Z", "2026-10-31", "2026-10-31", false],
    ["2026-11-01T04:00:00Z", "2026-11-01", "2026-10-31", true],
    ["2026-11-01T05:59:59Z", "2026-11-01", "2026-11-01", false],
    ["2026-11-01T06:00:00Z", "2026-11-01", "2026-11-01", false],
  ])("uses the Eastern calendar at %s", (now, today, close, overdue) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const snapshot = toDateStr(new Date());
    expect(snapshot).toBe(today);
    expect(isExpectedCloseOverdue("FUNDING", date(close), snapshot)).toBe(overdue);
  });

  it("does not read the clock after receiving the render snapshot", () => {
    vi.useFakeTimers();
    const close = date("2026-09-20");
    for (const now of ["2026-09-19T12:00:00Z", "2026-09-22T12:00:00Z"]) {
      vi.setSystemTime(new Date(now));
      expect(isExpectedCloseOverdue("COMMITTED", close, "2026-09-20")).toBe(false);
      expect(isExpectedCloseOverdue("COMMITTED", close, "2026-09-21")).toBe(true);
    }
  });
});
