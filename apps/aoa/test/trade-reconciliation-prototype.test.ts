import { describe, expect, it } from "vitest";
import {
  PROTOTYPE_ROWS,
  comparisonBasisFor,
  comparisonValuesFor,
  summarizeReconciliation,
} from "@/lib/mock/trade-reconciliation";

describe("Trade Reconciliation prototype fixture", () => {
  it("contains each review state needed for development acceptance", () => {
    expect(PROTOTYPE_ROWS.some((row) => row.result === "MATCHED")).toBe(true);
    expect(PROTOTYPE_ROWS.some((row) => row.result === "QUANTITY_BREAK")).toBe(true);
    expect(PROTOTYPE_ROWS.some((row) => row.result === "DOLLAR_BREAK")).toBe(true);
    expect(PROTOTYPE_ROWS.some((row) => row.result === "APEX_ONLY" && !row.explanation)).toBe(true);
    expect(PROTOTYPE_ROWS.some((row) => row.result !== "MATCHED" && row.explanation)).toBe(true);
  });

  it("keeps explained exceptions separate from raw matches", () => {
    expect(summarizeReconciliation(PROTOTYPE_ROWS)).toEqual({
      apexRecords: 7,
      meridianRecords: 5,
      matched: 3,
      explained: 1,
      unresolved: 3,
      rawMatchRate: 60,
    });
  });

  it("uses dollars only for mutual-fund buys, matching the Fee Store source queries", () => {
    expect(comparisonBasisFor({ assetType: "MUTUAL_FUND", side: "Buy" })).toBe("DOLLARS");
    expect(comparisonBasisFor({ assetType: "MUTUAL_FUND", side: "Sell" })).toBe("SHARES");
    expect(comparisonBasisFor({ assetType: "ETF", side: "Buy" })).toBe("SHARES");
  });

  it("compares Apex net amount with Meridian notional for mutual-fund buys", () => {
    const matched = PROTOTYPE_ROWS.find((row) => row.id === "sample-mutual-fund-dollar-fallback");
    const broken = PROTOTYPE_ROWS.find((row) => row.id === "sample-dollar-break");
    expect(matched && comparisonValuesFor(matched)).toEqual({
      apex: 10_000,
      meridian: 10_000,
      difference: 0,
    });
    expect(broken && comparisonValuesFor(broken)).toEqual({
      apex: 10_000,
      meridian: 9_800,
      difference: 200,
    });
  });

  it("keeps quantity, dollar, identifiers, and timestamps available for every source row", () => {
    const matched = PROTOTYPE_ROWS.find((row) => row.id === "sample-mutual-fund-order-id-match");
    expect(matched).toMatchObject({
      matchMethod: "ORDER_ID",
      apexQuantity: 52.481,
      meridianQuantity: 52.481,
      apexNetAmount: 5_500,
      apexGrossAmount: 5_500,
      meridianNotionalAmount: 5_500,
      apexActivityId: "ACT-410845",
      meridianBasketId: "BASKET-77834",
    });
  });

  it("uses masked synthetic account references", () => {
    expect(PROTOTYPE_ROWS.every((row) => /^••\d{4}$/.test(row.account))).toBe(true);
  });
});
