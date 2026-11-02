import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  positionRelationshipItems,
  RelationshipGraph,
} from "@/components/crm/RelationshipGraph";

describe("live CRM relationship workspace", () => {
  it("renders named parent and child nodes with protected navigation", () => {
    const html = renderToStaticMarkup(
      React.createElement(RelationshipGraph, {
        rootIdentityId: "hld_example",
        totalNodeCount: 3,
        nodes: [
          { id: "hld_example", identityType: "HOUSEHOLD", label: "Example Household", href: "/households/001example", depth: 0, root: true },
          { id: "con_example", identityType: "CONTACT", label: "Example Client", href: "/client-portrait/003example", depth: 1, root: false },
          { id: "dea_example", identityType: "DEAL", label: "Example Deal", href: "/deals/example", depth: 1, root: false },
        ],
        edges: [
          { id: "rel_member", relationshipType: "HOUSEHOLD_HAS_MEMBER", parentId: "hld_example", childId: "con_example" },
          { id: "rel_deal", relationshipType: "DEAL_FOR_HOUSEHOLD", parentId: "hld_example", childId: "dea_example" },
        ],
      }),
    );

    expect(html).toContain("Parent and child map");
    expect(html).toContain("Example Household");
    expect(html).toContain("Example Client");
    expect(html).toContain("Example Deal");
    expect(html).toContain("Child node");
    expect(html).toContain('href="/crm/hld_example"');
    expect(html).toContain('href="/households/001example"');
    expect(html).not.toContain("Synthetic");
    expect(html).not.toContain("CRM Contact · demo");
  });

  it("groups dense record types and exposes expanded-map controls", () => {
    const dealNodes = Array.from({ length: 7 }, (_, index) => ({
      id: `dea_${index}`,
      identityType: "DEAL",
      label: `Example Deal ${index + 1}`,
      href: `/deals/${index}`,
      depth: 1,
      root: false,
    }));
    const html = renderToStaticMarkup(
      React.createElement(RelationshipGraph, {
        rootIdentityId: "hld_example",
        totalNodeCount: 8,
        nodes: [
          { id: "hld_example", identityType: "HOUSEHOLD", label: "Example Household", href: "/households/001example", depth: 0, root: true },
          ...dealNodes,
        ],
        edges: dealNodes.map((node, index) => ({
          id: `rel_deal_${index}`,
          relationshipType: "DEAL_FOR_HOUSEHOLD",
          parentId: "hld_example",
          childId: node.id,
        })),
      }),
    );

    expect(html).toContain("Expand map");
    expect(html).toContain("Record groups");
    expect(html).toContain("Expand 7 deals");
    expect(html).toContain("7 deals");
    expect(html).toContain("Select to expand");
    expect(html).not.toContain('title="Example Deal 1"');
  });

  it("uses additional rows instead of widening a dense expanded group indefinitely", () => {
    const nodes = [
      { id: "hld_example", identityType: "HOUSEHOLD", label: "Example Household", href: null, depth: 0, root: true },
      ...Array.from({ length: 11 }, (_, index) => ({
        id: `dea_${index}`,
        identityType: "DEAL",
        label: `Deal ${index + 1}`,
        href: null,
        depth: 1,
        root: false,
      })),
    ];

    const collapsed = positionRelationshipItems(nodes, new Set());
    expect(collapsed.items).toHaveLength(2);
    expect(collapsed.collapsedTypes.get("DEAL")).toBe(11);

    const expanded = positionRelationshipItems(nodes, new Set(["DEAL"]));
    expect(expanded.items).toHaveLength(12);
    expect(expanded.rowCount).toBe(4);
    expect(expanded.widestRow).toBe(5);
  });

  it("wires the Client Portrait tab to the current client CRM ID", () => {
    const source = readFileSync("app/(authenticated)/client-portrait/[id]/page.tsx", "utf8");
    expect(source).toContain("crmRelationshipsEnabled()");
    expect(source).toContain("canReadCrmRelationships(identity.role)");
    expect(source).toContain("LazyRelationshipWorkspace");
    expect(source).toContain("rootIdentityId={crmId}");
    expect(source).not.toContain("<RelationshipWorkspace");
    expect(source).not.toContain("crmRelationshipsPreviewEnabled");
  });

  it("defers the Client Portrait relationship query until its hidden tab is opened", () => {
    const source = readFileSync("components/crm/LazyRelationshipWorkspace.tsx", "utf8");
    expect(source).toContain("IntersectionObserver");
    expect(source).toContain("/api/crm/relationships?root=");
    expect(source).toContain('cache: "no-store"');
    expect(source).toContain('credentials: "same-origin"');
  });
});
