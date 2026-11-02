import { describe, it, expect } from "vitest";
import {
  accountStatusTone,
  accountsTotal,
  currentAccountsTotal,
  currentAccountsSummary,
  accountBalanceState,
  isEmptyAccount,
  accountCountLabel,
  type CombinedAccount,
} from "@/components/households/accounts-helpers";
import { usd } from "@/lib/format";

// TKT household-report consolidation: the "Combined accounts" card and the
// households-list per-row report link are now REAL. These cover the pure logic
// behind that card (status tone, roll-up total, count pill) and
// the value-display convention (null → "—", real $0 → "$0"). Node env — no DOM;
// the JSX wiring is a thin render over these functions.

describe("accountStatusTone", () => {
  it("maps OPEN/ACTIVE to green", () => {
    expect(accountStatusTone("OPEN")).toBe("green");
    expect(accountStatusTone("ACTIVE")).toBe("green");
  });

  it("maps FUNDING/PENDING to amber", () => {
    expect(accountStatusTone("FUNDING")).toBe("amber");
    expect(accountStatusTone("PENDING")).toBe("amber");
  });

  it("maps CLOSED/RESTRICTED/unknown/null to gray", () => {
    expect(accountStatusTone("CLOSED")).toBe("gray");
    expect(accountStatusTone("RESTRICTED")).toBe("gray");
    expect(accountStatusTone("something-else")).toBe("gray");
    expect(accountStatusTone(null)).toBe("gray");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(accountStatusTone(" open ")).toBe("green");
    expect(accountStatusTone("Pending")).toBe("amber");
  });
});

describe("accountsTotal", () => {
  it("sums non-null values", () => {
    expect(accountsTotal([{ value: 100 }, { value: 250 }, { value: 50 }])).toBe(400);
  });

  it("skips null (unknown) values but counts a real $0", () => {
    expect(accountsTotal([{ value: 100 }, { value: null }, { value: 0 }])).toBe(100);
  });

  it("all-null (or empty) totals 0", () => {
    expect(accountsTotal([{ value: null }, { value: null }])).toBe(0);
    expect(accountsTotal([])).toBe(0);
  });
});

describe("currentAccountsTotal", () => {
  it("excludes closed and retired balances from current AUM", () => {
    expect(currentAccountsTotal([
      { value: 125, balanceCurrent: true },
      { value: 900, balanceCurrent: false },
      { value: 0, balanceCurrent: true },
    ])).toBe(125);
  });

  it("makes the aggregate unavailable when any visible open/unknown row is pending", () => {
    expect(currentAccountsSummary([
      { value: 125, status: "OPEN", balanceCurrent: true },
      { value: 900, status: null, balanceCurrent: false },
    ])).toEqual({ available: false, value: null });
    expect(currentAccountsSummary([
      { value: 125, status: "OPEN", balanceCurrent: true },
      { value: 0, status: "CLOSED", balanceCurrent: false },
    ])).toEqual({ available: true, value: 125 });
  });
});

describe("accountBalanceState", () => {
  it("keeps rollout freshness separate from lifecycle", () => {
    expect(accountBalanceState({ status: "OPEN", balanceCurrent: false }))
      .toBe("REFRESH_PENDING");
    expect(accountBalanceState({ status: "OPEN", balanceCurrent: true }))
      .toBe("CURRENT");
    expect(accountBalanceState({ status: "CLOSED", balanceCurrent: false }))
      .toBe("CLOSED");
    expect(accountBalanceState({ status: null, balanceCurrent: false }))
      .toBe("REFRESH_PENDING");
  });
});

describe("isEmptyAccount", () => {
  const emptyAccount: CombinedAccount = {
    id: "synthetic-apex-account",
    custodian: "Apex",
    owner: "Alex Doe",
    type: "Individual",
    num: "••••1234",
    status: "OPEN",
    cash: 0,
    securities: 0,
    value: 0,
    balanceAsOf: "2026-09-24",
    balanceCurrent: true,
    closeDate: null,
    closeDateSource: null,
  };

  it.each(["Apex", "Schwab"] as const)("recognizes current zero balances for %s", (custodian) => {
    const account = { ...emptyAccount, custodian };
    expect(isEmptyAccount(account)).toBe(true);
  });

  it.each(["cash", "securities", "value"] as const)("retains any nonzero %s without rounding", (field) => {
    for (const balance of [250, -250, 0.001, -0.001]) {
      expect(isEmptyAccount({ ...emptyAccount, [field]: balance })).toBe(false);
    }
  });

  it("retains offsetting cash and securities even when the total is zero", () => {
    expect(isEmptyAccount({ ...emptyAccount, cash: -500, securities: 500 })).toBe(false);
    expect(isEmptyAccount({ ...emptyAccount, cash: 500, securities: -500 })).toBe(false);
  });

  it.each(["cash", "securities", "value"] as const)("retains null, missing and nonfinite %s", (field) => {
    for (const balance of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(isEmptyAccount({ ...emptyAccount, [field]: balance })).toBe(false);
    }
  });

  it.each(["OPEN", "PENDING", null])("retains stale or refresh-pending zeros with status %s", (status) => {
    expect(isEmptyAccount({ ...emptyAccount, status, balanceCurrent: false })).toBe(false);
  });

  it("does not treat a missing freshness marker as current", () => {
    const withoutFreshness: Partial<CombinedAccount> = { ...emptyAccount };
    delete withoutFreshness.balanceCurrent;
    expect(isEmptyAccount(withoutFreshness as CombinedAccount)).toBe(false);
  });

  it("preserves closed accounts even if the freshness flag is inconsistent", () => {
    expect(isEmptyAccount({ ...emptyAccount, status: " closed " })).toBe(false);
    expect(isEmptyAccount({ ...emptyAccount, status: "CLOSED", balanceCurrent: false })).toBe(false);
  });

  it("uses confirmed balance freshness independently of unknown lifecycle", () => {
    expect(isEmptyAccount({ ...emptyAccount, status: null })).toBe(true);
  });
});

describe("accountCountLabel", () => {
  it("pluralizes on count", () => {
    expect(accountCountLabel(0)).toBe("0 accounts");
    expect(accountCountLabel(1)).toBe("1 account");
    expect(accountCountLabel(3)).toBe("3 accounts");
  });
});

describe("combined-accounts value display convention", () => {
  it("null value renders an em dash, a real $0 renders $0", () => {
    const accounts: CombinedAccount[] = [
      { owner: "Alex Doe", type: "Roth IRA", num: "••••1234", status: "OPEN", value: 0,
        cash: 0, securities: 0, balanceAsOf: "2026-08-21", balanceCurrent: true,
        closeDate: null, closeDateSource: null },
      { owner: "Paulette Doe", type: "Individual", num: "••••5678", status: "PENDING", value: null,
        cash: null, securities: null, balanceAsOf: null, balanceCurrent: false,
        closeDate: null, closeDateSource: null },
    ];
    expect(usd(accounts[0].value)).toBe("$0");
    expect(usd(accounts[1].value)).toBe("—");
  });
});
