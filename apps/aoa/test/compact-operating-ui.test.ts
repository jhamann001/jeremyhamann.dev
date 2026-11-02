import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageHeader, StatTile, SummaryGrid } from "@/components/ui";

const source = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("compact operating-page UI", () => {
  it("renders one shared page heading pattern with optional actions", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        eyebrow: "Admin · operations",
        title: "Data health",
        description: "Current source evidence.",
        actions: createElement("button", null, "Review"),
      }),
    );

    expect(html).toContain("Admin · operations");
    expect(html).toContain("<h1>Data health</h1>");
    expect(html).toContain("Current source evidence.");
    expect(html).toContain("<button>Review</button>");
  });

  it("keeps summary context inside compact reusable tiles", () => {
    const html = renderToStaticMarkup(
      createElement(
        SummaryGrid,
        null,
        createElement(StatTile, {
          label: "Total AUM",
          value: "$1,500,000",
          caption: "Client $1,450,000 · Firm $50,000",
        }),
      ),
    );

    expect(html).toContain("Total AUM");
    expect(html).toContain("$1,500,000");
    expect(html).toContain("Client $1,450,000 · Firm $50,000");
  });

  it("uses the shared header across the primary operating pages", () => {
    for (const path of [
      "app/(household-directory)/households/page.tsx",
      "app/(authenticated)/client-portrait/page.tsx",
      "app/(authenticated)/reporting/page.tsx",
      "app/(authenticated)/crm/page.tsx",
      "app/(authenticated)/data-health/page.tsx",
    ]) {
      expect(source(path)).toContain("<PageHeader");
    }
  });

  it("gives both client directories a compact reset control", () => {
    const households = source("components/households/HouseholdsTable.tsx");
    const clients = source("components/client-portrait/ClientsTable.tsx");

    expect(households).toContain("Clear filters");
    expect(clients).toContain("Clear filters");
    expect(clients).toContain("navigate(DEFAULT_FILTERS)");
  });
});
