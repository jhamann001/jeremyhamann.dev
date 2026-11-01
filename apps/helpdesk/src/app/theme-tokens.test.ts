/**
 * Source guard for the colour tokens in `src/app/globals.css`.
 *
 * The repo has no DOM test environment, so — in the shape `reports-surface-probe.test.ts` established —
 * the property a rendered page would show is asserted against the SOURCE. Here the source is CSS, and
 * the property is a contrast ratio, so this file parses the `oklch()` declarations out of the stylesheet
 * and re-derives every ratio rather than trusting the numbers written in the comment beside them.
 *
 * Why it exists: the shadcn starter ships `--chart-1 … --chart-5` as five achromatic greys and ships the
 * same five bytes in `:root` and in `.dark`. `report-chart.tsx` draws a third series in `--chart-3`
 * (`sla-attainment` is a three-series line chart in one unit), and on the stock ramp that stroke measured
 * 2.30:1 against `--card` in dark mode — under the 3:1 WCAG 1.4.11 floor for non-text graphics, on a
 * chart that is `h-40` at 360 px where the stroke colour is the only thing telling the series apart.
 * A comment claiming a token "flips with the theme" is not a test; this is.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS = readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");

/** WCAG 1.4.11 floor for a non-text graphic that carries meaning. */
const GRAPHIC_CONTRAST_FLOOR = 3;

/** The five slots `toneClasses` may reach, in the order it reaches them. */
const CHART_TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"] as const;

/** Surfaces a chart mark is painted on: the chart card, the page, and the `ReportRankChart` bar track. */
const SURFACES = ["--card", "--background", "--muted"] as const;

type Oklch = { L: number; C: number; h: number };

/**
 * The LAST declaration of `name` inside a block whose selector is exactly `selector`. Last wins: this
 * file redefines the starter's `:root` / `.dark` chart ramp in a later block of the same specificity,
 * which is the whole mechanism, so a parser that took the first hit would read the stale values.
 */
function readToken(selector: ":root" | ".dark", name: string): Oklch {
  const blocks = [...CSS.matchAll(/(^|\n)([^\n{}]+)\{([^{}]*)\}/g)].filter(
    (m) => m[2].trim() === selector,
  );
  let found: Oklch | undefined;
  for (const block of blocks) {
    // The pattern is a LITERAL that captures the PROPERTY NAME, and the name is compared as a string
    // afterwards. Interpolating `name` into `new RegExp(...)` was two security scanner findings on this one line —
    // CWE-185 (a pattern built from a variable) and CWE-1333
    // (the unbounded `+` runs) — and the build record asks for
    // exactly this shape. The quantifiers are bounded, so the scan is linear by construction; the
    // bounds are far above anything a colour declaration can hold.
    const decl = [
      ...block[3].matchAll(
        /(--[a-z0-9-]{1,60}):\s{0,40}oklch\(\s{0,40}([\d.]{1,24})\s{1,40}([\d.]{1,24})\s{1,40}([\d.]{1,24})\s{0,40}\)/g,
      ),
    ]
      .filter((m) => m[1] === name)
      .at(-1);
    if (decl) found = { L: Number(decl[2]), C: Number(decl[3]), h: Number(decl[4]) };
  }
  if (!found) throw new Error(`no plain oklch() declaration of ${name} in a bare "${selector}" block`);
  return found;
}

/** Oklab -> linear sRGB (Björn Ottosson's matrices, the same ones a browser uses). */
function linearSrgb({ L, C, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Linear sRGB is already light-linear, so it IS the WCAG relative luminance basis. */
function luminance(colour: Oklch): number {
  const [r, g, b] = linearSrgb(colour).map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Oklch, b: Oklch): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** True when every channel lands inside sRGB, i.e. the browser paints the declared colour unmapped. */
function inSrgbGamut(colour: Oklch): boolean {
  return linearSrgb(colour).every((v) => v >= -0.0005 && v <= 1.0005);
}

describe("chart tokens", () => {
  for (const theme of [":root", ".dark"] as const) {
    describe(theme === ":root" ? "light" : "dark", () => {
      for (const token of CHART_TOKENS) {
        it(`${token} clears ${GRAPHIC_CONTRAST_FLOOR}:1 on every surface it is drawn over`, () => {
          const mark = readToken(theme, token);
          for (const surface of SURFACES) {
            const ratio = contrast(mark, readToken(theme, surface));
            expect(
              ratio,
              `${token} on ${surface} in ${theme} is ${ratio.toFixed(2)}:1`,
            ).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST_FLOOR);
          }
        });

        it(`${token} is inside the sRGB gamut, so no gamut mapping changes it`, () => {
          expect(inSrgbGamut(readToken(theme, token))).toBe(true);
        });
      }
    });
  }

  it("does not reuse one ramp for both themes", () => {
    // The defect this whole file exists for: the starter's `:root` and `.dark` chart values were
    // byte-identical, so a mark legible on white was 2.30:1 on the dark card.
    for (const token of CHART_TOKENS) {
      expect(readToken(":root", token), `${token} is the same in both themes`).not.toEqual(
        readToken(".dark", token),
      );
    }
  });

  it("separates the slots by lightness as well as hue, so the legend survives greyscale", () => {
    // `toneClasses` reaches --chart-2 for series 2 and --chart-3 for series 3+; series 1 is --primary.
    for (const theme of [":root", ".dark"] as const) {
      const [two, three] = [readToken(theme, "--chart-2"), readToken(theme, "--chart-3")];
      expect(Math.abs(two.L - three.L), `--chart-2 and --chart-3 in ${theme}`).toBeGreaterThan(0.1);
      expect(contrast(two, readToken(theme, "--primary"))).toBeGreaterThan(1.1);
    }
  });
});

describe("the chart's own claim about those tokens", () => {
  const chart = readFileSync(path.join(ROOT, "src/components/reports/report-chart.tsx"), "utf8");

  it("does not tell the next reader that dark mode needs no second palette", () => {
    // It does need one, and it now has one — in globals.css, which is where the fix belongs.
    expect(chart).not.toMatch(/dark mode needs no second palette/);
  });
});
