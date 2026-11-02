import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccountsSection } from "@/components/client-portrait/AccountsSection";
import { HouseholdOverview } from "@/components/households/HouseholdOverview";
import type { ClientAccounts, ExternalAccount, InvestmentAccount } from "@/lib/data/types";
import { usdCents } from "@/lib/format";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/households/synthetic",
}));
vi.mock("@/app/(authenticated)/client-portrait/[id]/actions", () => ({ previewLinkedHoldings: vi.fn() }));

function account(extra: Partial<InvestmentAccount> = {}): InvestmentAccount {
  return {
    id: "Apex:synthetic-apex", sourceAccountId: "synthetic-apex", custodian: "Apex",
    type: "Synthetic IRA", num: "SYNTHETIC-001", status: "OPEN",
    cash: 1234.56, securities: 6789.01, value: 8023.57,
    balanceAsOf: "2026-09-18", balanceCurrent: true,
    closeDate: null, closeDateSource: null,
    clientSfId: "synthetic-person", householdSfId: "synthetic-household",
    firmOperating: false, ...extra,
  };
}

function portrait(investment: InvestmentAccount[], extra: Partial<ClientAccounts> = {}) {
  return renderToStaticMarkup(createElement(AccountsSection, {
    clientName: "Invented Person",
    accounts: { apex: [], investment, ext: [], bene: [], plaidLinked: false, ...extra },
  }));
}

function household(accounts: InvestmentAccount[]) {
  return renderToStaticMarkup(createElement(HouseholdOverview, {
    name: "Invented Household", members: [], initialAccountStatus: "all",
    accounts: accounts.map((a) => ({ ...a, owner: "Invented Person" })),
  }));
}

/** Read actual rendered table cells, rather than asserting on component source. */
function tableRows(html: string): string[][] {
  const table = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? "";
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((cell) => cell[1].replace(/<[^>]*>/g, "")),
  );
}

function portraitRow(html: string, a: InvestmentAccount): string[] {
  const row = tableRows(html).find((cells) => cells[1] === a.custodian && cells[2] === a.num);
  expect(row).toBeDefined();
  return row!;
}

