import { describe, it, expect } from "vitest";
import { resolveTradeRequestStatus } from "@/lib/data/trade-request-status-catalog";

describe("resolveTradeRequestStatus", () => {
  it("maps every canonical RequestStatus to a label + tone", () => {
    expect(resolveTradeRequestStatus("Pending Review")).toEqual({
      label: "Pending Review",
      tone: "amber",
    });
    expect(resolveTradeRequestStatus("Needs Info")).toEqual({
      label: "Needs Info",
      tone: "red",
    });
    expect(resolveTradeRequestStatus("Pending Current Asset Liquidation")).toEqual({
      label: "Pending Liquidation",
      tone: "amber",
    });
    expect(resolveTradeRequestStatus("Approved")).toEqual({
      label: "Approved",
      tone: "green",
    });
    expect(resolveTradeRequestStatus("Rejected")).toEqual({
      label: "Rejected",
      tone: "red",
    });
    expect(resolveTradeRequestStatus("Completed")).toEqual({
      label: "Completed",
      tone: "blue",
    });
  });

  it("null / undefined / blank → 'Unknown status' (gray), never throws", () => {
    for (const v of [null, undefined, "", "   "]) {
      expect(resolveTradeRequestStatus(v)).toEqual({
        label: "Unknown status",
        tone: "gray",
      });
    }
  });

  it("an unmapped value → humanized label (gray), stays visible", () => {
    // A status the app might add later — humanized, not dropped or crashed.
    expect(resolveTradeRequestStatus("PartiallyExecuted")).toEqual({
      label: "Partially Executed",
      tone: "gray",
    });
    expect(resolveTradeRequestStatus("needs_reapproval")).toEqual({
      label: "Needs Reapproval",
      tone: "gray",
    });
  });

  it("trims surrounding whitespace before matching a known value", () => {
    expect(resolveTradeRequestStatus("  Approved  ")).toEqual({
      label: "Approved",
      tone: "green",
    });
  });
});
