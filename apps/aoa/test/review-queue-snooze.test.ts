import { describe, expect, it } from "vitest";
import { snoozeUntilForBusinessDate } from "@/lib/data/review-queue-snooze";

describe("review queue New York business-date snooze", () => {
  it("wakes at New York midnight after the selected summer or winter date", () => {
    expect(snoozeUntilForBusinessDate("2026-08-17")?.toISOString())
      .toBe("2026-08-18T04:00:00.000Z");
    expect(snoozeUntilForBusinessDate("2026-12-17")?.toISOString())
      .toBe("2026-12-18T05:00:00.000Z");
  });

  it("uses the correct DST offset on each side of the spring transition", () => {
    expect(snoozeUntilForBusinessDate("2026-03-07")?.toISOString())
      .toBe("2026-03-08T05:00:00.000Z");
    expect(snoozeUntilForBusinessDate("2026-03-08")?.toISOString())
      .toBe("2026-03-09T04:00:00.000Z");
  });

  it("rejects malformed and impossible calendar dates", () => {
    expect(snoozeUntilForBusinessDate("2026-02-30")).toBeNull();
    expect(snoozeUntilForBusinessDate("08/17/2026")).toBeNull();
  });
});
