import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";

const SUITE = "acat-security-recon-style";
const css = readFileSync("components/transfers/AcatSecurityRecon.module.css", "utf8");
const globals = readFileSync("app/globals.css", "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing block ${selector}`);
  const open = css.indexOf("{", start);
  const end = css.indexOf("\n}", open);
  return css.slice(open + 1, end);
}

function tokens(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

// The tracker's values: src/app/globals.css lines 45-55, 74-85 (light) and
// 127-137, 156-167 (dark) of cedar-ridge-wealth/transfer-tracker.
const LIGHT: Record<string, string> = {
  "--recon-emerald-bg": "#ecfdf5", "--recon-emerald-fg": "#047857", "--recon-emerald-dot": "#10b981", "--recon-emerald-edge": "#a7f3d0",
  "--recon-amber-bg": "#fffbeb", "--recon-amber-fg": "#b45309", "--recon-amber-dot": "#f59e0b", "--recon-amber-edge": "#fde68a",
  "--recon-blue-bg": "#eff6ff", "--recon-blue-fg": "#1d4ed8", "--recon-blue-dot": "#3b82f6", "--recon-blue-edge": "#bfdbfe",
  "--recon-violet-bg": "#f5f3ff", "--recon-violet-fg": "#6d28d9", "--recon-violet-dot": "#8b5cf6", "--recon-violet-edge": "#ddd6fe",
  "--recon-success": "#2d8a5e", "--recon-warning": "#a17e2e", "--recon-danger": "#b83c3c", "--recon-danger-bg": "#fbecec",
};
const DARK: Record<string, string> = {
  "--recon-emerald-bg": "rgba(16, 185, 129, 0.16)", "--recon-emerald-fg": "#6ee7b7", "--recon-emerald-dot": "#34d399", "--recon-emerald-edge": "rgba(16, 185, 129, 0.35)",
  "--recon-amber-bg": "rgba(245, 158, 11, 0.16)", "--recon-amber-fg": "#fcd34d", "--recon-amber-dot": "#fbbf24", "--recon-amber-edge": "rgba(245, 158, 11, 0.35)",
  "--recon-blue-bg": "rgba(59, 130, 246, 0.16)", "--recon-blue-fg": "#93c5fd", "--recon-blue-dot": "#60a5fa", "--recon-blue-edge": "rgba(59, 130, 246, 0.35)",
  "--recon-violet-bg": "rgba(139, 92, 246, 0.16)", "--recon-violet-fg": "#c4b5fd", "--recon-violet-dot": "#a78bfa", "--recon-violet-edge": "rgba(139, 92, 246, 0.35)",
  "--recon-success": "#5fc08a", "--recon-warning": "#d4b15c", "--recon-danger": "#e07070", "--recon-danger-bg": "rgba(224, 112, 112, 0.14)",
};

describe("security recon styling", () => {
  it("tkt334 style: the tracker hue tokens equal the tracker values in light and dark", () => {
    const light = tokens(block(".section"));
    const dark = tokens(block(":global(html.dark) .section"));
    for (const [name, value] of Object.entries(LIGHT)) expect(light[name], `light ${name}`).toBe(value);
    for (const [name, value] of Object.entries(DARK)) expect(dark[name], `dark ${name}`).toBe(value);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(DARK).sort());
    expect(Object.keys(light).filter((k) => k.startsWith("--recon-")).sort()).toEqual(Object.keys(LIGHT).sort());
    markCase(SUITE, "tkt334 style: the tracker hue tokens equal the tracker values in light and dark");
  });

  it("tkt334 style: no literal color outside the declared hue and signal tokens", () => {
    const stripped = css
      .replace(block(".section"), "")
      .replace(block(":global(html.dark) .section"), "");
    expect(stripped.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|hwb\(|oklch\(/g) ?? []).toEqual([]);
    expect(css).toMatch(/#ecfdf5/);
    markCase(SUITE, "tkt334 style: no literal color outside the declared hue and signal tokens");
  });

  it("tkt334 style: neutral chrome uses only AoA tokens", () => {
    const aoa = ["--panel", "--bg", "--ink", "--ink-2", "--muted", "--faint", "--line", "--line-2", "--input-bg", "--green", "--green-2", "--green-soft", "--green-line", "--radius", "--radius-sm"];
    for (const name of aoa) expect(globals, name).toContain(`${name}:`);
    const declared = new Set([...Object.keys(LIGHT)]);
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
    for (const name of used) expect(aoa.includes(name) || declared.has(name), `unexpected token ${name}`).toBe(true);
    for (const name of ["--ink", "--line", "--panel", "--muted"]) expect(used.has(name), name).toBe(true);
    expect(css).not.toMatch(/var\(--(accent|bg-card|card-border|danger|success|warning)\b/);
    markCase(SUITE, "tkt334 style: neutral chrome uses only AoA tokens");
  });

  it("tkt334 style: the cards collapse to one column on narrow screens and the grid scrolls", () => {
    expect(block(".cards")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    const media = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(media.slice(0, media.indexOf("\n}\n") + 3)).toMatch(/\.cards \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(block(".scroll")).toContain("overflow-x: auto");
    expect(block(".table")).toContain("min-width: 1500px");
    markCase(SUITE, "tkt334 style: the cards collapse to one column on narrow screens and the grid scrolls");
  });
});
