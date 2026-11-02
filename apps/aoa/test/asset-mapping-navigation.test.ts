import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/command-center" }));
vi.mock("@/components/shell/useSidebarCounts", () => ({
  useSidebarCounts: () => ({ value: undefined, status: "ready", retry: vi.fn() }),
  validNavCounts: vi.fn(), validAcatCount: vi.fn(),
}));

import { NAV_GROUPS, resolveNavItem } from "@/components/shell/nav-config";
import { Sidebar } from "@/components/shell/Sidebar";
import { EXTERNAL_APPS } from "@/lib/external-apps";

const items = NAV_GROUPS.flatMap((group) => group.items);
const assetMapping = items.find((item) => item.label === "Asset Mapping")!;
const ROLES = ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE", "VIEWER"];
const EXTERNAL_LINK = `href="${EXTERNAL_APPS.assetMapping}" target="_blank"`;

const VIEW_ROLES = ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE"];

describe("Asset Mapping navigation release switch (ticket, roles per ticket)", () => {
  it("opens the external app for every asset-mapping role while the epic release is off", () => {
    for (const role of VIEW_ROLES) {
      expect(resolveNavItem(assetMapping, { assetMappingWorkspace: false, role }))
        .toMatchObject({ href: EXTERNAL_APPS.assetMapping, external: true });
    }
  });

  it("opens the in-app address for Admin, Operations, Advisor and Client Service while the epic release is on", () => {
    for (const role of VIEW_ROLES) {
      expect(resolveNavItem(assetMapping, { assetMappingWorkspace: true, role }))
        .toMatchObject({ href: "/asset-mapping", external: false });
    }
  });

  it("gives Viewer and unknown roles no Asset Mapping entry in either release state", () => {
    for (const role of ["VIEWER", "HEAD_OF_ADVISORY", ""]) {
      for (const assetMappingWorkspace of [false, true]) {
        expect(resolveNavItem(assetMapping, { assetMappingWorkspace, role })).toBeNull();
      }
    }
    expect(ROLES.filter((role) => !VIEW_ROLES.includes(role))).toEqual(["VIEWER"]);
  });

  it("renders no Asset Mapping link for Viewer, internal or external", () => {
    for (const assetMappingWorkspace of [false, true]) {
      const html = renderToStaticMarkup(createElement(Sidebar, { role: "VIEWER", assetMappingWorkspace }));
      expect(html).not.toContain("Asset Mapping");
      expect(html).not.toContain(EXTERNAL_APPS.assetMapping);
      expect(html).not.toContain('href="/asset-mapping"');
      expect(html).toContain("Main navigation");
    }
  });

  it("renders the in-app link for Advisor and Client Service while the release is on", () => {
    for (const role of ["ADVISOR", "CLIENT_SERVICE"]) {
      const html = renderToStaticMarkup(createElement(Sidebar, { role, assetMappingWorkspace: true }));
      expect(html).toContain('href="/asset-mapping"');
      expect(html).not.toContain(EXTERNAL_APPS.assetMapping);
    }
  });

  it("leaves every other navigation entry unchanged while the epic release is on", () => {
    for (const item of items.filter((entry) => entry !== assetMapping)) {
      expect(resolveNavItem(item, { assetMappingWorkspace: true, role: "OPERATIONS" })).toBe(item);
    }
  });

  it("renders the external new-tab link in the sidebar while the release is off", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { role: "OPERATIONS" }));
    expect(html).toContain(EXTERNAL_LINK);
    expect(html).not.toContain('href="/asset-mapping"');
  });

  it("renders the in-app link in the sidebar while the release is on", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { role: "OPERATIONS", assetMappingWorkspace: true }));
    expect(html).toContain('href="/asset-mapping"');
    expect(html).not.toContain(EXTERNAL_APPS.assetMapping);
  });

  it("reads the epic release flag, not the read slice flag, in the layout", () => {
    const layout = readFileSync("app/(authenticated)/layout.tsx", "utf8");
    expect(layout).toContain("assetMappingWorkspace={assetMappingWorkspaceEnabled()}");
    expect(layout).not.toContain("assetMappingReadEnabled");
  });
});
