import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";

const SUITE = "acat-transfer-drawer-style";
const css = readFileSync("components/transfers/AcatTransferDrawer.module.css", "utf8");
const globals = readFileSync("app/globals.css", "utf8");
const feeCss = readFileSync("components/transfers/TransferFeeSection.module.css", "utf8");

const BOOK_SHEETS = [
  "components/transfers/AcatBookView.module.css",
  "components/transfers/AcatUnlinkedDrawer.module.css",
  "components/transfers/AcatBookActions.module.css",
  "components/ui/Pill.module.css",
].map((path) => readFileSync(path, "utf8"));

const LIGHT = {
  "--drawer-completed-bg": "#f0fdf4",
  "--drawer-completed-fg": "#15803d",
  "--drawer-completed-dot": "#22c55e",
  "--drawer-completed-edge": "#bbf7d0",
  "--drawer-rejected-bg": "#fef2f2",
  "--drawer-rejected-fg": "#b91c1c",
  "--drawer-rejected-dot": "#ef4444",
  "--drawer-rejected-edge": "#fecaca",
};
const DARK = {
  "--drawer-completed-bg": "rgba(34, 197, 94, 0.16)",
  "--drawer-completed-fg": "#86efac",
  "--drawer-completed-dot": "#4ade80",
  "--drawer-completed-edge": "rgba(34, 197, 94, 0.35)",
  "--drawer-rejected-bg": "rgba(239, 68, 68, 0.16)",
  "--drawer-rejected-fg": "#fca5a5",
  "--drawer-rejected-dot": "#f87171",
  "--drawer-rejected-edge": "rgba(239, 68, 68, 0.35)",
};

function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start));
}

function rules(source: string): { selector: string; body: string }[] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

const COLOR_PROPERTY = /^(color|background|background-color|border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|box-shadow)$/;

function colorVars(source: string): Set<string> {
  const names = new Set<string>();
  for (const { body } of rules(source)) {
    for (const declaration of body.split(";")) {
      const [property, ...rest] = declaration.split(":");
      if (!COLOR_PROPERTY.test(property.trim())) continue;
      for (const m of rest.join(":").matchAll(/var\((--[a-z0-9-]+)\)/g)) names.add(m[1]);
    }
  }
  return names;
}

describe("transfer drawer styles", () => {
  it("tkt332 style: Completed and Rejected use the tracker hues in both themes", () => {
    const light = block(css, ".shell");
    for (const [name, value] of Object.entries(LIGHT)) expect(light).toContain(`${name}: ${value};`);
    const dark = block(css, ":global(html.dark) .shell");
    for (const [name, value] of Object.entries(DARK)) expect(dark).toContain(`${name}: ${value};`);
    markCase(SUITE, "tkt332 style: Completed and Rejected use the tracker hues in both themes");
  });

  it("tkt332 style: every other colour is a token the book already uses", () => {
    const used = colorVars(css);
    const bookReferenced = new Set(BOOK_SHEETS.flatMap((sheet) => [...sheet.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1])));
    const rootBlock = block(globals, ":root");
    const darkBlock = block(globals, "html.dark");
    const others = [...used].filter((name) => !name.startsWith("--drawer-"));
    expect(others.length).toBeGreaterThan(8);
    for (const name of others) {
      expect(bookReferenced.has(name), `${name} is not used by the book stylesheets`).toBe(true);
      expect(rootBlock, name).toContain(`${name}:`);
      expect(darkBlock, name).toContain(`${name}:`);
    }
    const withoutHues = css.replace(/--drawer-[a-z-]+:[^;]+;/g, "").replace("rgba(20, 17, 12, 0.42)", "");
    expect(withoutHues).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutHues).not.toMatch(/rgba?\(/);
    markCase(SUITE, "tkt332 style: every other colour is a token the book already uses");
  });

  it("tkt332 style: only the status chip and Mark Complete consume the tracker hue tokens", () => {
    const consumers = rules(css)
      .filter(({ body }) => body.includes("var(--drawer-"))
      .map(({ selector }) => selector);
    expect(consumers.sort()).toEqual([
      ".markComplete",
      ".statusCompleted",
      ".statusCompleted::before",
      ".statusRejected",
      ".statusRejected::before",
    ].sort());
    markCase(SUITE, "tkt332 style: only the status chip and Mark Complete consume the tracker hue tokens");
  });
  it("tkt332 style: each drawer line is full width with its pencil pinned to the trailing edge", () => {
    const line = block(css, ".fieldButton");
    expect(line).toMatch(/display:\s*flex;/);
    expect(line).not.toMatch(/inline-flex/);
    expect(line).toMatch(/width:\s*100%;/);
    const pencil = block(css, ".fieldButton .pencil");
    expect(pencil).toMatch(/margin-left:\s*auto;/);
    expect(pencil).toMatch(/flex:\s*0 0 auto;/);
    expect(block(css, ".fieldBody")).toMatch(/flex:\s*1 1 calc\(100% - 162px\);/);
    expect(block(css, ".fieldRow > .suggestion, .fieldRow > .warn")).toMatch(/margin-left:\s*162px;/);
    const feePencil = block(feeCss, ".pencil");
    expect(feePencil).toMatch(/margin-left:\s*auto;/);
    expect(feePencil).toMatch(/flex-shrink:\s*0;/);
    markCase(SUITE, "tkt332 style: each drawer line is full width with its pencil pinned to the trailing edge");
  });
});
