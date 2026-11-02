import { describe, it, expect } from "vitest";
import { reportDateEt } from "@/lib/twr/report-date";

// The cover's "Report Date" must be the firm-timezone (America/New_York)
// calendar date. Cloud Run clocks are UTC, so the raw ISO date rolls to
// tomorrow every evening ET — the exact live bug: a report pulled at ~8:46pm
// ET on 2026-07-09 (= 00:46Z on 07-10) printed "2026-07-10".

describe("reportDateEt", () => {
  it("maps a late-evening-ET UTC instant back to the ET calendar date (EDT)", () => {
    // 2026-07-10T00:46Z == 2026-07-09 20:46 EDT — the reported live bug.
    expect(reportDateEt(new Date("2026-07-10T00:46:00Z"))).toBe("2026-07-09");
  });

  it("handles EST (winter) offsets too", () => {
    // 2026-01-10T02:30Z == 2026-01-09 21:30 EST.
    expect(reportDateEt(new Date("2026-01-10T02:30:00Z"))).toBe("2026-01-09");
  });

  it("leaves a midday instant on the same date", () => {
    // 2026-07-09T16:00Z == 2026-07-09 12:00 EDT.
    expect(reportDateEt(new Date("2026-07-09T16:00:00Z"))).toBe("2026-07-09");
  });
});
