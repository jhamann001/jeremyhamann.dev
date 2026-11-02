import { describe, expect, it } from "vitest";
import { householdDealKey } from "../lib/data/deal-types";

// ticket: the 15↔18-char Salesforce-id join. `mirror.household.sf_id` is the
// 18-char id (15-char base + 3-char checksum); `app.deal.household_sf_id` is
// the 15-char base. `householdDealKey` normalizes the household id to the
// 15-char prefix that the seam binds into the deal query. A naive `=` join
// (18 vs 15) matches ZERO rows — these tests pin that the normalization makes
// the same record match, and a different record does NOT. All ids synthetic.

// The worked example from the WO: same record, two widths.
const HH_18 = "001K658408V83k7IAB"; // mirror.household.sf_id (18-char)
const DEAL_15 = "001K658408V83k7"; // app.deal.household_sf_id (15-char)

describe("householdDealKey", () => {
  it("normalizes an 18-char household sf_id to its 15-char prefix", () => {
    expect(householdDealKey(HH_18)).toBe(DEAL_15);
  });

  it("matches a deal whose household_sf_id is the 15-char form of the same record", () => {
    // This is the actual join predicate: deal.household_sf_id === key.
    expect(householdDealKey(HH_18)).toBe(DEAL_15);
    expect(DEAL_15 === householdDealKey(HH_18)).toBe(true);
  });

  it("does NOT match a deal for a DIFFERENT household id", () => {
    const otherDeal15 = "001Q452870GUJOM"; // a different 15-char id
    expect(householdDealKey(HH_18)).not.toBe(otherDeal15);
  });

  it("does not confuse two ids that share a prefix but differ within 15 chars", () => {
    const near18 = "001H652932Y19wVIAB"; // differs at char 15 of the base
    expect(householdDealKey(near18)).not.toBe(DEAL_15);
  });

  it("is a no-op (identity) on an already-15-char id", () => {
    expect(householdDealKey(DEAL_15)).toBe(DEAL_15);
  });

  it("returns shorter ids unchanged (slice is a no-op below 15 chars)", () => {
    expect(householdDealKey("SHORT")).toBe("SHORT");
  });

  it("fails closed on null/undefined (no key → no match)", () => {
    expect(householdDealKey(null)).toBeNull();
    expect(householdDealKey(undefined)).toBeNull();
  });
});

// tkt-deals-dedupe: after the CRM feed took over, surviving deals carry
// the 18-char `household_sf_id`, so the seams changed their predicate to
// `left(household_sf_id, 15) = householdDealKey(sf_id)` — BOTH sides clipped to
// the 15-char prefix. These pin the pure key relationship the SQL depends on:
// an 18-char deal id and an 18-char household id of the SAME record collapse to
// the same 15-char key, while legacy 15-char deals still match.
describe("household↔deal join width normalization (left(_,15) = key)", () => {
  const clip15 = (s: string) => s.slice(0, 15); // mirrors SQL `left(_, 15)`

  it("an 18-char deal household_sf_id matches an 18-char household via the key", () => {
    const householdSfId = HH_18; // mirror.household.sf_id (18-char)
    const deal18 = HH_18; // live-feed deal.household_sf_id (18-char, same record)
    expect(clip15(deal18)).toBe(householdDealKey(householdSfId));
  });

  it("a legacy 15-char deal household_sf_id still matches the same household", () => {
    const deal15 = DEAL_15; // legacy import width
    expect(clip15(deal15)).toBe(householdDealKey(HH_18));
  });

  it("a deal for a DIFFERENT household does not match after clipping", () => {
    const otherDeal18 = "001Q452870GUJOMIAB";
    expect(clip15(otherDeal18)).not.toBe(householdDealKey(HH_18));
  });
});
