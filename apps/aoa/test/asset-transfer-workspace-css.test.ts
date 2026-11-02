import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.join(__dirname, "../components/asset-transfer/workspace/workspace.css"), "utf8");

describe("Asset Transfer workspace stylesheet", () => {
  it("scopes every rule to the workspace root or to the content area that holds a workspace page", () => {
    const unscoped: string[] = [];
    postcss.parse(css).walkRules(rule => {
      if (rule.parent?.type === "atrule" && /keyframes/.test((rule.parent as postcss.AtRule).name)) return;
      for (const selector of rule.selectors) {
        if (!/^\.atw(\s|$|[.:[,])/.test(selector) && !/^\[data-app-content\]:has\(\.atw-page\)/.test(selector)) unscoped.push(selector);
      }
    });
    expect(unscoped).toEqual([]);
  });

  it("leaves the AOA sidebar and topbar visible", () => {
    expect(css).not.toMatch(/\[data-app-(shell|main)\]/);
    expect(css).not.toMatch(/:has\(\.atw\)/);
  });

  it("drops the prototype-only demo and test-drawer chrome", () => {
    expect(css).not.toMatch(/\.demo\b|test-drawer/);
  });
});
