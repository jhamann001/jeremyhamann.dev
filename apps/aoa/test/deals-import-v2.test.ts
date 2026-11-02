import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { validateDealInput } from "@/lib/data/deal-validate";
import {
  buildReconciliation,
  dealInputToDbData,
  formatReconciliation,
  mapFundingType,
  mapReportRow,
  normalizeAccountNumber,
  parseRollingInto,
  recordsFromCsv,
} from "@/lib/deals/import-csv";

// D8 follow-on: the deals-export-v2 format — explicit Sending Firm / Funding
// Type / Other Details / Employer / Rolling Into / Account Number columns.
// ALL fixture data is INVENTED (PII rule): V2- ids, Sample/Example/Mock names.
// The REAL export is never copied into the repo or tests — these fixtures
// mirror its SHAPES only (odd account formats, dash placeholders, etc.).

const FIXTURE_V2 = readFileSync(
  path.join(import.meta.dirname, "fixtures", "deals-import-v2.csv"),
  "utf8",
);
const FIXTURE_V1 = readFileSync(
  path.join(import.meta.dirname, "fixtures", "deals-import.csv"),
  "utf8",
);

function mapAll(csvText: string) {
  return recordsFromCsv(csvText).map((record) => {
    const mapped = mapReportRow(record);
    return { ...mapped, errors: validateDealInput(mapped.input).errors };
  });
}

describe("mapFundingType — D8 Other semantics", () => {
  it("Other stores the details text; empty details → the literal 'Other'", () => {
    expect(mapFundingType("Other", "Profit-sharing plan")).toBe("Profit-sharing plan");
    expect(mapFundingType("other", "403b")).toBe("403b"); // case-insensitive Other
    expect(mapFundingType("Other", "")).toBe("Other");
    expect(mapFundingType("Other", "-")).toBe("Other"); // dash placeholder = empty
  });

  it("empty / dash funding type → null; reserved values pass verbatim", () => {
    expect(mapFundingType("", "ignored")).toBeNull();
    expect(mapFundingType("—", "")).toBeNull();
    expect(mapFundingType("Cash", "")).toBe("Cash");
    expect(mapFundingType("401(k) Rollover", "")).toBe("401(k) Rollover");
  });
});

describe("normalizeAccountNumber — relaxed real-world rule", () => {
  it.each(["81-154", "M1DU", "x207", "*005", "06-154", "1234"])(
    "accepts %s verbatim",
    (v) => {
      expect(normalizeAccountNumber(v)).toEqual({ value: v, invalid: false });
    },
  );

  it("empty and dash placeholders → null without a warning", () => {
    expect(normalizeAccountNumber("")).toEqual({ value: null, invalid: false });
    expect(normalizeAccountNumber("-")).toEqual({ value: null, invalid: false });
  });

  it("invalid formats → null WITH the warning flag", () => {
    expect(normalizeAccountNumber("0-15/44X")).toEqual({ value: null, invalid: true });
    expect(normalizeAccountNumber("12345678901")).toEqual({ value: null, invalid: true }); // 11 chars
    expect(normalizeAccountNumber("a b")).toEqual({ value: null, invalid: true });
  });
});

describe("parseRollingInto — option validation", () => {
  it("accepts the two IRA options, canonicalizing case", () => {
    expect(parseRollingInto("Roth IRA")).toEqual({ value: "Roth IRA", invalid: false });
    expect(parseRollingInto("traditional ira")).toEqual({
      value: "Traditional IRA",
      invalid: false,
    });
  });

  it("empty → null silently; anything else → null with the warning flag", () => {
    expect(parseRollingInto("")).toEqual({ value: null, invalid: false });
    expect(parseRollingInto("Brokerage")).toEqual({ value: null, invalid: true });
  });
});

