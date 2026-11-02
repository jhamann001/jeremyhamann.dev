import { describe, it, expect } from "vitest";
import {
  DEAL_STAGES,
  DEAL_SOURCES,
  STAGE_ORDER,
  STAGE_LABEL,
  stageLabel,
  sumDistinctClientAum,
  householdAumFromDeals,
  householdAumFromDealsByKey,
  clientPersonAum,
  pickHouseholdAum,
  maskCedarRidgeUserId,
  MASKED_CEDAR_RIDGE_ID,
  type ClientAumRow,
  type DealRow,
  type HouseholdClientAumRow,
} from "@/lib/data/deal-types";

// The deals contract module (TDD ticket ADR-8) is the shared vocabulary for
// the D2 screen, D3 form, and D4 import. These tests lock the pipeline order
// and guarantee label totality (a missing key would render undefined at
// runtime), exactly like the workflow status-tone tests.

describe("deal stage/source vocabulary", () => {
  it("has the five curated stages in pipeline order (ADR-3)", () => {
    expect([...DEAL_STAGES]).toEqual([
      "POTENTIAL",
      "COMMITTED",
      "FUNDING",
      "WON",
      "LOST",
    ]);
  });

  it("STAGE_ORDER is the pipeline order (KPI tiles / stage selects)", () => {
    expect([...STAGE_ORDER]).toEqual([...DEAL_STAGES]);
  });

  it("has exactly the two provenance sources (ADR-2)", () => {
    expect([...DEAL_SOURCES]).toEqual(["APP", "IMPORT"]);
  });
});

describe("stage labels are total", () => {
  it("labels every stage, with no stray keys", () => {
    for (const stage of DEAL_STAGES) {
      expect(STAGE_LABEL[stage]).toBeTruthy();
      expect(stageLabel(stage)).toBe(STAGE_LABEL[stage]);
    }
    expect(Object.keys(STAGE_LABEL).sort()).toEqual([...DEAL_STAGES].sort());
  });

  it("renders the TKT relabel display vocabulary (keys unchanged)", () => {
    expect(stageLabel("POTENTIAL")).toBe("Potential");
    expect(stageLabel("COMMITTED")).toBe("Potential-Committed");
    expect(stageLabel("FUNDING")).toBe("Potential-In Process");
    expect(stageLabel("WON")).toBe("Funded");
    expect(stageLabel("LOST")).toBe("Lost");
  });
});

// tkt-deals-client-link (AUM layer): person_aum is the client's TOTAL managed
// AUM, repeated on every one of that person's deal rows — so a household sum
// MUST dedupe by client_sf_id or a multi-deal client is counted N×. All ids
// invented (003 Contact ids). `row` builds the minimal ClientAumRow shape.
const row = (client_sf_id: string | null, person_aum: number | null): ClientAumRow => ({
  client_sf_id,
  person_aum,
});

describe("sumDistinctClientAum — one person_aum per distinct client", () => {
  it("dedupes a multi-deal client to a SINGLE contribution (the key rule)", () => {
    // Client A has 4 deals, all repeating person_aum 1,000,000 → counts ONCE.
    const deals = [
      row("003A", 1_000_000),
      row("003A", 1_000_000),
      row("003A", 1_000_000),
      row("003A", 1_000_000),
    ];
    expect(sumDistinctClientAum(deals)).toBe(1_000_000);
  });

  it("sums across DISTINCT clients (one person_aum each)", () => {
    const deals = [
      row("003A", 1_000_000),
      row("003A", 1_000_000), // A's repeat — ignored
      row("003B", 500_000),
      row("003C", 250_000),
      row("003C", 250_000), // C's repeat — ignored
    ];
    expect(sumDistinctClientAum(deals)).toBe(1_750_000);
  });

  it("skips rows with a null client_sf_id or a null person_aum", () => {
    const deals = [
      row(null, 999_999), // no client key → skipped
      row("003B", null), // no aum → skipped
      row("003C", 400_000),
    ];
    expect(sumDistinctClientAum(deals)).toBe(400_000);
  });

  it("returns null when NO row contributes (the mirror-fallback signal)", () => {
    expect(sumDistinctClientAum([])).toBeNull();
    expect(sumDistinctClientAum([row(null, 100), row("003B", null)])).toBeNull();
  });

  it("is ORDER-INDEPENDENT (same rows, two orders → same sum)", () => {
    const a = [row("003A", 1_000_000), row("003B", 500_000), row("003A", 1_000_000)];
    const b = [row("003B", 500_000), row("003A", 1_000_000), row("003A", 1_000_000)];
    expect(sumDistinctClientAum(a)).toBe(sumDistinctClientAum(b));
    expect(sumDistinctClientAum(a)).toBe(1_500_000);
  });

  it("takes the MAX per client when a client's rows disagree (deterministic)", () => {
    // A re-ingest touched only some of client A's rows → mixed person_aum. Max
    // is order-independent, so both page queries pick the same figure.
    const asc = [row("003A", 900_000), row("003A", 1_100_000), row("003B", 200_000)];
    const desc = [row("003A", 1_100_000), row("003A", 900_000), row("003B", 200_000)];
    expect(sumDistinctClientAum(asc)).toBe(1_300_000); // 1.1M (max) + 200K
    expect(sumDistinctClientAum(desc)).toBe(1_300_000);
  });
});

