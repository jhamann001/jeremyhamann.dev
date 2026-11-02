import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STATUS_TONES } from "@/components/ui";

const GLOBALS = readFileSync("app/globals.css", "utf8");
const STYLESHEETS = [
  "components/asset-mapping/workspace/AssetMappingWorkspace.module.css",
  "components/asset-mapping/workspace/client-linking/ClientLinking.module.css",
  "components/ui/Pill.module.css",
  "components/ui/StatTile.module.css",
];

function block(selector: string): Record<string, string> {
  const start = GLOBALS.indexOf(`${selector} {`);
  const body = GLOBALS.slice(start, GLOBALS.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = { light: block(":root"), dark: block("html.dark") };

describe("asset-mapping status tokens", () => {
  it("defines a hex foreground and background for every status tone in light and dark", () => {
    for (const vars of Object.values(THEMES)) {
      for (const tone of STATUS_TONES) {
        expect(vars[`--status-${tone}`]).toMatch(/^#[0-9a-f]{6}$/);
        expect(vars[`--status-${tone}-bg`]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    expect(STATUS_TONES).toHaveLength(8);
  });

  it("every status foreground is at least 4.5:1 against its own background, the panel, and the page in both themes", () => {
    const failures: string[] = [];
    let pairs = 0;
    for (const [theme, vars] of Object.entries(THEMES)) {
      for (const tone of STATUS_TONES) {
        const fg = vars[`--status-${tone}`];
        for (const bgName of [`--status-${tone}-bg`, "--panel", "--bg"]) {
          pairs++;
          const ratio = contrast(fg, vars[bgName]);
          if (ratio < 4.5) failures.push(`${theme} ${tone} on ${bgName}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(pairs).toBe(48);
  });

  it("the asset-mapping stylesheets reference only CSS variables defined in globals", () => {
    const defined = new Set([...Object.keys(THEMES.light), ...Object.keys(THEMES.dark)]);
    const undefinedRefs = STYLESHEETS.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]).filter((v) => !defined.has(v)).map((v) => `${path}: ${v}`),
    );
    expect(undefinedRefs).toEqual([]);
  });
});
