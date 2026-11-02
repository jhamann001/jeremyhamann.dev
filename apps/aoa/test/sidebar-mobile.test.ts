import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/client-portrait/SYNTHETIC" }));
vi.mock("@/components/shell/useSidebarCounts", () => ({
  useSidebarCounts: () => ({ value: undefined, status: "ready", retry: vi.fn() }),
  validNavCounts: vi.fn(), validAcatCount: vi.fn(),
}));

import { Sidebar } from "@/components/shell/Sidebar";

describe("mobile sidebar disclosure", () => {
  it("connects the collapsed menu button to the single shared navigation list", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { role: "OPERATIONS" }));
    const navigationId = html.match(/<nav id="([^"]+)" aria-label="Main navigation"/)?.[1];
    expect(navigationId).toBeTruthy();
    expect(html).toContain(`aria-expanded="false" aria-controls="${navigationId}"`);
    expect(html).toContain(">Menu</button>");
    expect(html.match(/href="\/client-portrait"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Main navigation"/g)).toHaveLength(1);
  });

  it("retains role and flag filtering in the shared mobile/desktop navigation", () => {
    const viewer = renderToStaticMarkup(createElement(Sidebar, { role: "VIEWER" }));
    expect(viewer).toContain('href="/client-portrait"');
    expect(viewer).not.toContain('href="/acat-tracking"');
    expect(viewer).not.toContain('href="/crm"');
    expect(viewer).not.toContain('href="/operations"');

    const operations = renderToStaticMarkup(createElement(Sidebar, {
      role: "OPERATIONS", crmIdentityReads: true, operationsTools: true,
    }));
    expect(operations).toContain('href="/acat-tracking"');
    expect(operations).toContain('href="/crm"');
    expect(operations).toContain('href="/operations"');
  });
});
