import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("Phase 1 deal navigation and details", () => {
  it("uses durable full-page deal links from every deal surface", () => {
    const table = source("components/deals/DealsTable.tsx");
    const household = source("components/households/HouseholdDeals.tsx");
    const portrait = source("components/client-portrait/DealRollup.tsx");
    const shared = source("components/deals/DealSummaryCard.tsx");

    expect(table).toContain("router.push(`/deals/${id}`)");
    expect(household).toContain("<DealSummaryCard");
    expect(portrait).toContain("<DealSummaryCard");
    expect(shared).toContain("href={`/deals/${deal.id}`}");
    expect(shared).toContain('href="/deals"');
  });

  it("labels account type explicitly in tables, forms, and details", () => {
    const table = source("components/deals/DealsTable.tsx");
    const detail = source("components/deals/DealDetail.tsx");
    const form = source("components/deals/DealForm.tsx");
    const shared = source("components/deals/DealSummaryCard.tsx");

    for (const file of [table, detail, form, shared]) {
      expect(file).toContain("Account type");
    }
    expect(detail).not.toContain('{ label: "Funding type"');
    expect(form).not.toContain('className={styles.label}>Funding type');
  });

  it("keeps disclosures in place and scrolls long detail content", () => {
    const cardCss = source("components/deals/DealSummaryCard.module.css");

    expect(cardCss).not.toContain(
      ".dealsCard[open] { grid-column: 1 / -1; }",
    );
    expect(cardCss).toContain("max-height: 420px");
    expect(cardCss).toContain("overflow: auto");
  });
});
