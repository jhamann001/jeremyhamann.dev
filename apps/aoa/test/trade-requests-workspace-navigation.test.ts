import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/command-center" }));
vi.mock("@/components/shell/useSidebarCounts", () => ({
  useSidebarCounts: () => ({ value: undefined, status: "ready", retry: vi.fn() }),
  validNavCounts: vi.fn(), validAcatCount: vi.fn(),
}));

import { NAV_GROUPS, resolveNavItem } from "@/components/shell/nav-config";
import { Sidebar } from "@/components/shell/Sidebar";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import { tradeRequestsWorkspaceEnabled } from "@/lib/flags";
import { canUseTradeRequestsWorkspace } from "@/lib/trade-requests/access";

const items = NAV_GROUPS.flatMap((group) => group.items);
const tradeRequests = items.find((item) => item.label === "Trade Requests")!;
const ROLES = ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"];
const WORKSPACE_ROLES = ["ADMIN", "OPERATIONS", "ADVISOR"];
const EXTERNAL_LINK = `href="${EXTERNAL_APPS.tradeRequests}" target="_blank"`;

function sidebar(role: string, tradeRequestsWorkspace?: boolean) {
  return renderToStaticMarkup(createElement(Sidebar, { role, tradeRequestsWorkspace }));
}

function tradeRequestsAnchor(html: string): string {
  const index = html.indexOf('href="/trade-requests"');
  expect(index).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<a", index), html.indexOf(">", index) + 1);
}

afterEach(() => vi.unstubAllEnvs());

describe("Trade Requests navigation release switch (ticket)", () => {
  it("epic flag is on only for the exact string 1", () => {
    for (const value of [undefined, "", "0", "true", "1 ", "yes"]) {
      vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", value);
      expect(tradeRequestsWorkspaceEnabled()).toBe(false);
    }
    vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", "1");
    expect(tradeRequestsWorkspaceEnabled()).toBe(true);
  });

  it("flag off keeps today's external Trade Requests link for every role", () => {
    for (const role of ROLES) {
      const off = resolveNavItem(tradeRequests, { assetMappingWorkspace: false, tradeRequestsWorkspace: false, role });
      expect(off).toBe(tradeRequests);
      expect(off).toMatchObject({ href: EXTERNAL_APPS.tradeRequests, external: true });
      expect(resolveNavItem(tradeRequests, { assetMappingWorkspace: true, role })).toBe(tradeRequests);
    }
  });

  it("flag on opens /trade-requests in the shell for ADMIN, OPERATIONS and ADVISOR", () => {
    for (const role of WORKSPACE_ROLES) {
      expect(resolveNavItem(tradeRequests, { assetMappingWorkspace: false, tradeRequestsWorkspace: true, role }))
        .toMatchObject({ href: "/trade-requests", external: false });
    }
  });

  it("flag on gives CLIENT_SERVICE, VIEWER, HEAD_OF_ADVISORY and unknown roles no Trade Requests entry", () => {
    for (const role of ["CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY", "", "SOMETHING_ELSE", "advisor"]) {
      expect(resolveNavItem(tradeRequests, { assetMappingWorkspace: false, tradeRequestsWorkspace: true, role })).toBeNull();
      expect(canUseTradeRequestsWorkspace(role)).toBe(false);
    }
    expect(WORKSPACE_ROLES.every((role) => canUseTradeRequestsWorkspace(role))).toBe(true);
    expect(canUseTradeRequestsWorkspace(null)).toBe(false);
    expect(canUseTradeRequestsWorkspace(undefined)).toBe(false);
  });

  it("flag on leaves every other navigation entry unchanged", () => {
    for (const item of items.filter((entry) => entry !== tradeRequests)) {
      for (const role of ROLES) {
        expect(resolveNavItem(item, { assetMappingWorkspace: false, tradeRequestsWorkspace: true, role }))
          .toEqual(resolveNavItem(item, { assetMappingWorkspace: false, role }));
      }
    }
  });

  it("sidebar renders the external new-tab link for every role while the flag is off", () => {
    for (const role of ROLES) {
      const html = sidebar(role);
      expect(html).toContain(EXTERNAL_LINK);
      expect(html).not.toContain('href="/trade-requests"');
    }
  });

  it("sidebar renders the in-app link without the new-tab marker for workspace roles while the flag is on", () => {
    for (const role of WORKSPACE_ROLES) {
      const html = sidebar(role, true);
      expect(html).toContain('href="/trade-requests"');
      expect(html).not.toContain(EXTERNAL_APPS.tradeRequests);
      expect(tradeRequestsAnchor(html)).not.toContain("target=");
    }
  });

  it("sidebar renders no Trade Requests link for CLIENT_SERVICE and VIEWER while the flag is on", () => {
    for (const role of ["CLIENT_SERVICE", "VIEWER"]) {
      const html = sidebar(role, true);
      expect(html).toContain("Main navigation");
      expect(html).toContain("Deals");
      expect(html).not.toContain("Trade Requests");
      expect(html).not.toContain(EXTERNAL_APPS.tradeRequests);
      expect(html).not.toContain('href="/trade-requests"');
    }
  });

  it("the in-app entry sits inside the navigation the mobile Menu button controls", () => {
    const html = sidebar("ADVISOR", true);
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(controls).toBeTruthy();
    const navStart = html.indexOf(`<nav id="${controls}"`);
    expect(navStart).toBeGreaterThan(-1);
    const nav = html.slice(navStart, html.indexOf("</nav>", navStart));
    expect(nav).toContain('href="/trade-requests"');
  });

  it("the shell layout passes the epic flag to the sidebar", () => {
    const layout = readFileSync("app/(authenticated)/layout.tsx", "utf8");
    expect(layout).toContain("tradeRequestsWorkspace={tradeRequestsWorkspaceEnabled()}");
  });
});
