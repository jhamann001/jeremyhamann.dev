import { describe, expect, it } from "vitest";
import {
  accountLast4,
  initialFundingCoverage,
} from "@/lib/data/funding-request-check";
import type { TradeRequestSummary, TradeRequestAccount } from "@/lib/data/trade-requests";

// Pure matcher — no DB, no mocks. Confirms the Initial-Funding-only scope, the
// last-4 (only) match, mask-style independence, and multi-account membership.

function acct(accountNumber: string | null, accountType: string | null): TradeRequestAccount {
  return { accountNumber, accountType, balance: null };
}

function mkReq(over: Partial<TradeRequestSummary> = {}): TradeRequestSummary {
  return {
    id: "REQ-TEST",
    clientId: "u1",
    clientIds: ["u1"],
    status: "Approved",
    tradeType: "Initial Funding",
    priority: "Standard",
    createdAt: null,
    updatedAt: null,
    totalValue: null,
    advisor: null,
    householdId: null,
    householdName: null,
    selectedAccounts: [],
    accounts: [],
    liquidateOption: null,
    liquidationApproval: null,
    ...over,
  };
}

describe("accountLast4", () => {
  it("strips either mask style to the trailing 4 (lower-cased)", () => {
    expect(accountLast4("••••4M46")).toBe("4m46");
    expect(accountLast4("****4M46")).toBe("4m46");
    expect(accountLast4("7DW4M46")).toBe("4m46"); // full Apex id
  });
  it("null when fewer than 4 chars", () => {
    expect(accountLast4("•••")).toBeNull();
    expect(accountLast4(null)).toBeNull();
    expect(accountLast4("")).toBeNull();
  });
});

describe("initialFundingCoverage", () => {
  const receiving = { last4: "••••3N12" };

  it("covered when an Initial Funding request lists the account (last-4)", () => {
    const reqs = [mkReq({ id: "REQ-8K68", status: "Approved", accounts: [acct("****3N12", "Roth IRA")] })];
    expect(initialFundingCoverage(receiving, reqs)).toEqual({
      covered: true,
      requestId: "REQ-8K68",
      status: "Approved",
    });
  });

  it("covered when the account is ONE OF SEVERAL on the request (siblings ignored)", () => {
    const reqs = [
      mkReq({
        id: "REQ-MULTI",
        accounts: [
          acct("****9999", "Traditional IRA"),
          acct("****3N12", "Roth IRA"), // the match
          acct("****1111", "Taxable"),
        ],
      }),
    ];
    expect(initialFundingCoverage(receiving, reqs).covered).toBe(true);
    expect(initialFundingCoverage(receiving, reqs).requestId).toBe("REQ-MULTI");
  });

  it("covered even when the two systems label the registration type differently (last-4 wins)", () => {
    // Regression: the receiving side's asset-map label and the request side's
    // label are different vocabularies for the SAME account. Matching on last-4
    // alone counts it as covered (Reynold Hayes, REQ-X6S651A3, 2026-07-23).
    const reqs = [mkReq({ id: "REQ-VOCAB", accounts: [acct("****3N12", "Traditional IRA")] })];
    expect(initialFundingCoverage(receiving, reqs)).toEqual({
      covered: true,
      requestId: "REQ-VOCAB",
      status: "Approved",
    });
  });

  it("NOT covered by a non-Initial-Funding request even if the account matches", () => {
    const reqs = [
      mkReq({ tradeType: "Rebalance", accounts: [acct("****3N12", "Roth IRA")] }),
      mkReq({ tradeType: "Cash Deposit", accounts: [acct("****3N12", "Roth IRA")] }),
    ];
    expect(initialFundingCoverage(receiving, reqs).covered).toBe(false);
  });

  it("NOT covered when no request lists this account", () => {
    const reqs = [mkReq({ accounts: [acct("****0000", "Roth IRA")] })];
    expect(initialFundingCoverage(receiving, reqs).covered).toBe(false);
  });

  it("NOT covered when the receiving account has no last-4 (not open yet)", () => {
    const reqs = [mkReq({ accounts: [acct("****3N12", "Roth IRA")] })];
    expect(initialFundingCoverage({ last4: null }, reqs).covered).toBe(false);
  });

  it("matches regardless of mask style on either side", () => {
    const reqs = [mkReq({ id: "REQ-M", accounts: [acct("****5063", "Roth IRA")] })];
    expect(initialFundingCoverage({ last4: "••••5063" }, reqs).covered).toBe(true);
  });
});
