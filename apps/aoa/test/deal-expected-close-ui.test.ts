import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpectedCloseDate } from "@/components/deals/ExpectedCloseDate";
import { DealRollup } from "@/components/client-portrait/DealRollup";
import { HouseholdDeals } from "@/components/households/HouseholdDeals";
import { DEAL_STAGES, summarizeHouseholdDeals, type DealRow, type DealStage } from "@/lib/data/deal-types";
import type { HouseholdDeal } from "@/lib/data/types";

const nativeDateLabel = Date.prototype.toLocaleDateString;
const source = (path: string) => readFileSync(path, "utf8");
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);

function deal(id: string, stage: DealStage, close: Date | null): DealRow {
  return {
    id, name: `Synthetic deal ${id}`, client_first_name: "Invented", client_last_name: id,
    stage, amount: 100, close_date: close, account_type: "IRA", transferring_firm: "Synthetic firm",
    client_sf_id: "synthetic-contact", person_aum: null,
  } as DealRow;
}

function renderCards(deals: DealRow[]) {
  return {
    household: renderToStaticMarkup(createElement(HouseholdDeals, {
      deals: deals as HouseholdDeal[], summary: summarizeHouseholdDeals(deals),
    })),
    portrait: renderToStaticMarkup(createElement(DealRollup, { deals })),
  };
}

