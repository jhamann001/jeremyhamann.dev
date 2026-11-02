import { describe, expect, it } from "vitest";
import type { AcatStatusAsset } from "@/lib/data/acat-status";
import {
  assetMapSummary,
  assignedMapExpandable,
  assignedPositionsRollup,
  dealRowMode,
  hasAcatLink,
  isAcatLinked,
  tradeRequestRowVisible,
} from "@/components/transfers/funding-picture";

// Pure-logic tests for the Full Funding Picture rework (ticket Slice 5). The
// card is a server component (no DOM env here), so the branch logic lives in
// funding-picture.ts and is pinned here.

const asset = (over: Partial<AcatStatusAsset> = {}): AcatStatusAsset => ({
  symbol: null,
  description: null,
  cusip: null,
  expectedQty: null,
  actualQty: null,
  mapStatus: null,
  issue: null,
  amount: null,
  assetClass: null,
  ...over,
});

describe("isAcatLinked", () => {
  // Legacy leg (UUID only, record id null) — outcomes unchanged from the
  // 2-arg era: these rows must behave byte-identically.
  it("is true for either ACAT rail with a real, non-blank legacy UUID", () => {
    expect(isAcatLinked("ACAT_FULL", "a1b2c3d4-uuid", null)).toBe(true);
    expect(isAcatLinked("ACAT_PARTIAL", "a1b2c3d4-uuid", null)).toBe(true);
  });

  it("is false for a non-securities rail regardless of id", () => {
    expect(isAcatLinked("MANUAL", "a1b2c3d4-uuid", null)).toBe(false);
    expect(isAcatLinked("WIRE", "a1b2c3d4-uuid", null)).toBe(false);
    expect(isAcatLinked("CHECK", "a1b2c3d4-uuid", null)).toBe(false);
    expect(isAcatLinked("ACH", "a1b2c3d4-uuid", null)).toBe(false);
  });

  it("is false when funding type is not chosen yet", () => {
    expect(isAcatLinked(null, "a1b2c3d4-uuid", null)).toBe(false);
  });

  it("is false for either ACAT rail with no / blank ids — never keys the tracker on a placeholder", () => {
    expect(isAcatLinked("ACAT_FULL", null, null)).toBe(false);
    expect(isAcatLinked("ACAT_FULL", "", null)).toBe(false);
    expect(isAcatLinked("ACAT_FULL", "   ", null)).toBe(false);
    expect(isAcatLinked("ACAT_PARTIAL", null, null)).toBe(false);
    expect(isAcatLinked("ACAT_PARTIAL", "", null)).toBe(false);
    expect(isAcatLinked("ACAT_PARTIAL", "   ", null)).toBe(false);
  });

  // Record-id leg (primary — record-id linking; covers UUID-less "N/A" records).
  it("is true for either ACAT rail with a record id alone (UUID null)", () => {
    expect(isAcatLinked("ACAT_FULL", null, "rec-manual-hayes")).toBe(true);
    expect(isAcatLinked("ACAT_PARTIAL", null, "rec-manual-hayes")).toBe(true);
  });

  it("is false for a record id with a non-ACAT / unchosen rail", () => {
    expect(isAcatLinked("WIRE", null, "rec-manual-hayes")).toBe(false);
    expect(isAcatLinked(null, null, "rec-manual-hayes")).toBe(false);
  });

  it("is false for a blank record id + null uuid (belt-and-braces)", () => {
    expect(isAcatLinked("ACAT_FULL", null, "")).toBe(false);
    expect(isAcatLinked("ACAT_FULL", null, "   ")).toBe(false);
  });
});

describe("assetMapSummary", () => {
  it("returns zeroes for an empty asset map", () => {
    expect(assetMapSummary([])).toEqual({ total: 0, classified: 0, issues: 0 });
  });

  it("counts total, classified (assetClass present), and issues independently", () => {
    const assets = [
      asset({ assetClass: "EQUITY" }),
      asset({ assetClass: "FIXED_INCOME", issue: "unmapped_cusip" }),
      asset({ issue: "quantity_mismatch" }),
      asset({}),
    ];
    expect(assetMapSummary(assets)).toEqual({
      total: 4,
      classified: 2,
      issues: 2,
    });
  });

  it("treats masked/empty-ish fields on the redacted projection as unclassified", () => {
    expect(assetMapSummary([asset({ symbol: "****", assetClass: null })])).toEqual({
      total: 1,
      classified: 0,
      issues: 0,
    });
  });
});