describe("householdAumFromDeals — completeness gate + mirror fallback", () => {
  it("returns the deals-derived total when EVERY deal is backfilled", () => {
    const deals = [row("003A", 1_000_000), row("003A", 1_000_000), row("003B", 500_000)];
    expect(householdAumFromDeals(deals)).toBe(1_500_000);
  });

  it("returns null when ANY deal is still un-backfilled (→ mirror fallback)", () => {
    // Client A linked, client B not yet: the bare sum would understate (A
    // alone); the gate returns null so the caller falls back to mirror aum.
    const deals = [
      row("003A", 1_000_000),
      row(null, null), // B's deal, not backfilled
    ];
    expect(householdAumFromDeals(deals)).toBeNull();
    // Guard: the ungated sum WOULD have returned the understated partial.
    expect(sumDistinctClientAum(deals)).toBe(1_000_000);
  });

  it("returns null for an empty deal set (no contributors → mirror fallback)", () => {
    expect(householdAumFromDeals([])).toBeNull();
  });
});

// tkt-households-aum-rollup: the households LIST page's bulk deals-fallback —
// one flat deal pull grouped by the 15-char household key, each group running
// through householdAumFromDeals (so the gate/dedupe semantics are IDENTICAL to
// the detail page's single-household path).
const hhRow = (
  household_sf_id: string | null,
  client_sf_id: string | null,
  person_aum: number | null,
): HouseholdClientAumRow => ({ household_sf_id, client_sf_id, person_aum });

describe("householdAumFromDealsByKey — bulk per-household deals fallback", () => {
  it("groups by household and dedupes MAX-per-client within each", () => {
    const out = householdAumFromDealsByKey([
      // HH1: client A twice (repeat → once), client B once.
      hhRow("001MF400718064Q", "003A", 1_000_000),
      hhRow("001MF400718064Q", "003A", 1_000_000),
      hhRow("001MF400718064Q", "003B", 500_000),
      // HH2: single client.
      hhRow("001YY035339533I", "003C", 250_000),
    ]);
    expect(out.get("001MF400718064Q")).toBe(1_500_000);
    expect(out.get("001YY035339533I")).toBe(250_000);
    expect(out.size).toBe(2);
  });

  it("applies the completeness gate PER household — one un-backfilled deal nulls ONLY its household", () => {
    const out = householdAumFromDealsByKey([
      hhRow("001MF400718064Q", "003A", 1_000_000),
      hhRow("001MF400718064Q", null, null), // A's second deal, not backfilled
      hhRow("001YY035339533I", "003C", 250_000), // B fully backfilled
    ]);
    expect(out.get("001MF400718064Q")).toBeNull(); // gate → next fallback
    expect(out.get("001YY035339533I")).toBe(250_000); // unaffected
  });

  it("takes MAX per client when a client's rows disagree (matches sumDistinctClientAum)", () => {
    const out = householdAumFromDealsByKey([
      hhRow("001MF400718064Q", "003A", 900_000),
      hhRow("001MF400718064Q", "003A", 1_100_000),
    ]);
    expect(out.get("001MF400718064Q")).toBe(1_100_000);
  });

  it("collapses 15- and 18-char household ids onto ONE 15-char key (householdDealKey)", () => {
    // The SAME household: a legacy 15-char import row + an 18-char feed row.
    const out = householdAumFromDealsByKey([
      hhRow("001MF400718064Q", "003A", 1_000_000), // 15-char
      hhRow("001MF400718064QAAA", "003B", 500_000), // 18-char, same 15 prefix
    ]);
    expect(out.size).toBe(1);
    expect(out.get("001MF400718064Q")).toBe(1_500_000);
  });

  it("drops rows with no household key; empty input → empty map", () => {
    const out = householdAumFromDealsByKey([hhRow(null, "003A", 1_000_000)]);
    expect(out.size).toBe(0);
    expect(householdAumFromDealsByKey([]).size).toBe(0);
  });
});