function ambientDefaults(locale: string, timeZone: string) {
  vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (this: Date, locales, options) {
    return nativeDateLabel.call(this, locales ?? locale, { timeZone, ...options });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shared expected-close presentation", () => {
  it.each(DEAL_STAGES)("renders identical date/warning markup on both cards for %s", (stage) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T16:00:00Z"));
    for (const close of [date("2026-09-20"), date("2026-09-21"), date("2026-09-22"), null]) {
      const cards = renderCards([deal("one", stage, close)]);
      const expected = renderToStaticMarkup(createElement(ExpectedCloseDate, {
        date: close, stage, todayEt: "2026-09-21",
      }));
      for (const html of Object.values(cards)) {
        expect(html).toContain(expected);
        expect(html).toContain('href="/deals/one"');
        expect(html).not.toMatch(/<details[^>]*\sopen(?:[\s=>])/);
        expect(html.includes(" · Overdue")).toBe(
          close?.toISOString().startsWith("2026-09-20") === true && stage !== "WON" && stage !== "LOST",
        );
      }
      if (close == null) expect(expected).toBe("—");
    }
  });

  it("uses readable overdue text as well as red styling and a machine-readable date", () => {
    const html = renderToStaticMarkup(createElement(ExpectedCloseDate, {
      date: date("2026-09-20"), stage: "POTENTIAL", todayEt: "2026-09-21",
    }));
    expect(html).toContain("Sep 20, 2026");
    expect(html).toContain('dateTime="2026-09-20"');
    expect(html).toContain(" · Overdue");
    expect(html).not.toContain("aria-hidden");
    expect(html).toMatch(/class="[^"]*overdue[^"]*"/);
    const css = source("components/deals/ExpectedCloseDate.module.css");
    expect(css).toContain("color: var(--red)");
    expect(css).toContain(":global(html.dark) .overdue");
  });

  it("keeps card order, labels, links and rollups unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T16:00:00Z"));
    const rows = DEAL_STAGES.map((stage, index) => deal(String(index), stage, date("2026-09-20")));
    const cards = renderCards(rows);
    for (const html of Object.values(cards)) {
      expect(html.match(/ · Overdue/g)).toHaveLength(3);
      expect(html.match(/href="\/deals\/\d"/g))
        .toEqual(rows.map((row) => `href="/deals/${row.id}"`));
      expect(html).toContain('href="/deals"');
      expect(html).toContain("Potential-Committed");
      expect(html).toContain("Potential-In Process");
      expect(html).toContain("Funded");
      expect(html).toContain("Lost");
      expect(html).toContain("$300");
      expect(html).toContain("$100");
    }
    expect(cards.household).toContain("<strong>3</strong> outstanding");
    expect(cards.household).toContain("<strong>1</strong> funded");
    expect(cards.portrait).toContain("<strong>3</strong> outstanding");
    expect(cards.portrait).toContain("<strong>1</strong> funded");
    for (const html of Object.values(cards)) {
      expect([...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map(match => match[1])).toEqual([
        "Deal / Client", "Account type", "Transferring firm", "Stage", "Amount", "Exp. close",
      ]);
      expect(html.match(/<tbody\b/g)).toHaveLength(1);
    }
    // Share presentation without changing what identifies a row on either surface.
    expect(cards.portrait).toContain("Synthetic deal 0</a>");
    expect(cards.household).toContain("Invented 0</a>");
  });

  it("keeps missing account, firm and date values in their own table cells", () => {
    const row = { ...deal("missing", "POTENTIAL", null), account_type: null, transferring_firm: null };
    for (const html of Object.values(renderCards([row]))) {
      const body = html.match(/<tbody[^>]*>(.*?)<\/tbody>/)?.[1] ?? "";
      const cells = [...body.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map(match => match[1]);
      expect(cells).toHaveLength(6);
      expect(cells[1]).toBe("—");
      expect(cells[2]).toBe("—");
      expect(cells[5]).toBe("—");
      expect(html).not.toContain("Overdue");
    }
  });

  it.each([
    ["2026-09-21T03:59:59Z", false],
    ["2026-09-21T04:00:00Z", true],
  ])("classifies both cards with the same Eastern date at %s", (now, overdue) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    for (const html of Object.values(renderCards([deal("one", "FUNDING", date("2026-09-20"))]))) {
      expect(html.includes(" · Overdue")).toBe(overdue);
      expect(html).toContain("Sep 20, 2026");
    }
  });

  it.each([
    ["en-US", "America/New_York"],
    ["en-GB", "Europe/London"],
    ["de-DE", "Europe/Berlin"],
    ["ja-JP", "Asia/Tokyo"],
  ])("ignores %s / %s defaults when rendering both cards", (locale, timeZone) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T02:30:00Z"));
    const rows = [deal("one", "POTENTIAL", date("2026-09-20"))];
    ambientDefaults("en-US", "UTC");
    const server = renderCards(rows);
    vi.restoreAllMocks();
    ambientDefaults(locale, timeZone);
    expect(renderCards(rows)).toEqual(server);
    expect(server.household).not.toContain(" · Overdue");
  });

  it("retains the server date snapshot when a client boundary crosses Eastern midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T03:59:59Z"));
    const props = { date: date("2026-09-20"), stage: "COMMITTED" as const, todayEt: "2026-09-20" };
    const server = renderToStaticMarkup(createElement(ExpectedCloseDate, props));
    vi.setSystemTime(new Date("2026-09-21T04:00:01Z"));
    ambientDefaults("ja-JP", "Asia/Tokyo");
    expect(renderToStaticMarkup(createElement(ExpectedCloseDate, props))).toBe(server);
    expect(server).not.toContain(" · Overdue");
    // The current card wrappers stay server components, so hydration does not
    // rerun their clock. The shared presenter would also be safe with fixed props.
    for (const path of ["components/households/HouseholdDeals.tsx", "components/client-portrait/DealRollup.tsx", "components/deals/DealSummaryCard.tsx"]) {
      expect(source(path)).not.toMatch(/^\s*["']use client["']/);
    }
  });

  it("preserves empty-card copy without inventing dates or warnings", () => {
    const cards = renderCards([]);
    expect(cards.household).toContain("No deals linked to this household.");
    expect(cards.portrait).toContain("No deals on file.");
    for (const html of Object.values(cards)) {
      expect(html).not.toContain("<time");
      expect(html).not.toContain(" · Overdue");
    }
  });
});
