import { describe, expect, it } from "vitest";
import { feeRequestWaiverDates } from "@/lib/operations/fee-request-dates";

const dates = (waiverStart: string | null, waiverDurationMonths: number | null, indefiniteDuration = false) =>
  feeRequestWaiverDates({ waiverStart, waiverDurationMonths, indefiniteDuration });

describe("waiver and billing restart month display", () => {
  it.each([
    ["2026-01", 6, "January 2026", "July 2026"],
    ["2026-09", 3, "September 2026", "December 2026"],
    ["2026-12", 1, "December 2026", "January 2027"],
    ["2024-02", 1, "February 2024", "March 2024"],
    ["2026-11", 14, "November 2026", "January 2028"],
    ["2026-01", 120, "January 2026", "January 2036"],
  ])("restarts after the full waiver beginning %s for %i months", (start, duration, waiverStart, billingRestart) => {
    expect(dates(start, duration)).toEqual({ waiverStart, billingRestart });
  });

  it("shows no scheduled restart for an indefinite waiver, even with a stale duration", () => {
    expect(dates("2026-09", null, true)).toEqual({ waiverStart: "September 2026", billingRestart: "No scheduled restart" });
    expect(dates("2026-09", 6, true).billingRestart).toBe("No scheduled restart");
  });

  it.each([null, "", "2026-00", "2026-13", "2026-9", "2026-09-01", "not-a-month", "0000-01"])(
    "does not invent dates for invalid or missing start %s", (start) => {
      expect(dates(start, 3)).toEqual({ waiverStart: "Unavailable", billingRestart: "Unavailable" });
    },
  );

  it.each([null, 0, -1, 1.5, 121, NaN, Infinity])("preserves a valid start but rejects invalid duration %s", (duration) => {
    expect(dates("2026-09", duration)).toEqual({ waiverStart: "September 2026", billingRestart: "Unavailable" });
  });

  it("does not display an unsupported overflow year", () => {
    expect(dates("9999-12", 1)).toEqual({ waiverStart: "December 9999", billingRestart: "Unavailable" });
  });
});
