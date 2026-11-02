import { describe, expect, it } from "vitest";
import {
  APP_CREATE_BASE,
  buildDealName,
  buildDealSuggestions,
  clientsForHousehold,
  findClientByFullName,
  resolvedFundingType,
  toDealInput,
  type DealFormValues,
} from "../components/deals/deal-form";
import {
  ARCHIVE_NOTE_MAX,
  archivedReasonText,
  archiveNoteError,
} from "../lib/data/deal-archive";
import { FUNDING_TYPES } from "../lib/data/deal-types";

// D8 mockup parity (WO ticket): the funding-type rules applied SERVER-SIDE
// through toDealInput — Other stores the typed text, Cash forces account
// #/firm null, and the 401(k)-Rollover companions are cleared for every other
// funding type. Plus the typeahead suggestion builders. All data invented.

const values = (over: Partial<DealFormValues> = {}): DealFormValues => ({
  client_first_name: "Jordan",
  client_last_name: "Sample",
  household_name: "Sample Household",
  household_sf_id: "HH-0001",
  amount: "250000",
  stage: "POTENTIAL",
  close_date: "",
  cedar_ridge_user_id: "",
  statements: true,
  account_type: "Roth IRA",
  funding_other: "",
  employer: "",
  rolling_into: "",
  account_last4: "1234",
  transferring_firm: "Fidelity",
  ...over,
});

const BASE = APP_CREATE_BASE("2026-07-02", "Riley Ops");

describe("funding type vocabulary", () => {
  it("is the mockup's DEAL_ACCT_TYPES, verbatim and in order", () => {
    expect(FUNDING_TYPES).toEqual([
      "Traditional IRA",
      "Roth IRA",
      "Inherited Traditional IRA",
      "Inherited Roth IRA",
      "Individual Brokerage",
      "JT TIC",
      "JT WROS",
      "Community Property",
      "SEP IRA",
      "401(k) Rollover",
      "Annuity",
      "Cash",
      "Trust",
      "Other",
    ]);
  });
});

describe("Other → stores the typed text", () => {
  it("stores the specify text when present", () => {
    const input = toDealInput(
      values({ account_type: "Other", funding_other: "529 plan" }),
      BASE,
    );
    expect(input.account_type).toBe("529 plan");
    expect(buildDealName(values({ account_type: "Other", funding_other: "529 plan" })))
      .toBe("Jordan Sample - Fidelity - 529 plan - 1234");
  });

  it("falls back to the literal 'Other' when nothing was typed (mockup rule)", () => {
    const input = toDealInput(values({ account_type: "Other" }), BASE);
    expect(input.account_type).toBe("Other");
  });

  it("resolvedFundingType maps blank select to null", () => {
    expect(resolvedFundingType(values({ account_type: "" }))).toBeNull();
  });

  // QC LOW-1 (PR #80): Other-text that case-insensitively names a reserved
  // option resolves to that option — with the option's rules applied.
  it("Other → 'cash' resolves to Cash AND gets Cash's nulling rules", () => {
    const v = values({
      account_type: "Other",
      funding_other: "  cash ",
      account_last4: "9999",
      transferring_firm: "Fidelity",
    });
    expect(resolvedFundingType(v)).toBe("Cash"); // canonical casing
    const input = toDealInput(v, BASE);
    expect(input.account_type).toBe("Cash");
    expect(input.account_last4).toBeNull();
    expect(input.transferring_firm).toBeNull();
    expect(input.name).toBe("Jordan Sample - Cash");
  });

  it("Other → '401(K) ROLLOVER' resolves canonically and keeps companions", () => {
    const v = values({
      account_type: "Other",
      funding_other: "401(K) ROLLOVER",
      employer: "Globex",
      rolling_into: "Roth IRA",
    });
    const input = toDealInput(v, BASE);
    expect(input.account_type).toBe("401(k) Rollover");
    expect(input.employer).toBe("Globex");
    expect(input.rolling_into).toBe("Roth IRA");
  });

  it("Other → 'traditional ira' canonicalizes to a RESERVED type and clears companions", () => {
    const input = toDealInput(
      values({
        account_type: "Other",
        funding_other: "traditional ira",
        employer: "Globex",
        rolling_into: "Roth IRA",
      }),
      BASE,
    );
    expect(input.account_type).toBe("Traditional IRA");
    expect(input.employer).toBeNull();
    expect(input.rolling_into).toBeNull();
  });

  it("non-reserved Other text still stores verbatim", () => {
    expect(
      resolvedFundingType(values({ account_type: "Other", funding_other: "529 plan" })),
    ).toBe("529 plan");
  });
});

describe("Cash → account #/firm forced null server-side", () => {
  it("nulls both even when the client smuggles values", () => {
    const input = toDealInput(
      values({ account_type: "Cash", account_last4: "9999", transferring_firm: "Fidelity" }),
      BASE,
    );
    expect(input.account_type).toBe("Cash");
    expect(input.account_last4).toBeNull();
    expect(input.transferring_firm).toBeNull();
    // The derived name reflects the cleared fields too.
    expect(input.name).toBe("Jordan Sample - Cash");
  });
});

