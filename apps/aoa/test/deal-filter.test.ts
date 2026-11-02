import { describe, expect, it } from "vitest";
import {
  filterDeals,
  matchesQuery,
  matchesStage,
  type FilterableDeal,
} from "@/components/deals/deal-filter";

// Pure filter logic behind the /deals table (WO ticket): stage chips +
// free-text search over client / household / deal name. Owner left the search
// targets in D6 (WO ticket) — owners are stored but hidden from all /deals
// UI, and search must not resurface them. All data invented (PII rule).

const deal = (over: Partial<FilterableDeal> = {}): FilterableDeal => ({
  name: "Jordan Sample - Fidelity - Roth IRA - 1234",
  client_first_name: "Jordan",
  client_last_name: "Sample",
  household_name: "Sample Household",
  stage: "POTENTIAL",
  account_type: "Roth IRA",
  account_last4: "1234",
  transferring_firm: "Fidelity",
  statements: true,
  ...over,
});

describe("matchesStage", () => {
  it("passes everything through on 'all'", () => {
    expect(matchesStage("POTENTIAL", "all")).toBe(true);
    expect(matchesStage("LOST", "all")).toBe(true);
  });

  it("matches only the selected stage otherwise", () => {
    expect(matchesStage("WON", "WON")).toBe(true);
    expect(matchesStage("POTENTIAL", "WON")).toBe(false);
  });
});

describe("matchesQuery", () => {
  it("passes everything on an empty or whitespace query", () => {
    expect(matchesQuery(deal(), "")).toBe(true);
    expect(matchesQuery(deal(), "   ")).toBe(true);
  });

  it("matches the client name, including across first/last", () => {
    expect(matchesQuery(deal(), "jordan")).toBe(true);
    expect(matchesQuery(deal(), "Sample")).toBe(true);
    expect(matchesQuery(deal(), "jordan sample")).toBe(true);
  });

  it("matches household and deal name", () => {
    expect(matchesQuery(deal(), "sample household")).toBe(true);
    expect(matchesQuery(deal(), "roth ira")).toBe(true); // deal name
  });

  it("does NOT match owner text (D6: owners hidden from all /deals UI)", () => {
    // "Avery Stone" is this deal's stored owner in the DB — the filterable
    // projection no longer carries it, so owner text must never match.
    expect(matchesQuery(deal(), "avery")).toBe(false);
    expect(matchesQuery(deal(), "Avery Stone")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchesQuery(deal(), "FIDELITY")).toBe(true);
    expect(matchesQuery(deal(), "sAmPlE hOuSeHoLd")).toBe(true);
  });

  it("never throws and never matches on null household", () => {
    const bare = deal({ household_name: null });
    expect(matchesQuery(bare, "household")).toBe(false);
    expect(matchesQuery(bare, "jordan")).toBe(true); // client still hits
  });

  it("rejects a query that hits nothing", () => {
    expect(matchesQuery(deal(), "zzz-no-such-deal")).toBe(false);
  });
});

describe("filterDeals", () => {
  const rows: FilterableDeal[] = [
    deal(),
    deal({
      client_first_name: "Kai",
      client_last_name: "Example",
      household_name: "Example Family",
      stage: "WON",
      name: "Kai Example - Schwab - Joint - 9876",
      account_type: "Joint",
      account_last4: "9876",
      transferring_firm: "Schwab",
    }),
    deal({
      client_first_name: "Devi",
      client_last_name: "Invented",
      household_name: null,
      stage: "LOST",
      name: "Devi Invented - Pershing - Roth IRA - 5555",
      account_last4: "5555",
      transferring_firm: "Pershing",
    }),
  ];

  it("combines stage and query", () => {
    expect(filterDeals(rows, "all", "")).toHaveLength(3);
    expect(filterDeals(rows, "WON", "")).toHaveLength(1);
    expect(filterDeals(rows, "all", "roth")).toHaveLength(2);
    expect(filterDeals(rows, "LOST", "roth")).toHaveLength(1);
    expect(filterDeals(rows, "WON", "roth")).toHaveLength(0);
  });

  it("no longer finds deals by owner (D6)", () => {
    // "Gwen Kuhlman" owns the Kai Example deal in the DB; searching the
    // pipeline for the owner must return nothing.
    expect(filterDeals(rows, "all", "blake")).toHaveLength(0);
  });

  it("returns an empty array (not a throw) when nothing matches", () => {
    expect(filterDeals(rows, "FUNDING", "")).toEqual([]);
  });
});

describe("filterDeals — no_statements", () => {
  // Mixed stages, some with statements unchecked (statements: false).
  const rows: FilterableDeal[] = [
    deal({ stage: "POTENTIAL", statements: true }),
    deal({
      client_first_name: "Kai",
      client_last_name: "Example",
      stage: "WON",
      name: "Kai Example - Schwab - Joint - 9876",
      account_type: "Joint",
      transferring_firm: "Schwab",
      statements: false,
    }),
    deal({
      client_first_name: "Devi",
      client_last_name: "Invented",
      stage: "LOST",
      name: "Devi Invented - Pershing - Roth IRA - 5555",
      transferring_firm: "Pershing",
      statements: false,
    }),
  ];

  it("returns exactly the statements === false rows, across all stages", () => {
    const out = filterDeals(rows, "no_statements", "");
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.statements === false)).toBe(true);
  });

  it("still narrows by the free-text query within the unchecked rows", () => {
    expect(filterDeals(rows, "no_statements", "kai")).toHaveLength(1);
    expect(filterDeals(rows, "no_statements", "roth")).toHaveLength(1); // Devi's deal name
    expect(filterDeals(rows, "no_statements", "jordan")).toHaveLength(0); // Jordan has statements
  });

  it("leaves 'all' and specific-stage filters unaffected by the new field", () => {
    expect(filterDeals(rows, "all", "")).toHaveLength(3);
    expect(filterDeals(rows, "WON", "")).toHaveLength(1);
    expect(filterDeals(rows, "POTENTIAL", "")).toHaveLength(1);
  });
});
