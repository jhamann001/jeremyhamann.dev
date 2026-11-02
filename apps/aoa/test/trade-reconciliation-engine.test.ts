import { describe, expect, it } from "vitest";
import {
  reconcileAccountAware,
  summarizeReconciliation,
  meridianMatchRate,
  formatMatchRate,
  type MeridianTradeSourceRow,
  type ApexTradeSourceRow,
} from "@/lib/operations/trade-reconciliation";

function apex(overrides: Partial<ApexTradeSourceRow> = {}): ApexTradeSourceRow {
  return {
    activityId: "activity-1",
    processDate: "2026-09-01",
    accountId: "account-one",
    assetType: "EQUITY",
    symbol: "VTI",
    side: "Buy",
    quantity: 10,
    netAmount: 1000,
    grossAmount: 1000,
    clientOrderId: "order-1",
    activityTimestamp: "2026-09-01T15:00:00",
    ...overrides,
  };
}

function alpha(overrides: Partial<MeridianTradeSourceRow> = {}): MeridianTradeSourceRow {
  return {
    rebalancerOrderId: "order-1",
    accountId: "account-one",
    assetType: "EQUITY",
    symbol: "VTI",
    side: "Buy",
    quantity: 10,
    notionalAmount: null,
    initiatedTimestamp: "2026-09-01T14:59:00",
    clientBasketId: "client-basket-1",
    apexBasketId: "apex-basket-1",
    ...overrides,
  };
}

describe("account-aware Trade Reconciliation", () => {
  it("uses Meridian as the starting population while retaining Apex-only exceptions", () => {
    const rows = reconcileAccountAware([
      apex(), apex({ activityId: "direct", clientOrderId: "direct", symbol: "SPY" }),
    ], [alpha()]);
    expect(summarizeReconciliation(rows)).toMatchObject({
      apexRecords: 2, meridianRecords: 1, matched: 1, unresolved: 1, rawMatchRate: 100,
    });
  });

  it("cannot report 100% when 423 Meridian orders are missing at Apex", () => {
    const missing = Array.from({ length: 423 }, (_, i) => alpha({ rebalancerOrderId: `missing-${i}`, symbol: "SPY" }));
    const summary = summarizeReconciliation(reconcileAccountAware([apex()], [alpha(), ...missing]));
    expect(summary).toMatchObject({ meridianRecords: 424, matched: 1, unresolved: 423 });
    expect(summary.rawMatchRate).toBeCloseTo(100 / 424);
    expect(formatMatchRate(summary.rawMatchRate, summary.meridianRecords)).toBe("0.24%");
  });

  it("never converts an explained quantity or dollar break into a raw match", () => {
    const rows = reconcileAccountAware([
      apex(), apex({ activityId: "fund", clientOrderId: "fund", assetType: "MUTUAL_FUND" }),
    ], [alpha({ quantity: 9 }), alpha({ rebalancerOrderId: "fund", assetType: "MUTUAL_FUND", notionalAmount: 900 })]);
    expect(rows.map((row) => row.result).sort()).toEqual(["DOLLAR_BREAK", "QUANTITY_BREAK"]);
    expect(summarizeReconciliation(rows.map((row) => ({ ...row, classification: "Other" as const, explanation: "Reviewed synthetic break" })))).toMatchObject({
      matched: 0, explained: 2, unresolved: 0, rawMatchRate: 0,
    });
  });

  it("does not round an incomplete high-volume run up to 100%", () => {
    expect(formatMatchRate(meridianMatchRate(20_000, 20_001), 20_001)).toBe("99.99%");
    expect(formatMatchRate(meridianMatchRate(20_001, 20_001), 20_001)).toBe("100.00%");
  });

  it("labels an empty starting population and inconsistent counts honestly", () => {
    expect(formatMatchRate(meridianMatchRate(0, 0), 0)).toBe("N/A");
    expect(formatMatchRate(meridianMatchRate(2, 1), 1)).toBe("Unavailable");
    expect(meridianMatchRate(-1, 1)).toBeNull();
    expect(meridianMatchRate(1, Number.NaN)).toBeNull();
  });
  it("does not drop Meridian orders with missing values from the denominator", () => {
    const rows = reconcileAccountAware([], [alpha({ quantity: null, notionalAmount: null })]);
    expect(summarizeReconciliation(rows)).toMatchObject({ meridianRecords: 1, rawMatchRate: 0, unresolved: 1 });
  });

  it("pairs an exact order ID in the same account and masks the account", () => {
    const rows = reconcileAccountAware([apex()], [alpha()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account: "••-one",
      matchMethod: "ORDER_ID",
      result: "MATCHED",
    });
    expect(JSON.stringify(rows)).not.toContain("account-one");
  });

  it("does not pair the same order ID across different accounts", () => {
    const rows = reconcileAccountAware([apex()], [alpha({ accountId: "account-two" })]);
    expect(rows.map((row) => row.result).sort()).toEqual(["APEX_ONLY", "MERIDIAN_ONLY"]);
  });

  it("uses account + symbol + side + value for fallback matching", () => {
    const rows = reconcileAccountAware(
      [apex({ clientOrderId: "apex-only-id" })],
      [alpha({ rebalancerOrderId: "alpha-only-id" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      matchMethod: "ACCOUNT_SYMBOL_SIDE_VALUE",
      result: "MATCHED",
    });
  });

  it("uses dollars for mutual-fund buys even when quantities differ", () => {
    const rows = reconcileAccountAware(
      [apex({ assetType: "MUTUAL_FUND", quantity: 81.347, netAmount: 10_000 })],
      [alpha({ assetType: "MUTUAL_FUND", quantity: 81.346, notionalAmount: 10_000 })],
    );
    expect(rows[0]).toMatchObject({ result: "MATCHED", apexNetAmount: 10_000, meridianNotionalAmount: 10_000 });
  });

  it("matches a mutual-fund buy when both sources provide dollars but no shares", () => {
    const rows = reconcileAccountAware(
      [apex({ assetType: "MUTUAL_FUND", quantity: null, netAmount: 1500 })],
      [alpha({ assetType: "MUTUAL_FUND", quantity: null, notionalAmount: 1500 })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "MATCHED",
      apexQuantity: null,
      meridianQuantity: null,
      apexNetAmount: 1500,
      meridianNotionalAmount: 1500,
    });
  });

  it("classifies an order-ID value mismatch using the applicable basis", () => {
    const quantity = reconcileAccountAware([apex()], [alpha({ quantity: 9 })]);
    const dollars = reconcileAccountAware(
      [apex({ assetType: "MUTUAL_FUND", netAmount: 10_000 })],
      [alpha({ assetType: "MUTUAL_FUND", notionalAmount: 9_800 })],
    );
    expect(quantity[0]?.result).toBe("QUANTITY_BREAK");
    expect(dollars[0]?.result).toBe("DOLLAR_BREAK");
  });

  it("produces the same deterministic rows regardless of source order", () => {
    const apexRows = [
      apex({ activityId: "b", clientOrderId: null }),
      apex({ activityId: "a", clientOrderId: null }),
    ];
    const alphaRows = [
      alpha({ rebalancerOrderId: "y" }),
      alpha({ rebalancerOrderId: "x" }),
    ];
    expect(reconcileAccountAware(apexRows, alphaRows)).toEqual(
      reconcileAccountAware([...apexRows].reverse(), [...alphaRows].reverse()),
    );
  });
});
