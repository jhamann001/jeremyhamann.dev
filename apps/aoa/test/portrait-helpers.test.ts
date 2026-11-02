import { describe, expect, it } from "vitest";
import {
  apexAccountBalanceAvailable,
  apexBalancesAvailable,
  apexTotal,
  clientDealRollup,
  dealFirmLine,
  extTotal,
  linkedDisplayedTotal,
  groupBeneficiaries,
} from "@/components/client-portrait/portrait-helpers";
import type { ApexAccount, Beneficiary, ExternalAccount } from "@/lib/data/types";
import type { DealRow, DealStage } from "@/lib/data/deal-types";

const apex: ApexAccount[] = [
  { type: "Trust Brokerage", num: "••••2100", status: "Active", value: 1620000 },
  { type: "Roth IRA", num: "••••5725", status: "Funding", value: 220000 },
];

const ext: ExternalAccount[] = [
  { inst: "First Federal", type: "Checking", num: "••••1835", balance: 84000 },
  { inst: "Vanguard", type: "529", num: "••••1690", balance: 132000 },
];

describe("apexTotal / extTotal", () => {
  it("sums account values", () => {
    expect(apexTotal(apex)).toBe(1840000);
    expect(extTotal(ext)).toBe(216000);
  });

  it("returns 0 for empty lists", () => {
    expect(apexTotal([])).toBe(0);
    expect(extTotal([])).toBe(0);
  });

  it("suppresses rollout-pending open balances without hiding a closed $0", () => {
    const pending: ApexAccount = {
      type: "IRA", num: "1", status: "OPEN", value: 1000, balanceCurrent: false,
    };
    const closed: ApexAccount = {
      type: "IRA", num: "2", status: "CLOSED", value: 0, balanceCurrent: false,
    };
    expect(apexAccountBalanceAvailable(pending)).toBe(false);
    expect(apexAccountBalanceAvailable(closed)).toBe(true);
    expect(apexBalancesAvailable([pending, closed])).toBe(false);
  });

  it("sums rendered holdings totals and ignores institution balance", () => {
    const known = (institutionBalance: number | null, holdingsTotal: number | null): ExternalAccount => ({
      inst: "Bank", type: "brokerage", num: "••••1", balance: holdingsTotal ?? 0,
      holdingsTotal, institutionBalance,
    });
    expect(linkedDisplayedTotal([known(100, 10.1), known(200, 20.2)])).toBe(30.3);
    expect(linkedDisplayedTotal([known(10, null), known(5, 15)])).toBe(15);
    expect(linkedDisplayedTotal([known(10, null), known(5, null)])).toBeNull();
    expect(linkedDisplayedTotal([known(null, 99), known(null, 1)])).toBe(100);
    expect(linkedDisplayedTotal([])).toBe(0);
  });

  it("uses the same normalized closed status for row availability and the current footer", () => {
    const closed: ApexAccount = {
      type: "IRA", num: "closed", status: " closed ", value: 999, balanceCurrent: true,
    };
    expect(apexAccountBalanceAvailable(closed)).toBe(true);
    expect(apexBalancesAvailable([closed])).toBe(true);
    expect(apexTotal([closed])).toBe(0);
  });
});

describe("groupBeneficiaries", () => {
  const bene: Beneficiary[] = [
    { name: "Jo Stone", rel: "Spouse", pct: 100, dob: "03/12/1958", acct: "Traditional IRA", num: "••••2922" },
    { name: "Casey Stone", rel: "Child", pct: 50, dob: "06/04/1988", acct: "Roth IRA", num: "••••5725" },
    { name: "Drew Stone", rel: "Child", pct: 50, dob: "09/22/1991", acct: "Roth IRA", num: "••••5725" },
  ];

  it("groups by owning account number, preserving first-seen order", () => {
    const groups = groupBeneficiaries(bene);
    expect(groups.map((g) => g.num)).toEqual(["••••2922", "••••5725"]);
    expect(groups[0].acct).toBe("Traditional IRA");
    expect(groups[0].list).toHaveLength(1);
    expect(groups[1].list.map((b) => b.name)).toEqual(["Casey Stone", "Drew Stone"]);
  });

  it("returns no groups for no beneficiaries", () => {
    expect(groupBeneficiaries([])).toEqual([]);
  });
});

describe("clientDealRollup (tkt-deals-client-link)", () => {
  // Minimal DealRow builder — only the two fields the rollup reads (stage +
  // amount); the rest are plausible fillers. Mirrors getHousehold's dealSummary
  // fold: openPipeline SUMS amount for stages NOT in WON/LOST.
  let n = 0;
  const deal = (stage: DealStage, amount: number): DealRow => {
    n += 1;
    return { id: `d-${n}`, stage, amount } as DealRow;
  };

  it("counts every deal but sums only open (non-WON/LOST) amounts", () => {
    const deals = [
      deal("POTENTIAL", 100),
      deal("COMMITTED", 200),
      deal("FUNDING", 50),
      deal("WON", 400), // excluded from openPipeline
      deal("LOST", 999), // excluded from openPipeline
    ];
    expect(clientDealRollup(deals)).toEqual({
      count: 5,
      outstandingCount: 3,
      outstandingAmount: 350,
      fundedCount: 1,
      fundedAmount: 400,
      openPipeline: 350,
    });
  });

  it("is zeroes for an empty list (the empty-state signal)", () => {
    expect(clientDealRollup([])).toEqual({
      count: 0,
      outstandingCount: 0,
      outstandingAmount: 0,
      fundedCount: 0,
      fundedAmount: 0,
      openPipeline: 0,
    });
  });

  it("open pipeline is 0 when every deal is already WON/LOST", () => {
    expect(clientDealRollup([deal("WON", 500), deal("LOST", 300)])).toEqual(
      {
        count: 2,
        outstandingCount: 0,
        outstandingAmount: 0,
        fundedCount: 1,
        fundedAmount: 500,
        openPipeline: 0,
      },
    );
  });
});

describe("dealFirmLine (tkt-deals-transferring-firm)", () => {
  it("prefixes the firm with 'via' when present", () => {
    expect(dealFirmLine("Fidelity")).toBe("via Fidelity");
  });

  it("omits the line (null) when there is no transferring firm", () => {
    // null → the subtitle is not rendered at all (never "via —").
    expect(dealFirmLine(null)).toBeNull();
  });

  it("treats a blank/whitespace firm as absent, and trims", () => {
    expect(dealFirmLine("")).toBeNull();
    expect(dealFirmLine("   ")).toBeNull();
    expect(dealFirmLine("  Schwab  ")).toBe("via Schwab");
  });
});
