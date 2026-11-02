import { describe, expect, it } from "vitest";
import { summarizeHouseholdDeals } from "@/lib/data/deal-types";

describe("household deal summaries", () => {
  it("separates outstanding and funded amounts while excluding lost deals", () => {
    expect(summarizeHouseholdDeals([
      { stage: "POTENTIAL", amount: 1000 },
      { stage: "FUNDING", amount: 2500 },
      { stage: "WON", amount: 4000 },
      { stage: "LOST", amount: 9000 },
    ])).toEqual({
      openPipeline: 3500,
      count: 4,
      wonCount: 1,
      outstandingCount: 2,
      outstandingAmount: 3500,
      fundedCount: 1,
      fundedAmount: 4000,
    });
  });

  it("returns zero-valued summaries for an empty household", () => {
    expect(summarizeHouseholdDeals([])).toEqual({
      openPipeline: 0,
      count: 0,
      wonCount: 0,
      outstandingCount: 0,
      outstandingAmount: 0,
      fundedCount: 0,
      fundedAmount: 0,
    });
  });
});
