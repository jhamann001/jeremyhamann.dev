import { describe, expect, it } from "vitest";
import {
  APP_CREATE_BASE,
  buildDealName,
  dealToFormValues,
  diffDealInput,
  EDITABLE_FIELDS,
  isoDay,
  toDealInput,
  updatedDealName,
  type DealFormValues,
} from "../components/deals/deal-form";
import { validateDealInput } from "../lib/data/deal-validate";
import type { DealRow } from "../lib/data/deal-types";

// Invented data only (PII rule). Exercises the pure D3 form logic: derived
// deal name, form→DealInput coercion (incl. the frozen-validator handshake),
// edit seeding, the audit diff map, and the stored-name preservation rule.
// D6 (WO ticket): owner_name / secondary_owner left DealFormValues — they
// are server-owned via DealInputBase (create: signed-in user; update:
// preserved), so the client can never set or null them.

const values = (over: Partial<DealFormValues> = {}): DealFormValues => ({
  client_first_name: "Jordan",
  client_last_name: "Sample",
  household_name: "Sample Household",
  household_sf_id: "001XX0000EXAMPLE",
  amount: "250000",
  stage: "COMMITTED",
  close_date: "2026-08-15",
  cedar_ridge_user_id: "EU-9001",
  statements: true,
  account_type: "Roth IRA",
  funding_other: "",
  employer: "",
  rolling_into: "",
  account_last4: "1234",
  transferring_firm: "Fidelity",
  ...over,
});

const BASE = APP_CREATE_BASE("2026-07-01", "Avery Stone");

describe("buildDealName", () => {
  it("derives the full parseable convention when every segment is present", () => {
    expect(buildDealName(values())).toBe("Jordan Sample - Fidelity - Roth IRA - 1234");
  });

  it("skips absent segments (partial account info)", () => {
    expect(
      buildDealName(values({ transferring_firm: "", account_last4: "  " })),
    ).toBe("Jordan Sample - Roth IRA");
  });

  it("falls back to the bare client name with no account segments", () => {
    expect(
      buildDealName(
        values({ transferring_firm: "", account_type: "", account_last4: "" }),
      ),
    ).toBe("Jordan Sample");
  });
});

describe("toDealInput", () => {
  it("produces an input the frozen validator accepts", () => {
    const input = toDealInput(values(), BASE);
    expect(validateDealInput(input).ok).toBe(true);
    expect(input.source).toBe("APP");
    expect(input.sf_deal_id).toBeNull();
    expect(input.stage_raw).toBeNull();
    expect(input.created_date).toBe("2026-07-01");
    expect(input.amount).toBe(250000);
  });

  it("maps blank optionals to null and trims strings", () => {
    const input = toDealInput(
      values({ household_name: "  ", close_date: "" }),
      BASE,
    );
    expect(input.household_name).toBeNull();
    expect(input.close_date).toBeNull();
  });

  it("owners come from the server base, never the client (D6 silent default)", () => {
    // Create base: owner_name = the signed-in user's name; secondary null.
    const input = toDealInput(values(), BASE);
    expect(input.owner_name).toBe("Avery Stone");
    expect(input.secondary_owner).toBeNull();
    // A session without a display name creates an unassigned deal (still valid).
    const anonymous = toDealInput(values(), APP_CREATE_BASE("2026-07-01", null));
    expect(anonymous.owner_name).toBeNull();
    expect(validateDealInput(anonymous).ok).toBe(true);
  });

  it("blank amount becomes NaN so the validator rejects it (not silently 0)", () => {
    const input = toDealInput(values({ amount: "   " }), BASE);
    expect(Number.isNaN(input.amount)).toBe(true);
    const result = validateDealInput(input);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === "amount")).toBe(true);
  });

  it("non-numeric amount fails validation with the amount field key", () => {
    const result = validateDealInput(toDealInput(values({ amount: "lots" }), BASE));
    expect(result.errors.map((e) => e.field)).toContain("amount");
  });

  it("carries the base through unchanged (server-owned fields never form-set)", () => {
    const importBase = {
      source: "IMPORT" as const,
      sf_deal_id: "DEMO-0001",
      created_date: "2026-05-18",
      stage_raw: "Open",
      last_activity_date: "2026-06-01",
      owner_name: "Gwen Kuhlman", // update path: preserved from the row
      secondary_owner: "Casey Field",
      person_aum: 900000,
      potential_aum: 150000,
    };
    const input = toDealInput(values(), importBase);
    expect(input.sf_deal_id).toBe("DEMO-0001");
    expect(input.stage_raw).toBe("Open");
    expect(input.person_aum).toBe(900000);
    expect(input.owner_name).toBe("Gwen Kuhlman"); // edit can't touch owners
    expect(input.secondary_owner).toBe("Casey Field");
    expect(validateDealInput(input).ok).toBe(true); // IMPORT keeps its upsert key
  });
});

