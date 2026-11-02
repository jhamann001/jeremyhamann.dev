// The asset-transfer workspace stays light in dark mode (components/asset-transfer/workspace/workspace-dark.css).
// The companion copies the app's light tokens from globals.css and the workspace's own colours from workspace.css,
// so these tests fail if either source changes without the copy, or if a page loads the workspace without it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(rel, "utf8");
const block = (css: string, selector: string) => {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};
const tokens = (css: string) =>
  new Map([...css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)].map((m) => [m[1], m[2].trim()] as const));

const globals = read("app/globals.css");
const light = tokens(block(globals, ":root {"));
const dark = tokens(block(globals, "html.dark {"));
const workspace = tokens(block(read("components/asset-transfer/workspace/workspace.css"), ".atw{"));
const companion = tokens(block(read("components/asset-transfer/workspace/workspace-dark.css"), "html.dark body .atw {"));
const changedInDark = [...dark.keys()].filter((k) => light.has(k) && light.get(k) !== dark.get(k));

describe("the asset-transfer workspace in dark mode", () => {
  it("sets the app's light value inside the workspace for every token dark mode changes", () => {
    const expected = changedInDark.filter((k) => !workspace.has(k));
    expect(expected.length).toBeGreaterThan(50);
    for (const k of expected) expect(companion.get(k), k).toBe(light.get(k));
  });

  it("puts back the workspace's own value where it and the app name the same token", () => {
    const shared = changedInDark.filter((k) => workspace.has(k));
    expect(shared.sort()).toEqual(["--green", "--ink", "--line", "--muted", "--red"]);
    for (const k of shared) expect(companion.get(k), k).toBe(workspace.get(k));
  });

  it("sets nothing else", () => {
    const allowed = new Set(changedInDark);
    expect([...companion.keys()].filter((k) => !allowed.has(k))).toEqual([]);
  });

  it("is loaded wherever the workspace stylesheet is", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const rel = path.join(dir, name);
        if (statSync(rel).isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(name)) files.push(rel);
      }
    };
    walk("app");
    walk("components");
    const importers = files.filter((f) => /workspace\/workspace\.css["']|["']\.\/workspace\.css["']/.test(read(f)));
    expect(importers.length).toBeGreaterThan(0);
    for (const f of importers) expect(read(f), f).toMatch(/workspace-dark\.css["']/);
  });
});
