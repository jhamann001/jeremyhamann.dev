import { describe, it, expect } from "vitest";
import {
  FIRM_HOUSEHOLD_ID,
  FIRM_HOUSEHOLD_NAME,
  FIRM_ACCOUNT_IDS,
  FIRM_ACCOUNT_TITLES,
  isFirmAccount,
  firmAccountTitle,
  canSeeFirmHousehold,
  splitAum,
} from "@/lib/data/firm-household";
import { usdCents } from "@/lib/format";

// ticket — pure config + KPI-split logic. This is where the AUM-parity targets
// are pinned: the households KPI must show a Total that ties to Apex
// ($25,335,920.80) and a Client figure that excludes the firm ($25,248,316.42),
// with the firm household holding the 4 corporate accounts ($87,604.38).

// The validated firm-wide totals from card 6601 (fixtures — made-up numbers).
const TOTAL_AUM = 25_335_920.80; // ties to Apex's report (all 311 rows)
const FIRM_AUM = 87_604.38; // the 4 corporate accounts
const CLIENT_AUM = 25_248_316.42; // household-mapped (excludes the firm)

describe("firm household config", () => {
  it("pins the sentinel id, name, and the 4 corporate ULIDs → titles", () => {
    expect(FIRM_HOUSEHOLD_ID).toBe("FIRM-CEDAR-RIDGE");
    expect(FIRM_HOUSEHOLD_NAME).toBe("Cedar Ridge Wealth");
    expect(FIRM_ACCOUNT_IDS.size).toBe(4);
    expect(FIRM_ACCOUNT_TITLES).toEqual({
      "01SYNTH6BDYNAGTJ07KC0SFYGY": "Fee Account",
      "01SYNTH69JZYE3TD78SPZ4PBWK": "Deposit Account",
      "01SYNTH1B11MYXFS3Q5B5D2WNW": "Error Account",
      "01SYNTH85BR7BT1ZPYKBDZAC9C": "Allocation Account",
    });
  });

  it("isFirmAccount / firmAccountTitle recognize firm ULIDs and reject others", () => {
    expect(isFirmAccount("01SYNTH6BDYNAGTJ07KC0SFYGY")).toBe(true);
    expect(firmAccountTitle("01SYNTH1B11MYXFS3Q5B5D2WNW")).toBe("Error Account");
    expect(isFirmAccount("01CLIENTACCOUNTULID00000000")).toBe(false);
    expect(firmAccountTitle("01CLIENTACCOUNTULID00000000")).toBeNull();
    expect(isFirmAccount(null)).toBe(false);
    expect(isFirmAccount(undefined)).toBe(false);
    expect(firmAccountTitle(null)).toBeNull();
  });
});

describe("canSeeFirmHousehold (RLS parity in TS)", () => {
  it("only ADMIN / OPERATIONS see the firm", () => {
    for (const role of ["ADMIN", "OPERATIONS"]) {
      expect(canSeeFirmHousehold(role)).toBe(true);
    }
    // HEAD_OF_ADVISORY is no longer a live role (inert enum leftover, nothing
    // mints it) and is not a FIRM_HOUSEHOLD_ROLES member → fails closed.
    for (const role of ["HEAD_OF_ADVISORY", "ADVISOR", "CLIENT_SERVICE", "VIEWER", "", null, undefined]) {
      expect(canSeeFirmHousehold(role)).toBe(false);
    }
  });
});

describe("splitAum — Client vs Total, penny-exact (AUM parity)", () => {
  it("Total AUM ties to Apex and Client AUM excludes the firm", () => {
    const { total, firm, client } = splitAum(TOTAL_AUM, FIRM_AUM);
    expect(total).toBe(25_335_920.80); // Total = Apex report total
    expect(firm).toBe(87_604.38); // Firm = the 4 corporate accounts
    expect(client).toBe(25_248_316.42); // Client = Total − Firm (to the penny)
    // Guard against a float tail leaking (25335920.80 − 87604.38 is not exact
    // in binary): splitAum rounds to whole cents.
    expect(client).toBe(CLIENT_AUM);
  });

  it("with no firm accounts, Client == Total", () => {
    const { total, firm, client } = splitAum(1_000_000.5, 0);
    expect(firm).toBe(0);
    expect(client).toBe(total);
    expect(client).toBe(1_000_000.5);
  });

  it("formats the parity numbers to the penny", () => {
    expect(usdCents(TOTAL_AUM)).toBe("$25,335,920.80");
    expect(usdCents(CLIENT_AUM)).toBe("$25,248,316.42");
    expect(usdCents(FIRM_AUM)).toBe("$87,604.38");
    expect(usdCents(null)).toBe("—");
  });
});