describe("401(k) Rollover companions", () => {
  it("keeps employer + rolling_into for a rollover", () => {
    const input = toDealInput(
      values({
        account_type: "401(k) Rollover",
        employer: "  Globex  ",
        rolling_into: "Roth IRA",
      }),
      BASE,
    );
    expect(input.employer).toBe("Globex");
    expect(input.rolling_into).toBe("Roth IRA");
  });

  it("clears both for a RESERVED non-rollover funding type (tampered payload)", () => {
    const input = toDealInput(
      values({ account_type: "Trust", employer: "Globex", rolling_into: "Roth IRA" }),
      BASE,
    );
    expect(input.employer).toBeNull();
    expect(input.rolling_into).toBeNull();
  });

  // D8 follow-on ruling (keep employer on Other): the Other bucket keeps the
  // employer — real Other-typed plans carry one (profit-sharing, RSUs, 403b).
  it("keeps employer for Other-typed text; rolling_into stays rollover-only", () => {
    const input = toDealInput(
      values({
        account_type: "Other",
        funding_other: "Profit-sharing plan",
        employer: "Globex",
        rolling_into: "Roth IRA", // tampered — not a rollover
      }),
      BASE,
    );
    expect(input.account_type).toBe("Profit-sharing plan");
    expect(input.employer).toBe("Globex");
    expect(input.rolling_into).toBeNull();
  });

  it("keeps employer for the literal 'Other' fallback too", () => {
    const input = toDealInput(
      values({ account_type: "Other", funding_other: "", employer: "Globex" }),
      BASE,
    );
    expect(input.account_type).toBe("Other");
    expect(input.employer).toBe("Globex");
  });

  it("rejects a tampered rolling_into outside the two options", () => {
    const input = toDealInput(
      values({ account_type: "401(k) Rollover", rolling_into: "Bitcoin" }),
      BASE,
    );
    expect(input.rolling_into).toBeNull();
  });

  it("'— not specified' stays null", () => {
    const input = toDealInput(
      values({ account_type: "401(k) Rollover", rolling_into: "" }),
      BASE,
    );
    expect(input.rolling_into).toBeNull();
  });
});

describe("archivedReasonText", () => {
  it("appends the trimmed note after the reason", () => {
    expect(archivedReasonText("Duplicate", "  same as DEMO-3  ")).toBe(
      "Duplicate · same as DEMO-3",
    );
  });
  it("is just the reason without a note", () => {
    expect(archivedReasonText("Entered in error", "   ")).toBe("Entered in error");
  });
});

// QC LOW-2 (PR #80): the archive note is capped at ARCHIVE_NOTE_MAX server-
// side (the input's maxLength is UX only).
describe("archiveNoteError", () => {
  it("accepts notes up to the cap (trimmed length counts)", () => {
    expect(archiveNoteError("")).toBeNull();
    expect(archiveNoteError("x".repeat(ARCHIVE_NOTE_MAX))).toBeNull();
    expect(archiveNoteError(`  ${"x".repeat(ARCHIVE_NOTE_MAX)}  `)).toBeNull();
  });
  it("rejects notes over the cap with the shared message", () => {
    expect(archiveNoteError("x".repeat(ARCHIVE_NOTE_MAX + 1))).toBe(
      `Note must be ${ARCHIVE_NOTE_MAX} characters or fewer.`,
    );
  });
});

describe("typeahead suggestions", () => {
  const rows = [
    // Newest-first, the seam's order.
    { client_first_name: "Sam", client_last_name: "Stone", household_name: "Stone Family Trust", household_sf_id: "HH-1001" },
    { client_first_name: "Sam", client_last_name: "Stone", household_name: "Old Household", household_sf_id: "HH-OLD" },
    { client_first_name: "Ada", client_last_name: "Okafor", household_name: null, household_sf_id: null },
    { client_first_name: "Ada", client_last_name: "Okafor", household_name: "Okafor Household", household_sf_id: "HH-1003" },
    { client_first_name: "Neil", client_last_name: "Walker", household_name: "Walker Household", household_sf_id: "HH-2001" },
  ];
  const s = buildDealSuggestions(rows);

  it("dedupes clients by full name; first (newest) sighting wins the household", () => {
    const sam = findClientByFullName(s, "Sam Stone");
    expect(s.clients).toHaveLength(3);
    expect(sam?.household_name).toBe("Stone Family Trust");
  });

  it("backfills a household from a later row when the first sighting had none", () => {
    expect(findClientByFullName(s, "Ada Okafor")?.household_name).toBe(
      "Okafor Household",
    );
  });

  it("collects distinct household names, sorted", () => {
    expect(s.households).toEqual([
      "Okafor Household",
      "Old Household",
      "Stone Family Trust",
      "Walker Household",
    ]);
  });

  it("narrows clients to a household, degrading to all when nothing matches", () => {
    expect(clientsForHousehold(s, "Walker Household").map((c) => c.full)).toEqual(
      ["Neil Walker"],
    );
    expect(clientsForHousehold(s, "No Such Household")).toHaveLength(3);
    expect(clientsForHousehold(s, "")).toHaveLength(3);
  });

  it("findClientByFullName is exact-match only", () => {
    expect(findClientByFullName(s, "Sam")).toBeNull();
  });
});