describe("clientPersonAum — the single figure for one client's deals", () => {
  it("returns the first non-null person_aum (all repeat the same value)", () => {
    expect(clientPersonAum([row("003A", 2_400_000), row("003A", 2_400_000)])).toBe(
      2_400_000,
    );
  });

  it("skips leading null person_aum rows", () => {
    expect(clientPersonAum([row("003A", null), row("003A", 750_000)])).toBe(750_000);
  });

  it("returns null when no deal carries a person_aum (empty or all null)", () => {
    expect(clientPersonAum([])).toBeNull();
    expect(clientPersonAum([row("003A", null)])).toBeNull();
  });
});

// tkt account-AUM feed: the headline-AUM fallback chain, Apex-first. These lock
// the precedence the household / portrait / reminders seams all rely on.
describe("pickHouseholdAum (tkt Apex-first fallback)", () => {
  it("prefers Apex when present, even when deals/mirror also have values", () => {
    expect(pickHouseholdAum(100, 200, 300)).toEqual({ aum: 100, source: "apex" });
  });
  it("falls back to deals when Apex is null", () => {
    expect(pickHouseholdAum(null, 200, 300)).toEqual({ aum: 200, source: "deals" });
  });
  it("falls back to mirror when Apex and deals are null", () => {
    expect(pickHouseholdAum(null, null, 300)).toEqual({ aum: 300, source: "mirror" });
  });
  it("returns null/mirror when every source is null (never fabricates 0)", () => {
    expect(pickHouseholdAum(null, null, null)).toEqual({ aum: null, source: "mirror" });
  });
  it("treats an explicit 0 as a real Apex value (not a fallback trigger)", () => {
    expect(pickHouseholdAum(0, 200, 300)).toEqual({ aum: 0, source: "apex" });
  });
});

// Deals cedar_ridge_user_id visibility mask — PURE projection reused by the seam,
// DealDetail, DealForm and the CSV export. Synthetic `user-<uuid>` id only (PII
// rule). Only cedar_ridge_user_id + cedar_ridge_user_id_masked matter, so the row
// factory carries a minimal-but-typed DealRow.
const CRW = "user-00000000-0000-0000-0000-000000000042";

const dealRow = (over: Partial<DealRow> = {}): DealRow => ({
  id: "deal-1",
  source: "APP",
  sf_deal_id: null,
  name: "Test Deal",
  client_first_name: "Test",
  client_last_name: "Client",
  household_name: null,
  household_sf_id: null,
  client_sf_id: null,
  amount: 1000,
  stage: "POTENTIAL",
  stage_raw: null,
  created_date: new Date("2026-01-01T00:00:00.000Z"),
  close_date: null,
  last_activity_date: null,
  owner_name: null,
  owner_sf_user_id: null,
  secondary_owner: null,
  person_aum: null,
  potential_aum: null,
  cedar_ridge_user_id: CRW,
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
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
  archived_at: null,
  archived_by: null,
  ...over,
});

describe("maskCedarRidgeUserId — role-gated projection", () => {
  it("MASKED_CEDAR_RIDGE_ID is a fixed 8-dot string (length never reveals the id)", () => {
    expect(MASKED_CEDAR_RIDGE_ID).toBe("••••••••");
    expect(MASKED_CEDAR_RIDGE_ID.length).toBe(8);
  });

  it.each(["ADMIN", "OPERATIONS"])(
    "keeps the real value + masked=false for %s",
    (role) => {
      const out = maskCedarRidgeUserId(dealRow(), role);
      expect(out.cedar_ridge_user_id).toBe(CRW);
      expect(out.cedar_ridge_user_id_masked).toBe(false);
    },
  );

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])(
    "nulls the value + masked=true for %s (a real id was present)",
    (role) => {
      const out = maskCedarRidgeUserId(dealRow(), role);
      expect(out.cedar_ridge_user_id).toBeNull();
      expect(out.cedar_ridge_user_id_masked).toBe(true);
      // The raw string must be absent from the projected row.
      expect(JSON.stringify(out)).not.toContain(CRW);
    },
  );

  it("null/unknown role fails closed (masked)", () => {
    expect(maskCedarRidgeUserId(dealRow(), null).cedar_ridge_user_id).toBeNull();
    expect(maskCedarRidgeUserId(dealRow(), undefined).cedar_ridge_user_id).toBeNull();
    expect(maskCedarRidgeUserId(dealRow(), "BOGUS").cedar_ridge_user_id_masked).toBe(true);
  });

  it("null DB value → masked=false for a non-authorized role (nothing to hide)", () => {
    const out = maskCedarRidgeUserId(dealRow({ cedar_ridge_user_id: null }), "ADVISOR");
    expect(out.cedar_ridge_user_id).toBeNull();
    expect(out.cedar_ridge_user_id_masked).toBe(false);
  });

  it("does not mutate the input row (returns a new object)", () => {
    const input = dealRow();
    const out = maskCedarRidgeUserId(input, "VIEWER");
    expect(input.cedar_ridge_user_id).toBe(CRW); // original untouched
    expect(out).not.toBe(input);
  });
});
