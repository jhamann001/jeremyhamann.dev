import { describe, it, expect } from "vitest";
import type { DealInput } from "@/lib/data/deal-types";
import { validateDealInput } from "@/lib/data/deal-validate";

// validateDealInput is the ONE write contract shared by the D3 form and the D4
// import (TDD ticket ADR-8) — the import can never smuggle in a row the form
// would reject. All fixture data is INVENTED (PII rule).

/** A fully valid APP-entered deal (the D3 form shape: sf_deal_id null). */
function validAppDeal(): DealInput {
  return {
    source: "APP",
    sf_deal_id: null,
    name: "Jordan Sample - Fidelity - Roth IRA - 1234",
    client_first_name: "Jordan",
    client_last_name: "Sample",
    household_name: "Sample Household",
    household_sf_id: "001AA0000TESTID",
    amount: 125000,
    stage: "POTENTIAL",
    created_date: "2026-07-01",
    close_date: "2026-09-30",
    owner_name: "Avery Stone",
    owner_sf_user_id: "ADV-AVERY",
    cedar_ridge_user_id: "EU-9001",
    statements: true,
    plaid_linked: false,
    account_last4: "1234",
    account_type: "Roth IRA",
    transferring_firm: "Fidelity",
  };
}

/** A fully valid IMPORT deal (carries its Salesforce deal id — ADR-2). */
function validImportDeal(): DealInput {
  return {
    ...validAppDeal(),
    source: "IMPORT",
    sf_deal_id: "DEMO-9001",
    stage_raw: "Open",
    person_aum: 850000,
    potential_aum: 200000,
  };
}

function errorFields(input: DealInput): string[] {
  return validateDealInput(input).errors.map((e) => e.field);
}

describe("validateDealInput — valid rows", () => {
  it("accepts a valid APP deal (null sf_deal_id)", () => {
    const result = validateDealInput(validAppDeal());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a valid IMPORT deal", () => {
    expect(validateDealInput(validImportDeal()).ok).toBe(true);
  });

  it("accepts minimal optionals: unassigned owner, prospect (no cedarRidge id), no account fields, no close date", () => {
    const result = validateDealInput({
      source: "APP",
      name: "Mabel Murray - Unknown Firm",
      client_first_name: "Casey",
      client_last_name: "Invented",
      amount: 0, // zero is a value, not an error
      stage: "LOST",
      created_date: "2026-06-15",
      owner_name: null,
      cedar_ridge_user_id: null,
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateDealInput — required fields", () => {
  it.each([
    ["name", { name: "" }],
    ["name", { name: "   " }],
    ["client_first_name", { client_first_name: "" }],
    ["client_last_name", { client_last_name: "  " }],
  ] as const)("flags blank %s", (field, patch) => {
    expect(errorFields({ ...validAppDeal(), ...patch })).toContain(field);
  });

  it("requires created_date", () => {
    expect(
      errorFields({ ...validAppDeal(), created_date: "" }),
    ).toContain("created_date");
  });
});

describe("validateDealInput — amount", () => {
  it("rejects a non-numeric amount (unparsed form/CSV string -> NaN)", () => {
    expect(errorFields({ ...validAppDeal(), amount: Number("abc") })).toContain(
      "amount",
    );
  });

  it("rejects Infinity and negative amounts", () => {
    expect(errorFields({ ...validAppDeal(), amount: Infinity })).toContain("amount");
    expect(errorFields({ ...validAppDeal(), amount: -1 })).toContain("amount");
  });
});

describe("validateDealInput — enums", () => {
  it("rejects an unknown stage", () => {
    expect(
      errorFields({ ...validAppDeal(), stage: "PENDING" as DealInput["stage"] }),
    ).toContain("stage");
  });

  it("rejects an unknown source", () => {
    expect(
      errorFields({ ...validAppDeal(), source: "SYNC" as DealInput["source"] }),
    ).toContain("source");
  });
});

describe("validateDealInput — provenance (ADR-2)", () => {
  it("requires sf_deal_id when source is IMPORT (the upsert/dedupe key)", () => {
    expect(
      errorFields({ ...validImportDeal(), sf_deal_id: null }),
    ).toContain("sf_deal_id");
    expect(
      errorFields({ ...validImportDeal(), sf_deal_id: "  " }),
    ).toContain("sf_deal_id");
  });

  it("does not require sf_deal_id for APP rows", () => {
    expect(validateDealInput(validAppDeal()).ok).toBe(true);
  });
});

describe("validateDealInput — date sanity", () => {
  it.each([
    ["created_date", "07/01/2026"], // wrong format
    ["created_date", "2026-13-01"], // impossible month
    ["created_date", "2026-02-30"], // impossible day
    ["created_date", "1899-12-31"], // out of range
    ["close_date", "not-a-date"],
    ["last_activity_date", "2026-6-1"], // unpadded
  ] as const)("flags bad %s %s", (field, value) => {
    expect(errorFields({ ...validAppDeal(), [field]: value })).toContain(field);
  });

  it("accepts a leap day", () => {
    expect(
      validateDealInput({ ...validAppDeal(), close_date: "2028-02-29" }).ok,
    ).toBe(true);
  });
});

describe("validateDealInput — account_last4 (relaxed real-world rule, D8 follow-on)", () => {
  // Real custodian formats from the v2 export shapes — all accepted now.
  it.each(["1234", "123", "81-154", "M1DU", "x207", "*005", "06-154", "abcd"])(
    "accepts %s",
    (acct) => {
      expect(
        validateDealInput({ ...validAppDeal(), account_last4: acct }).ok,
      ).toBe(true);
    },
  );

  it.each(["12345678901", "a b", "12/34", "acct#9"])("rejects %s", (acct) => {
    expect(errorFields({ ...validAppDeal(), account_last4: acct })).toContain(
      "account_last4",
    );
  });

  it("accepts a null account # (unparseable deal names leave account fields null)", () => {
    expect(
      validateDealInput({ ...validAppDeal(), account_last4: null }).ok,
    ).toBe(true);
  });
});

describe("validateDealInput — error accumulation", () => {
  it("reports every failing field at once (inline form errors)", () => {
    const fields = errorFields({
      source: "IMPORT",
      sf_deal_id: null,
      name: "",
      client_first_name: "",
      client_last_name: "",
      amount: Number.NaN,
      stage: "NOPE" as DealInput["stage"],
      created_date: "bad",
      account_last4: "9/9",
    });
    expect(fields).toEqual(
      expect.arrayContaining([
        "name",
        "client_first_name",
        "client_last_name",
        "amount",
        "stage",
        "sf_deal_id",
        "created_date",
        "account_last4",
      ]),
    );
  });
});
