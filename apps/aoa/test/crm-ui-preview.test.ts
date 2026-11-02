import { describe, expect, it } from "vitest";
import { NAV_GROUPS } from "@/components/shell/nav-config";
import {
  CRM_PREVIEW_DOCUMENTS,
  CRM_PREVIEW_HOUSEHOLDS,
} from "@/lib/mock/crm-ui";

describe("CRM UI synthetic fixtures", () => {
  it("uses unmistakably synthetic entity IDs and labels", () => {
    for (const household of CRM_PREVIEW_HOUSEHOLDS) {
      expect(household.id).toContain("_demo_");
      expect(household.name).toContain("Demo");
      for (const node of household.nodes) expect(node.id).toContain("_demo_");
      for (const edge of household.edges) expect(edge.id).toContain("_demo_");
    }

    for (const document of CRM_PREVIEW_DOCUMENTS) {
      expect(document.id).toContain("_demo_");
      expect(document.name).toContain("Demo");
    }
  });

  it("keeps every relationship edge within its selected household graph", () => {
    for (const household of CRM_PREVIEW_HOUSEHOLDS) {
      const nodeIds = new Set(household.nodes.map((node) => node.id));
      for (const edge of household.edges) {
        expect(nodeIds.has(edge.from)).toBe(true);
        expect(nodeIds.has(edge.to)).toBe(true);
      }
    }
  });
});

describe("CRM UI navigation gates", () => {
  const items = NAV_GROUPS.flatMap((group) => group.items);

  it("keeps Relationships behind its dev-preview and operations role gates", () => {
    const item = items.find((entry) => entry.href === "/relationships");
    expect(item?.requiresCrmRelationships).toBe(true);
    expect(item?.requiredRoles).toEqual(["ADMIN", "OPERATIONS"]);
  });

  it("keeps live Reporting behind its independent flag and operations role gates", () => {
    const item = items.find((entry) => entry.href === "/reporting");
    expect(item?.requiresCrmReporting).toBe(true);
    expect(item?.requiredRoles).toEqual(["ADMIN", "OPERATIONS"]);
  });
});
