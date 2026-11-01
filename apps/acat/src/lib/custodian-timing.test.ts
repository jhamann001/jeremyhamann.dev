import { describe, expect, it } from "vitest";
import {
  getObservedCompletionDays,
  summarizeCustodianTimings,
  type CustodianTimingRecord,
} from "./custodian-timing";

function timingRecord(
  overrides: Partial<CustodianTimingRecord> = {}
): CustodianTimingRecord {
  return {
    custodianId: "cust-1",
    originalClientRequestDate: "2026-01-01",
    acatDate: "2026-01-02",
    apexCompletionDate: "2026-01-11",
    type: "Full",
    ...overrides,
  };
}

describe("getObservedCompletionDays", () => {
  it("uses the original client request date and counts ACATS business days", () => {
    // Jan 1, 2026 is an ACATS holiday; Jan 3-4 and Jan 10-11 are weekends.
    expect(getObservedCompletionDays(timingRecord())).toBe(6);
  });

  it("falls back to the ACAT reference date", () => {
    expect(
      getObservedCompletionDays(timingRecord({ originalClientRequestDate: null }))
    ).toBe(5);
  });

  it("rejects missing, invalid, and backwards completion dates", () => {
    expect(getObservedCompletionDays(timingRecord({ apexCompletionDate: null }))).toBeNull();
    expect(
      getObservedCompletionDays(timingRecord({ apexCompletionDate: "not-a-date" }))
    ).toBeNull();
    expect(
      getObservedCompletionDays(timingRecord({ apexCompletionDate: "2025-12-31" }))
    ).toBeNull();
  });
});

describe("summarizeCustodianTimings", () => {
  it("calculates a rounded observed average and sample size per custodian", () => {
    const result = summarizeCustodianTimings([
      timingRecord({ apexCompletionDate: "2026-01-11" }),
      timingRecord({ apexCompletionDate: "2026-01-16" }),
      timingRecord({ custodianId: "cust-2", apexCompletionDate: "2026-01-06" }),
    ]);

    expect(result.get("cust-1")).toEqual({
      observedAvgProcessingBusinessDays: 9,
      observedCompletedTransfers: 2,
    });
    expect(result.get("cust-2")).toEqual({
      observedAvgProcessingBusinessDays: 3,
      observedCompletedTransfers: 1,
    });
  });

  it("excludes residual credits and unusable records", () => {
    const result = summarizeCustodianTimings([
      timingRecord({ type: "Residual Credit" }),
      timingRecord({ custodianId: null }),
      timingRecord({ apexCompletionDate: null }),
    ]);

    expect(result.size).toBe(0);
  });
});
