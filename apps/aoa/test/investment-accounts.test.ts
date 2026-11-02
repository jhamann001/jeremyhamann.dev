import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => "/households/synthetic" }));
vi.mock("@/app/(authenticated)/client-portrait/[id]/actions", () => ({ previewLinkedHoldings: vi.fn() }));
import { investmentAccountBaseSql, investmentAumState } from "@/lib/data/investment-accounts";
import type { InvestmentAccount } from "@/lib/data/types";
import { AccountsSection } from "@/components/client-portrait/AccountsSection";
import { HouseholdOverview } from "@/components/households/HouseholdOverview";

const account = (extra: Partial<InvestmentAccount> = {}): InvestmentAccount => ({
  id: "Schwab:schw_synthetic", sourceAccountId: "schw_synthetic", custodian: "Schwab",
  type: "Synthetic Trust", num: "••••0001", status: "OPEN", value: 100.01,
  cash: 10, securities: 90.01, balanceAsOf: "2026-09-17", balanceCurrent: true,
  closeDate: null, closeDateSource: null, clientSfId: "synthetic-person", householdSfId: "synthetic-household",
  firmOperating: false, ...extra,
});

describe("custodian-neutral display boundary", () => {
  it("retains cents, negative/zero balances and distinguishes absent from pending", () => {
    expect(investmentAumState([])).toMatchObject({ value: null, availability: "ABSENT" });
    expect(investmentAumState([account({ value: 0 })])).toMatchObject({ value: 0, availability: "AVAILABLE" });
    expect(investmentAumState([account(), account({ custodian: "Apex", value: -0.02 })]))
      .toEqual({ value: 99.99, availability: "AVAILABLE", source: "custodians" });
    expect(investmentAumState([account(), account({ balanceCurrent: false })]))
      .toMatchObject({ value: null, availability: "PENDING" });
    expect(investmentAumState([account({ status: "CLOSED", balanceCurrent: false })]))
      .toMatchObject({ value: 0, availability: "AVAILABLE" });
    expect(investmentAumState([account({ value: null })]).availability).toBe("PENDING");
  });

  it.each([
    ["2026-09-18T16:00:00Z", "2026-09-17"],
    ["2026-09-21T16:00:00Z", "2026-09-18"],
    ["2026-09-08T16:00:00Z", "2026-09-04"],
  ])("bounds Schwab freshness with the existing ET trading calendar: %s", (now, minimum) => {
    const sql = investmentAccountBaseSql(new Date(now));
    expect(sql.values).toContain(minimum);
    expect(sql.text).toContain("balance_as_of BETWEEN");
    expect(sql.text).not.toMatch(/\baccount_number\b|source_sha256|source_key|SELECT \*/);
    expect(sql.text).toContain("account_number_last4");
  });

  it("renders both custodians, masked last four, balance dates and a genuine zero", () => {
    const html = renderToStaticMarkup(createElement(AccountsSection, {
      clientName: "Invented Person", accounts: { apex: [], investment: [account(), account({
        id: "Apex:synthetic", custodian: "Apex", num: "SYNTHETIC", value: 0,
      })], ext: [], bene: [], plaidLinked: false },
    }));
    for (const text of ["Investment accounts", "Schwab", "Apex", "••••0001", "2026-09-17", "$0"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("/performance");
  });

  it("renders pending household balances with their last date, not a partial current total", () => {
    const html = renderToStaticMarkup(createElement(HouseholdOverview, {
      name: "Invented Household", members: [], accounts: [
        { ...account({ balanceCurrent: false }), owner: "Household-held" },
      ],
    }));
    expect(html).toContain("Schwab");
    expect(html).toContain("refresh pending");
    expect(html).toContain("Sep 17, 2026");
    expect(html).not.toContain("$100.01");
  });

  it("preserves the production legacy Apex shape without requiring form-account identifiers", () => {
    const html = renderToStaticMarkup(createElement(AccountsSection, {
      clientName: "Invented Person", accounts: { apex: [{
        type: "Synthetic IRA", num: "SYNTHETIC-LEGACY", status: "OPEN",
        value: 12.34, balanceCurrent: true,
      }], ext: [], bene: [], plaidLinked: false },
    }));
    expect(html).toContain("SYNTHETIC-LEGACY");
    expect(html).toContain("Apex");
    expect(html).toContain("$12.34");
  });

  it("keeps Apex form and report selectors on their existing authorization seam", () => {
    const portrait = readFileSync("app/(authenticated)/client-portrait/[id]/page.tsx", "utf8");
    expect(portrait).toContain("accounts.apex");
    const report = readFileSync("app/(authenticated)/performance/household/[householdId]/page.tsx", "utf8");
    expect(report).toContain("apexAccountsForHousehold");
    expect(report).not.toContain("investmentAccounts");
  });
});