const row = (over: Partial<DealRow> = {}): DealRow => ({
  id: "deal_1",
  source: "APP",
  sf_deal_id: null,
  name: "Jordan Sample - Fidelity - Roth IRA - 1234",
  client_first_name: "Jordan",
  client_last_name: "Sample",
  household_name: "Sample Household",
  household_sf_id: null,
  client_sf_id: null,
  amount: 250000,
  stage: "COMMITTED",
  stage_raw: null,
  created_date: new Date("2026-07-01T00:00:00.000Z"),
  close_date: new Date("2026-08-15T00:00:00.000Z"),
  last_activity_date: null,
  owner_name: "Avery Stone",
  owner_sf_user_id: null,
  secondary_owner: null,
  person_aum: null,
  potential_aum: null,
  cedar_ridge_user_id: "EU-9001",
  cedar_ridge_user_id_masked: false,
  statements: true,
  asset_mapped: false,
  plaid_linked: false,
  account_last4: "1234",
  account_type: "Roth IRA",
  transferring_firm: "Fidelity",
  employer: null,
  rolling_into: null,
  lost_from: null,
  archived_reason: null,
  stage_history: [],
  created_by: "ops@example.com",
  updated_by: "ops@example.com",
  created_at: new Date("2026-07-01T12:00:00.000Z"),
  updated_at: new Date("2026-07-01T12:00:00.000Z"),
  archived_at: null, // D7 (WO ticket): fixtures are active deals
  archived_by: null,
  ...over,
});

describe("dealToFormValues / isoDay", () => {
  it("round-trips a row into form values (UTC dates, nulls → empty strings)", () => {
    const v = dealToFormValues(row({ household_sf_id: null }));
    expect(v.close_date).toBe("2026-08-15"); // UTC slice — no day shift
    expect(v.household_sf_id).toBe("");
    expect(v.amount).toBe("250000");
    expect(v.statements).toBe(true);
    // D6: owners are not form values at all — the seed never leaks them.
    expect("owner_name" in v).toBe(false);
    expect("secondary_owner" in v).toBe(false);
  });

  it("isoDay handles null", () => {
    expect(isoDay(null)).toBe("");
  });
});

describe("diffDealInput", () => {
  const before = toDealInput(values(), BASE);

  it("returns an empty map for an unchanged submit (no-op edit → no audit noise)", () => {
    expect(diffDealInput(before, toDealInput(values(), BASE))).toEqual({});
  });

  it("surfaces a stage change with from/to (the deal.stage_change payload)", () => {
    const after = toDealInput(values({ stage: "FUNDING" }), BASE);
    expect(diffDealInput(before, after).stage).toEqual({
      from: "COMMITTED",
      to: "FUNDING",
    });
  });

  it("tracks null↔value transitions (household cleared)", () => {
    const after = toDealInput(values({ household_name: "" }), BASE);
    expect(diffDealInput(before, after).household_name).toEqual({
      from: "Sample Household",
      to: null,
    });
  });

  it("never diffs owners (D6: server-carried, not editable)", () => {
    // Even if the DealInput owner values differ, EDITABLE_FIELDS excludes
    // them — deal.update audit details stay owner-free by construction.
    const after = { ...toDealInput(values(), BASE), owner_name: "Gwen Kuhlman" };
    expect(diffDealInput(before, after)).toEqual({});
  });

  it("tracks amount and statements changes", () => {
    const after = toDealInput(values({ amount: "300000", statements: false }), BASE);
    const changes = diffDealInput(before, after);
    expect(changes.amount).toEqual({ from: 250000, to: 300000 });
    expect(changes.statements).toEqual({ from: true, to: false });
  });
});

describe("updatedDealName", () => {
  const before = toDealInput(values(), BASE);

  it("preserves the stored name when no name-driving field changed", () => {
    const after = toDealInput(values({ stage: "WON", amount: "300000" }), BASE);
    expect(updatedDealName("Custom Stored Name", before, after)).toBe(
      "Custom Stored Name",
    );
  });

  it("re-derives the name when a driving field changed", () => {
    const after = toDealInput(values({ transferring_firm: "Schwab" }), BASE);
    expect(updatedDealName("Custom Stored Name", before, after)).toBe(
      "Jordan Sample - Schwab - Roth IRA - 1234",
    );
  });
});

describe("asset_mapped is NOT form-editable (S1 write-isolation)", () => {
  it("EDITABLE_FIELDS omits asset_mapped — a form save can't touch it", () => {
    expect(EDITABLE_FIELDS as readonly string[]).not.toContain("asset_mapped");
  });

  it("toDealInput output has no asset_mapped key — the form never sends it into updateDeal", () => {
    const input = toDealInput(values(), BASE) as Record<string, unknown>;
    expect(input).not.toHaveProperty("asset_mapped");
  });
});
