import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";

const SUITE = "acat-paperwork-style";
const css = readFileSync("components/transfers/AcatPaperworkSection.module.css", "utf8");
const globals = readFileSync("app/globals.css", "utf8");

const BOOK_SHEETS = [
  "components/transfers/AcatBookView.module.css",
  "components/transfers/AcatUnlinkedDrawer.module.css",
  "components/transfers/AcatBookActions.module.css",
  "components/transfers/AcatTransferDrawer.module.css",
  "components/ui/Pill.module.css",
].map((path) => readFileSync(path, "utf8"));

// The tracker's status hues (transfer-tracker src/app/globals.css).
const LIGHT = {
  "--paperwork-success": "#2d8a5e",
  "--paperwork-success-bg": "#eaf5ef",
  "--paperwork-success-edge": "#c7e3d3",
  "--paperwork-warning": "#a17e2e",
  "--paperwork-warning-bg": "#faf3e0",
  "--paperwork-warning-edge": "#ebdcb1",
  "--paperwork-danger": "#b83c3c",
  "--paperwork-danger-bg": "#fbecec",
  "--paperwork-danger-edge": "#eec7c7",
};
const DARK = {
  "--paperwork-success": "#5fc08a",
  "--paperwork-success-bg": "rgba(95, 192, 138, 0.12)",
  "--paperwork-success-edge": "rgba(95, 192, 138, 0.3)",
  "--paperwork-warning": "#d4b15c",
  "--paperwork-warning-bg": "rgba(212, 177, 92, 0.12)",
  "--paperwork-warning-edge": "rgba(212, 177, 92, 0.3)",
  "--paperwork-danger": "#e07070",
  "--paperwork-danger-bg": "rgba(224, 112, 112, 0.14)",
  "--paperwork-danger-edge": "rgba(224, 112, 112, 0.32)",
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

describe("paperwork section styles", () => {
  it("tkt335 style: the status hues equal the tracker values in both themes", () => {
    const light = block(css, ".root");
    for (const [name, value] of Object.entries(LIGHT)) expect(light).toContain(`${name}: ${value};`);
    const dark = block(css, ":global(html.dark) .root");
    for (const [name, value] of Object.entries(DARK)) expect(dark).toContain(`${name}: ${value};`);
    markCase(SUITE, "tkt335 style: the status hues equal the tracker values in both themes");
  });

  it("tkt335 style: every other colour is a token the book already uses", () => {
    const used = colorVars(css);
    const bookReferenced = new Set(BOOK_SHEETS.flatMap((sheet) => [...sheet.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1])));
    const rootBlock = block(globals, ":root");
    const darkBlock = block(globals, "html.dark");
    const others = [...used].filter((name) => !name.startsWith("--paperwork-"));
    expect(others.length).toBeGreaterThan(8);
    for (const name of others) {
      expect(bookReferenced.has(name), `${name} is not used by the book stylesheets`).toBe(true);
      expect(rootBlock, name).toContain(`${name}:`);
      expect(darkBlock, name).toContain(`${name}:`);
    }
    markCase(SUITE, "tkt335 style: every other colour is a token the book already uses");
  });

  it("tkt335 style: only status selectors consume the paperwork hue tokens", () => {
    const consumers = rules(css)
      .filter(({ selector, body }) => body.includes("var(--paperwork-") && !selector.endsWith(".root"))
      .map(({ selector }) => selector)
      .sort();
    expect(consumers).toEqual([
      ".badgeReview",
      ".countsOk",
      ".countsWarn",
      ".errorText",
      ".notice",
      ".noticeDanger",
      ".noticeWarn",
      ".saved",
      ".undecided td:last-child",
    ].sort());
    markCase(SUITE, "tkt335 style: only status selectors consume the paperwork hue tokens");
  });

  it("tkt335 style: no literal colour appears outside the hue declarations", () => {
    const withoutHues = css.replace(/--paperwork-[a-z-]+:[^;]+;/g, "");
    expect(withoutHues).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutHues).not.toMatch(/rgba?\(/);
    expect(withoutHues).not.toMatch(/\b(?:white|black|red|green|blue|gray|grey)\b\s*[;}]/);
    markCase(SUITE, "tkt335 style: no literal colour appears outside the hue declarations");
  });
});