describe("ticket Client Portrait account components", () => {
  it("matches Household cash, securities and authoritative total to cents for both custodians", () => {
    const accounts = [account(), account({
      id: "Schwab:synthetic-schwab", sourceAccountId: "synthetic-schwab",
      custodian: "Schwab", num: "••••0001", cash: -0.12, securities: 42.35, value: 42.23,
    })];
    const portraitHtml = portrait(accounts);
    const householdRows = tableRows(household(accounts));
    expect(tableRows(portraitHtml)[0]).toEqual([
      "Account type", "Custodian", "Account #", "Status", "Cash", "Securities", "Total", "Balance date",
    ]);
    for (const a of accounts) {
      const row = portraitRow(portraitHtml, a);
      const householdRow = householdRows.find((cells) => cells[2] === a.custodian && cells[3] === a.num);
      expect(row.slice(4, 7)).toEqual(householdRow?.slice(5, 8));
      expect(row.at(-1)).toBe("2026-09-18");
      expect(householdRow?.at(-1)).toBe("As of Sep 18, 2026");
    }
    expect(portraitRow(portraitHtml, accounts[0]).slice(4, 7)).toEqual(["$1,234.56", "$6,789.01", "$8,023.57"]);
    expect(portraitRow(portraitHtml, accounts[1]).slice(4, 7)).toEqual(["-$0.12", "$42.35", "$42.23"]);
    expect(tableRows(portraitHtml).at(-1)).toEqual(["Current investment total", "$8,065.80", ""]);
    expect(tableRows(portraitHtml).at(-1)?.[1]).toBe(householdRows.at(-1)?.[1]);
    expect(portraitHtml).toMatch(/<td\b[^>]*colSpan="6"[^>]*>Current investment total<\/td>/);
  });

  it("never reconstructs total from separately rounded components", () => {
    const a = account({ cash: 1.005, securities: 1.005, value: 2.01 });
    const html = portrait([a]);
    expect(portraitRow(html, a).slice(4, 7)).toEqual(["$1.01", "$1.01", "$2.01"]);
    expect(tableRows(html).at(-1)).toEqual(["Current investment total", "$2.01", ""]);
    expect(portraitRow(html, a).slice(4, 7)).toEqual(tableRows(household([a]))[1].slice(5, 8));
  });

  it.each([
    { cash: 0, securities: 0, value: 0, expected: ["$0.00", "$0.00", "$0.00"] },
    { cash: -12.34, securities: 12.34, value: 0, expected: ["-$12.34", "$12.34", "$0.00"] },
    { cash: -12.34, securities: 0, value: -12.34, expected: ["-$12.34", "$0.00", "-$12.34"] },
  ])("preserves genuine zero, offset and negative values: $expected", ({ cash, securities, value, expected }) => {
    const a = account({ cash, securities, value });
    const html = portrait([a]);
    expect(portraitRow(html, a).slice(4, 7)).toEqual(expected);
    expect(tableRows(html).at(-1)?.[1]).toBe(expected[2]);
  });

  it.each([
    { cash: null, securities: 21.43, value: 21.43, expected: ["—", "$21.43", "$21.43"] },
    { cash: 21.43, securities: null, value: 21.43, expected: ["$21.43", "—", "$21.43"] },
    { cash: null, securities: null, value: null, expected: ["—", "—", "—"] },
  ])("keeps missing components unavailable instead of zero: $expected", ({ cash, securities, value, expected }) => {
    const a = account({ cash, securities, value });
    const html = portrait([a]);
    expect(portraitRow(html, a).slice(4, 7)).toEqual(expected);
    expect(html).toContain("— = unavailable");
    expect(tableRows(html).at(-1)?.[1]).toBe(expected[2]);
  });

  it("keeps legacy Apex components unavailable without losing its known total", () => {
    const html = portrait([], {
      investment: undefined,
      apex: [{ type: "Legacy IRA", num: "SYNTHETIC-LEGACY", status: "Active", value: 12.34 }],
    });
    expect(tableRows(html)[1]).toEqual([
      "Legacy IRA", "Apex", "SYNTHETIC-LEGACY", "Active", "—", "—", "$12.34", "—",
    ]);
    expect(tableRows(html).at(-1)).toEqual(["Current investment total", "$12.34", ""]);
  });

  it.each(["OPEN", "PENDING", ""])("withholds stale %s amounts and the mixed-list total without losing the last source date", (status) => {
    const pending = account({
      id: "Schwab:synthetic-pending", custodian: "Schwab", num: "••••0099", status,
      cash: 11.23, securities: 456.78, value: 468.01, balanceCurrent: false,
    });
    const html = portrait([account(), pending]);
    const row = portraitRow(html, pending);
    expect(row[3]).toBe(status || "—");
    expect(row.at(-1)).toBe("2026-09-18Balance refresh pending");
    expect(row.slice(4, 7)).toEqual(["—", "—", "—"]);
    expect(tableRows(html).at(-1)).toEqual(["Current investment total", "—", ""]);
    expect(html).not.toContain("$468.01");
    expect(html).not.toContain("$11.23");
    expect(html).toContain("Balance refresh pending");
  });

  it("retains closed history, source date and closure provenance but excludes it from the current total", () => {
    const closed = account({
      id: "Apex:synthetic-closed", num: "SYNTHETIC-CLOSED", status: "CLOSED",
      balanceCurrent: false, cash: 12.34, securities: 87.65, value: 99.99,
      closeDate: "2026-09-20", closeDateSource: "PROVISIONAL_OVERRIDE",
    });
    const html = portrait([account(), closed]);
    const row = portraitRow(html, closed);
    expect(row.at(-1)).toBe("2026-09-18Closed 2026-09-20 · operational fallback");
    expect(row.slice(4, 7)).toEqual(["$12.34", "$87.65", "$99.99"]);
    expect(row.slice(4, 7)).toEqual(tableRows(household([closed]))[1].slice(5, 8));
    expect(tableRows(html).at(-1)).toEqual(["Current investment total", "$8,023.57", ""]);
    expect(html).not.toContain("Balance refresh pending");
  });

  it.each([0, null])("distinguishes a closed %s history from an unavailable current balance", (value) => {
    const closed = account({
      status: "CLOSED", balanceCurrent: false, cash: value, securities: value, value,
      closeDate: "2026-09-20", closeDateSource: "APEX",
    });
    const html = portrait([closed]);
    expect(portraitRow(html, closed).slice(4, 7)).toEqual(Array(3).fill(value == null ? "—" : "$0.00"));
    expect(tableRows(html).at(-1)).toEqual(["Current investment total", "$0.00", ""]);
    expect(html).toContain("Closed 2026-09-20");
    expect(html).not.toContain("operational fallback");
    expect(html).not.toContain("Balance refresh pending");
  });

  it("never treats an empty confirmed person list as permission to show legacy or household accounts", () => {
    const html = portrait([], {
      apex: [{ type: "Unselected legacy account", num: "SYNTHETIC-NOT-LINKED", status: "OPEN", value: 50 }],
    });
    expect(html).toContain("No confirmed investment accounts on file.");
    expect(html).not.toContain("SYNTHETIC-NOT-LINKED");
    expect(html).not.toContain("$50");
    expect(html).not.toContain("/performance");
  });

  it("provides a keyboard-scrollable horizontal layout with unbroken numeric columns", () => {
    const html = portrait([account()]);
    expect(html).toMatch(/role="region" aria-label="Investment account balances" tabindex="0"/);
    const css = readFileSync("components/client-portrait/AccountsSection.module.css", "utf8");
    expect(css).toMatch(/\.tableWrap\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.investmentTable\s*\{[^}]*min-width:\s*940px/);
    expect(css).toMatch(/\.investmentTable \.num\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.investmentTable \.num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });
});

function plaidRows(html: string, label: string): string[][] {
  const table = html.match(new RegExp(`<table\\b[^>]*aria-label="${label}"[^>]*>([\\s\\S]*?)</table>`))?.[1];
  expect(table).toBeDefined();
  return [...table!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((cell) => cell[1].replace(/<[^>]*>/g, "")),
  );
}

function liveExt(extra: Partial<ExternalAccount> = {}): ExternalAccount {
  return {
    inst: "Invented Bank", type: "brokerage", num: "••••2222", balance: 1500.25,
    externalAccountId: "ext-synthetic-1", cash: 500.25, securities: 1000,
    holdingsTotal: 1500.25, asOf: "2026-10-01T00:00:00.000Z", institutionBalance: 1499,
    ...extra,
  };
}

describe("ticket Plaid-linked account summaries on the Accounts card", () => {
  it("flag off renders the mock Plaid rows exactly as before", () => {
    const html = portrait([], {
      ext: [{ inst: "Mercury", type: "Business Checking", num: "••••4004", balance: 96000 }],
      plaidLinked: true,
    });
    const plaidTable = html.slice(html.indexOf("Plaid-connected accounts"));
    const rows = [...plaidTable.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
      [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]*>/g, "")));
    expect(rows[0]).toEqual(["Institution", "Type", "Account #", "Balance"]);
    expect(rows[1]).toEqual(["Mercury", "Business Checking", "••••4004", "$96K"]);
    expect(html).not.toContain("Plaid-linked account summaries");
    expect(plaidTable).toContain("Preview");
  });

  it("flag on lists live summaries with cash, securities, total and as-of", () => {
    const html = portrait([], {
      ext: [liveExt(), liveExt({
        externalAccountId: "ext-synthetic-2", inst: "Other Bank", type: "ira", num: "••••3333",
        balance: 0, cash: 0, securities: 0, holdingsTotal: 0, asOf: "2026-09-30T12:00:00.000Z",
        institutionBalance: 25,
      })],
      plaidLinked: true,
      plaidSummariesLive: true,
    });
    const rows = plaidRows(html, "Plaid-linked account summaries");
    expect(rows[0]).toEqual(["Institution", "Type", "Account #", "Cash", "Securities", "Total", "As-of"]);
    expect(rows[1]).toEqual(["Invented Bank", "brokerage", "••••2222", "$500.25", "$1,000.00", "$1,500.25", "2026-10-01"]);
    expect(rows[2]).toEqual(["Other Bank", "ira", "••••3333", "$0.00", "$0.00", "$0.00", "2026-09-30"]);
    expect(rows.at(-1)).toEqual(["External total", "$1,500.25", ""]);
    expect(html).toContain("2 linked · $1,500.25");
    expect(html).toContain("not included in AUM");
    expect(html).not.toContain("$1,499");
    expect(html.slice(html.indexOf("Plaid-connected accounts"))).not.toContain("sample data");
  });

  it("flag on sums rendered row totals when a holdings total is missing", () => {
    const html = portrait([], {
      ext: [liveExt(), liveExt({
        externalAccountId: "ext-synthetic-2", num: "••••3333",
        balance: 0, cash: null, securities: null, holdingsTotal: null, asOf: null,
        institutionBalance: 10,
      })],
      plaidLinked: true,
      plaidSummariesLive: true,
    });
    const rows = plaidRows(html, "Plaid-linked account summaries");
    expect(rows[2].slice(3)).toEqual(["—", "—", "—", "—"]);
    expect(rows.at(-1)).toEqual(["External total", "$1,500.25", ""]);
    expect(html).toContain("2 linked · $1,500.25");
    expect(html).toContain("not included in AUM");
    expect(html).not.toContain("total unavailable");
    expect(html).not.toContain("$1,510.00");
  });

  it("flag on keeps the rendered sum when an institution balance is missing", () => {
    const html = portrait([], {
      ext: [liveExt(), liveExt({
        externalAccountId: "ext-synthetic-2", num: "••••3333",
        balance: 500, cash: 500, securities: 0, holdingsTotal: 500, asOf: "2026-10-01T00:00:00.000Z",
        institutionBalance: null,
      })],
      plaidLinked: true,
      plaidSummariesLive: true,
    });
    const rows = plaidRows(html, "Plaid-linked account summaries");
    expect(rows.at(-1)).toEqual(["External total", "$2,000.25", ""]);
    expect(html).toContain("2 linked · $2,000.25");
  });

  it("flag on withholds the total only when no row renders a total", () => {
    const html = portrait([], {
      ext: [liveExt({
        cash: null, securities: null, holdingsTotal: null, balance: 0, institutionBalance: 40,
      })],
      plaidLinked: true,
      plaidSummariesLive: true,
    });
    const rows = plaidRows(html, "Plaid-linked account summaries");
    expect(rows.at(-1)).toEqual(["External total", "—", ""]);
    expect(html).toContain("1 linked · total unavailable");
  });

  it("header and external total equal the sum of rendered row totals", () => {
    const shown = [
      liveExt({ externalAccountId: "ext-shown-1", num: "••••5818", holdingsTotal: 100.25, cash: 100.25, securities: 0, institutionBalance: 1, balance: 100.25 }),
      liveExt({ externalAccountId: "ext-shown-2", num: "••••3359", holdingsTotal: 200.5, cash: 0, securities: 200.5, institutionBalance: 2, balance: 200.5 }),
      liveExt({ externalAccountId: "ext-shown-3", num: "••••6193", holdingsTotal: 300.75, cash: 300.75, securities: 0, institutionBalance: 3, balance: 300.75 }),
    ];
    const blank = [4, 5, 6].map((n) => liveExt({
      externalAccountId: `ext-blank-${n}`, num: `••••100${n}`,
      cash: null, securities: null, holdingsTotal: null, balance: 0,
      institutionBalance: 1_000, asOf: null,
    }));
    const html = portrait([], {
      ext: [...shown, ...blank],
      plaidLinked: true,
      plaidSummariesLive: true,
    });
    const rows = plaidRows(html, "Plaid-linked account summaries");
    const totalIndex = rows[0].indexOf("Total");
    const rendered = rows.slice(1, -1).map((row) => row[totalIndex]);
    const sum = Math.round(rendered.reduce((total, cell) => (
      cell === "—" ? total : total + Number(cell.replace(/[$,]/g, ""))
    ), 0) * 100) / 100;
    expect(rendered.filter((cell) => cell === "—")).toHaveLength(3);
    expect(rows.at(-1)?.[1]).toBe(usdCents(sum));
    expect(html).toContain(`6 linked · ${usdCents(sum)}`);
    expect(html).not.toContain("total unavailable");
    expect(usdCents(sum)).not.toBe(usdCents(1 + 2 + 3 + 1_000 * 3));
  });

  it("flag on with no visible summaries shows the not-linked empty state, not mock rows", () => {
    const html = portrait([], { ext: [], plaidLinked: false, plaidSummariesLive: true });
    expect(html).toContain("not linked");
    expect(html).toContain("No external accounts linked.");
    expect(html).not.toContain("Plaid-linked account summaries");
  });

  it("does not render a holdings preview control", () => {
    const html = portrait([], { ext: [liveExt()], plaidLinked: true, plaidSummariesLive: true });
    expect(html.toLowerCase()).not.toContain("preview holdings");
  });
});