describe("dealRowMode", () => {
  it("linked deal wins over any rollup", () => {
    expect(dealRowMode(true, 3)).toBe("linked");
    expect(dealRowMode(true, 0)).toBe("linked");
  });

  it("rollup only when count > 0", () => {
    expect(dealRowMode(false, 2)).toBe("rollup");
    expect(dealRowMode(false, 0)).toBe("none");
  });
});

describe("assignedMapExpandable", () => {
  it("is true when the flag is ON and folder + custodian are set (S5: number NOT required)", () => {
    expect(assignedMapExpandable(true, "f1", "Fidelity")).toBe(true);
  });

  it("is false when the flag is off", () => {
    expect(assignedMapExpandable(false, "f1", "Fidelity")).toBe(false);
  });

  it("is false when folder or custodian is null", () => {
    expect(assignedMapExpandable(true, null, "Fidelity")).toBe(false);
    expect(assignedMapExpandable(true, "f1", null)).toBe(false);
  });

  it("treats blank-string parts as unset (L1 — same gate as the page fetch)", () => {
    expect(assignedMapExpandable(true, "", "Fidelity")).toBe(false);
    expect(assignedMapExpandable(true, "f1", "  ")).toBe(false);
  });
});

describe("assignedPositionsRollup", () => {
  it("sums non-null market values and counts every row", () => {
    expect(
      assignedPositionsRollup([
        { marketValue: 100 },
        { marketValue: null },
        { marketValue: 250.5 },
      ]),
    ).toEqual({ count: 3, totalValue: 350.5 });
  });

  it("returns zeroes for an empty list (never NaN)", () => {
    expect(assignedPositionsRollup([])).toEqual({ count: 0, totalValue: 0 });
  });
});

describe("hasAcatLink (H1 — ids alone, ANY funding type)", () => {
  it("is true for a record-id-only link", () => {
    expect(hasAcatLink(null, "rec-manual-hayes")).toBe(true);
  });

  it("is true for a UUID-only link", () => {
    expect(hasAcatLink("a1b2c3d4-uuid", null)).toBe(true);
  });

  it("is true when both ids are present", () => {
    expect(hasAcatLink("a1b2c3d4-uuid", "rec-manual-hayes")).toBe(true);
  });

  it("is independent of funding type by construction (no rail argument)", () => {
    // The same id-linked transfer is "linked" for the status view whether its
    // rail is null, CHECK, WIRE, ACH, or ACAT — hasAcatLink never sees the
    // rail. Contrast isAcatLinked below.
    expect(hasAcatLink("a1b2c3d4-uuid", null)).toBe(true);
  });

  it("is false for null/blank ids (same trim posture as isAcatLinked)", () => {
    expect(hasAcatLink(null, null)).toBe(false);
    expect(hasAcatLink("", null)).toBe(false);
    expect(hasAcatLink(null, "")).toBe(false);
    expect(hasAcatLink("   ", "  ")).toBe(false);
  });

  it("diverges from isAcatLinked on purpose: isAcatLinked stays rail-dependent", () => {
    // Same ids — hasAcatLink true, isAcatLinked false without an ACAT rail.
    expect(hasAcatLink("a1b2c3d4-uuid", null)).toBe(true);
    expect(isAcatLinked(null, "a1b2c3d4-uuid", null)).toBe(false);
    expect(isAcatLinked("WIRE", "a1b2c3d4-uuid", null)).toBe(false);
    expect(isAcatLinked("CHECK", "a1b2c3d4-uuid", null)).toBe(false);
    expect(isAcatLinked("ACH", "a1b2c3d4-uuid", null)).toBe(false);
    expect(isAcatLinked("ACAT_FULL", "a1b2c3d4-uuid", null)).toBe(true);
  });
});

describe("tradeRequestRowVisible (S4 — hub Trade-requests row gate)", () => {
  it("true only for a non-blank cedar_ridge_user_id", () => {
    expect(tradeRequestRowVisible("user-ae66b3c8-d257-4a6a-a8fd-d1c3641db27b")).toBe(true);
  });
  it("false when the resolved id is null (no client / no id)", () => {
    expect(tradeRequestRowVisible(null)).toBe(false);
  });
  it("false for an empty or whitespace-only string (trim-aware, like hasAcatLink)", () => {
    expect(tradeRequestRowVisible("")).toBe(false);
    expect(tradeRequestRowVisible("   ")).toBe(false);
  });
});
