import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";

const SUITE = "acat-drawer-refinement-style";
const drawerCss = readFileSync("components/transfers/AcatUnlinkedDrawer.module.css", "utf8");
const reconCss = readFileSync("components/transfers/AcatSecurityRecon.module.css", "utf8");

/** The body of the first rule whose selector is exactly `selector`, outside any at-rule. */
function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start));
}

/** The inside of the `@media (<query>) { ... }` block, found by counting braces. */
function media(source: string, query: string): string {
  const start = source.indexOf(`@media (${query}) {`);
  expect(start, query).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf("{", start) + 1, i);
    }
  }
  throw new Error(`unclosed @media (${query})`);
}

describe("transfer drawer refinement styles", () => {
  it("tkt332 refine style: the migrated drawer panel widens from 1280px up and keeps the 560px panel below it", () => {
    expect(block(drawerCss, ".panel")).toContain("width: min(560px, 100%);");
    const large = media(drawerCss, "min-width: 1280px");
    expect(large).toContain('.overlay[aria-label="Transfer drawer"] .panel {');
    expect(large).toContain("width: clamp(560px, calc(100vw - 296px), 1320px);");
    // The wide rule exists only inside the large-screen query and only for the shell overlay.
    expect(drawerCss.split("calc(100vw - 296px)").length - 1).toBe(1);
    expect(drawerCss.replace(large, "")).not.toContain("100vw");
    markCase(SUITE, "tkt332 refine style: the migrated drawer panel widens from 1280px up and keeps the 560px panel below it");
  });

  it("tkt332 refine style: the recon grid relaxes its minimum width from 1280px up and keeps overflow protection", () => {
    expect(block(reconCss, ".scroll")).toContain("overflow-x: auto");
    expect(block(reconCss, ".table")).toContain("min-width: 1500px");
    const large = media(reconCss, "min-width: 1280px");
    expect(large).toMatch(/\.table \{ min-width: 0; \}/);
    expect(large).toMatch(/\.table th \{ padding: 10px 8px; \}/);
    expect(large).toMatch(/\.table td \{ padding: 12px 8px; \}/);
    expect(large).not.toMatch(/overflow/);
    markCase(SUITE, "tkt332 refine style: the recon grid relaxes its minimum width from 1280px up and keeps overflow protection");
  });
});