describe("mapReportRow — v2 explicit columns", () => {
  const rows = mapAll(FIXTURE_V2);
  const byId = new Map(rows.map((r) => [r.input.sf_deal_id, r]));

  it("maps all 7 rows and every one passes validateDealInput", () => {
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r.errors).toEqual([]);
  });

  it("Other → details stored, employer KEPT (D8 follow-on ruling)", () => {
    const r = byId.get("V2-0001")!.input;
    expect(r.account_type).toBe("Profit-sharing plan");
    expect(r.employer).toBe("Globex Manufacturing");
    expect(r.rolling_into).toBeNull();
    expect(r.account_last4).toBe("81-154"); // odd format accepted
    expect(r.transferring_firm).toBe("Fidelity");
  });

  it("401(k) Rollover keeps employer + validated rolling_into; alnum acct #", () => {
    const r = byId.get("V2-0002")!.input;
    expect(r.account_type).toBe("401(k) Rollover");
    expect(r.employer).toBe("Initech");
    expect(r.rolling_into).toBe("Roth IRA");
    expect(r.account_last4).toBe("M1DU");
  });

  it("empty funding type → null; empty firm → null; '*005' accepted", () => {
    const r = byId.get("V2-0003")!.input;
    expect(r.account_type).toBeNull();
    expect(r.transferring_firm).toBeNull();
    expect(r.account_last4).toBe("*005");
  });

  it("Other with empty details stores the literal 'Other'", () => {
    expect(byId.get("V2-0004")!.input.account_type).toBe("Other");
  });

  it("invalid rolling_into and account # drop to null with per-row warnings", () => {
    const r = byId.get("V2-0005")!;
    expect(r.input.rolling_into).toBeNull();
    expect(r.input.account_last4).toBeNull();
    expect(r.input.employer).toBe("Hooli"); // employer itself untouched
    expect(r.warnings).toEqual([
      "account_number: invalid format — dropped",
      "rolling_into: unrecognized value — dropped",
    ]);
  });

  it("dash placeholder cells read as empty (firm + account #)", () => {
    const r = byId.get("V2-0006")!.input;
    expect(r.account_type).toBe("Cash");
    expect(r.transferring_firm).toBeNull();
    expect(r.account_last4).toBeNull();
    expect(byId.get("V2-0006")!.warnings).toEqual([]); // placeholders warn nothing
  });

  it("explicit columns WIN over the deal-name parse", () => {
    // V2-0007's name parses as Betterment / Individual / 6633 — the columns say otherwise.
    const r = byId.get("V2-0007")!.input;
    expect(r.transferring_firm).toBe("Pershing");
    expect(r.account_type).toBe("Traditional IRA");
    expect(r.account_last4).toBe("06-154");
  });

  it("dbData carries the companions for v2 rows (upsert update path updates them)", () => {
    const data = dealInputToDbData(byId.get("V2-0002")!.input);
    expect(data.employer).toBe("Initech");
    expect(data.rolling_into).toBe("Roth IRA");
    expect(data.account_type).toBe("401(k) Rollover");
    // Import posture: no timeline / win-loss / archive keys in the payload.
    expect("stage_history" in data).toBe(false);
    expect("lost_from" in data).toBe(false);
    expect("archived_at" in data).toBe(false);
    expect("archived_reason" in data).toBe(false);
  });
});

describe("backward compatibility — old-format CSVs behave exactly as before", () => {
  it("old-format mapping never sets employer/rolling_into (keys absent)", () => {
    const rows = mapAll(FIXTURE_V1);
    for (const r of rows) {
      expect("employer" in r.input).toBe(false);
      expect("rolling_into" in r.input).toBe(false);
      expect(r.warnings).toEqual([]);
      // dbData omits the companion keys too — an old-format re-import can
      // never null companions a v2 import wrote.
      const data = dealInputToDbData(r.input);
      expect("employer" in data).toBe(false);
      expect("rolling_into" in data).toBe(false);
    }
  });

  it("old-format account fields still come from the deal-name parser", () => {
    const rows = mapAll(FIXTURE_V1);
    const first = rows.find((r) => r.input.sf_deal_id === "FIX-0001")!.input;
    expect(first.transferring_firm).toBe("Fidelity");
    expect(first.account_type).toBe("Roth IRA");
    expect(first.account_last4).toBe("1234");
  });
});

describe("reconciliation — v2 fill counts + warnings (PII-free)", () => {
  const rows = mapAll(FIXTURE_V2);
  const r = buildReconciliation(rows);

  it("counts per-field fill over the mapped inputs", () => {
    expect(r.fieldFill).toEqual({
      fundingType: 6, // one empty funding type
      employer: 3, // Globex Manufacturing / Initech / Hooli
      rollingInto: 1, // the one valid Roth IRA
      accountNumber: 5, // 81-154, M1DU, *005, x207, 06-154 (dropped + dash excluded)
      transferringFirm: 5,
    });
  });

  it("collects row warnings with SF ids + field names only", () => {
    expect(r.rowWarnings).toEqual([
      {
        rowNumber: 5,
        sfDealId: "V2-0005",
        warnings: [
          "account_number: invalid format — dropped",
          "rolling_into: unrecognized value — dropped",
        ],
      },
    ]);
  });

  it("formats the new lines without leaking a name or amount", () => {
    const out = formatReconciliation(r);
    expect(out).toContain("Field fill (non-null):");
    expect(out).toContain("Row warnings (soft):        1");
    expect(out).toContain("row 5 [V2-0005]: account_number: invalid format — dropped; rolling_into: unrecognized value — dropped");
    for (const row of rows) {
      expect(out).not.toContain(row.input.client_first_name);
      expect(out).not.toContain(String(row.input.amount));
    }
  });
});
