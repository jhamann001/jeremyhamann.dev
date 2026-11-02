import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TabPane, Tabs, type TabDef } from "@/components/ui";

const panelSegment = (html: string, id: string): string => {
  const marker = `-panel-${id}\" role=\"tabpanel\"`;
  const start = html.indexOf(marker);
  if (start < 0) return "";
  const next = html.indexOf('role="tabpanel"', start + marker.length);
  return html.slice(start, next < 0 ? undefined : next);
};

describe("Tabs", () => {
  it("binds dynamic panes by tab ID instead of child position", () => {
    const tabs: TabDef[] = [
      { id: "comms", label: "Communications" },
      { id: "financial", label: "Core Financial" },
      { id: "portrait", label: "Portrait" },
      { id: "relationships", label: "Relationships" },
      { id: "documents", label: "Documents" },
    ];

    // Deliberately provide panes out of tab order. The Client Portrait surface
    // uses this keyed contract so conditional prototypes cannot shift real
    // financial or portrait content into the wrong tab.
    const html = renderToStaticMarkup(
      React.createElement(
        Tabs,
        { tabs },
        React.createElement(TabPane, {
          tabId: "documents",
          children: React.createElement("p", null, "Documents marker"),
        }),
        React.createElement(TabPane, {
          tabId: "comms",
          children: React.createElement("p", null, "Communications marker"),
        }),
        React.createElement(TabPane, {
          tabId: "relationships",
          children: React.createElement("p", null, "Relationships marker"),
        }),
        React.createElement(TabPane, {
          tabId: "portrait",
          children: React.createElement("p", null, "Portrait marker"),
        }),
        React.createElement(TabPane, {
          tabId: "financial",
          children: React.createElement("p", null, "Core financial marker"),
        }),
      ),
    );

    expect(panelSegment(html, "comms")).toContain("Communications marker");
    expect(panelSegment(html, "financial")).toContain("Core financial marker");
    expect(panelSegment(html, "portrait")).toContain("Portrait marker");
    expect(panelSegment(html, "relationships")).toContain("Relationships marker");
    expect(panelSegment(html, "documents")).toContain("Documents marker");
    expect(panelSegment(html, "financial")).not.toContain("Portrait marker");
    expect(panelSegment(html, "relationships")).not.toContain("Core financial marker");
  });

  it("preserves positional children for existing fixed tab sets", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        Tabs,
        {
          tabs: [
            { id: "first", label: "First" },
            { id: "second", label: "Second" },
          ],
        },
        React.createElement("p", null, "First marker"),
        React.createElement("p", null, "Second marker"),
      ),
    );

    expect(panelSegment(html, "first")).toContain("First marker");
    expect(panelSegment(html, "second")).toContain("Second marker");
  });
});
