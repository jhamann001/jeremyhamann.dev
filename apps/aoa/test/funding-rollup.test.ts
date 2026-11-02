import { describe, expect, it } from "vitest";
import { dealRollup } from "../components/transfers/funding-rollup";
import type { DealRow, DealStage } from "../lib/data/deal-types";

// The funding picture's REAL deals fold (T4, TDD ADR-9). "Top stage" is
// pinned by blueprint §0.5: largest summed amount, ties broken by pipeline
// order (STAGE_ORDER). All fixture rows invented.

let n = 0;
function deal(stage: DealStage, amount: number): DealRow {
  n += 1;
  return {
    id: `t-${n}`,
    source: "IMPORT",
    sf_deal_id: `TEST-${n}`,
    name: `Test Deal ${n}`,
    client_first_name: "Test",
    client_last_name: "Client",
    household_name: "Test Household",
    household_sf_id: "HH-TEST",
    client_sf_id: null,
    amount,
    stage,
    stage_raw: null,
    created_date: new Date("2026-01-01"),
    close_date: null,
    last_activity_date: null,
    owner_name: null,
    owner_sf_user_id: null,
    secondary_owner: null,
    person_aum: null,
    potential_aum: null,
    cedar_ridge_user_id: null,
    cedar_ridge_user_id_masked: false,
    statements: true,
    asset_mapped: false,
    plaid_linked: false,
    account_last4: null,
    account_type: null,
    transferring_firm: null,
    employer: null,
    rolling_into: null,
    lost_from: null,
    archived_reason: null,
    stage_history: [],
    created_by: null,
    updated_by: null,
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    archived_at: null,
    archived_by: null,
  };
}

describe("dealRollup", () => {
  it("returns zero-count / zero-total / null topStage on empty", () => {
    expect(dealRollup([])).toEqual({ count: 0, total: 0, topStage: null });
  });

  it("counts rows and sums amounts", () => {
    const rows = [deal("POTENTIAL", 85000), deal("WON", 180000), deal("WON", 64000)];
    const r = dealRollup(rows);
    expect(r.count).toBe(3);
    expect(r.total).toBe(329000);
  });

  it("picks the stage with the largest summed amount as topStage", () => {
    const rows = [
      deal("POTENTIAL", 85000),
      deal("POTENTIAL", 42000), // POTENTIAL Σ 127,000
      deal("COMMITTED", 560000), // COMMITTED Σ 560,000 ← top
      deal("WON", 180000),
    ];
    expect(dealRollup(rows).topStage).toBe("COMMITTED");
  });

  it("is order-independent", () => {
    const rows = [deal("WON", 100), deal("COMMITTED", 300), deal("LOST", 200)];
    const reversed = [...rows].reverse();
    expect(dealRollup(rows)).toEqual(dealRollup(reversed));
  });

  it("breaks amount ties by pipeline order (STAGE_ORDER)", () => {
    const rows = [deal("WON", 50000), deal("POTENTIAL", 50000)];
    expect(dealRollup(rows).topStage).toBe("POTENTIAL");
  });

  it("guards the Decimal seam: string-shaped amounts still sum numerically", () => {
    // The seam Number()-coerces, but the fold re-guards (render never sees NaN
    // concatenation if a raw row ever slips through).
    const row = { ...deal("FUNDING", 0), amount: "275000" as unknown as number };
    const r = dealRollup([row, deal("FUNDING", 25000)]);
    expect(r.total).toBe(300000);
    expect(r.topStage).toBe("FUNDING");
  });
});
