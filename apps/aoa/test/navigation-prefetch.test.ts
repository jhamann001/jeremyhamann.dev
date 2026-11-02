import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/command-center",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    prefetch,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: boolean;
  }) =>
    React.createElement("a", {
      href,
      "data-prefetch": String(prefetch),
      ...props,
    }),
}));

vi.mock("@/app/(authenticated)/acat-count-action", () => ({
  getLiveAcatCount: vi.fn(),
}));

vi.mock("@/app/(authenticated)/nav-counts-action", () => ({
  getLiveNavCounts: vi.fn(),
}));

import { CrmExplorerLink } from "@/components/crm/CrmExplorerLink";
import { Sidebar } from "@/components/shell/Sidebar";

describe("database-backed navigation prefetch policy", () => {
  it("leaves enough scroll clearance below the final sidebar action", () => {
    const source = readFileSync("components/shell/Sidebar.module.css", "utf8");

    expect(source).toContain(
      "padding-bottom: calc(14px + 64px + env(safe-area-inset-bottom))",
    );
    expect(source).toContain(
      "scroll-padding-bottom: calc(14px + 64px + env(safe-area-inset-bottom))",
    );
  });

  it("disables speculative loading for every internal sidebar destination", () => {
    const html = renderToStaticMarkup(
      React.createElement(Sidebar, {
        role: "ADMIN",
        crmIdentityReads: true,
        crmRelationships: true,
        crmReporting: true,
        counts: {},
      }),
    );
    const internalLinks = [...html.matchAll(/<a\b[^>]*href="\/[^"]*"[^>]*>/g)].map(
      ([tag]) => tag,
    );

    expect(internalLinks.length).toBeGreaterThan(5);
    for (const link of internalLinks) {
      expect(link).toContain('data-prefetch="false"');
    }
  });

  it("makes every CRM Explorer link explicit-click only", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        CrmExplorerLink,
        { href: "/crm/hld_example" },
        "Inspect",
      ),
    );

    expect(html).toContain('href="/crm/hld_example"');
    expect(html).toContain('data-prefetch="false"');
  });

  it("uses the protected link wrapper throughout both Explorer pages", () => {
    for (const path of [
      "app/(authenticated)/crm/page.tsx",
      "app/(authenticated)/crm/[id]/page.tsx",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain('from "next/link"');
      expect(source).toContain("CrmExplorerLink");
    }
  });

  it("disables speculative loading for dense database-backed record lists", () => {
    for (const path of [
      "components/households/HouseholdsTable.tsx",
      "components/client-portrait/ClientsTable.tsx",
      "components/transfers/TransferCard.tsx",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("prefetch={false}");
    }
  });
});
