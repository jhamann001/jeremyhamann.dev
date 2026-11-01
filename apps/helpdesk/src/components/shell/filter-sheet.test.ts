/**
 * Fix round 2 — the phone filter sheet must not trap a drag.
 *
 * `FilterSheet` renders its sections inside `ResponsiveSheetBody`, which is itself
 * `overflow-y-auto overscroll-contain`: that containment is correct and deliberate (R1 — the page
 * behind the sheet never moves). `FilterCheckboxList` is a SECOND scroller nested inside it, and the
 * dashboard sheet renders two of them (Category: 22 options, Source: 9) as ~32rem of a ~37rem sheet
 * body, with the Created range and Sort below. Containment on the inner list stops scroll chaining,
 * so a finger that lands on Category scrolls that list to its end and then nothing at all — the
 * sections underneath become unreachable at 390x844. Chaining back to the sheet body is the fix.
 *
 * Asserted against the source (the repo's probe pattern — see `mobile-first-doc.test.ts` and
 * `src/components/admin/admin-surface-probe.test.ts`) because there is no DOM in this vitest project,
 * and a jsdom render could not model touch scroll chaining anyway.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const FILTER_SHEET = read("src/components/shell/filter-sheet.tsx");
const RESPONSIVE_SHEET = read("src/components/shell/responsive-sheet.tsx");

/** A function's body, from its `export function <name>` to the next top-level `export`. */
function body(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  expect(start, `${name} not found — it was renamed or restructured`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.indexOf("\nexport ");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every double-quoted Tailwind class string in a chunk of source. */
function classStrings(source: string): string[] {
  return [...source.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]).filter((s) => /\b(flex|grid|overflow|min-h|max-h)\b/.test(s));
}

describe("FilterCheckboxList — no nested vertical scroll trap (fix round 2)", () => {
  it("scrolls inside itself but lets the drag chain back to the sheet body", () => {
    const list = body(FILTER_SHEET, "FilterCheckboxList");
    expect(list, "the list still needs its own scroll box: it must never lengthen the sheet").toContain(
      "overflow-y-auto",
    );
    expect(list, "max-h caps the box").toContain("max-h-");
    expect(
      list,
      "overscroll-contain on the INNER list stops chaining and hides every section below it",
    ).not.toContain("overscroll-contain");
  });

  it("no vertical scroller in the filter sheet contains its own overscroll", () => {
    for (const cls of classStrings(FILTER_SHEET)) {
      if (!cls.includes("overflow-y-auto")) continue;
      expect(cls, `a nested vertical scroller contains its overscroll: "${cls}"`).not.toMatch(
        /overscroll-(y-)?contain/,
      );
    }
  });

  it("the sheet body itself KEEPS its containment — the page behind a sheet never scrolls (R1)", () => {
    const sheetBody = body(RESPONSIVE_SHEET, "ResponsiveSheetBody");
    expect(sheetBody).toContain("overflow-y-auto");
    expect(sheetBody).toContain("overscroll-contain");
  });

  it("the horizontal snap row keeps overscroll-x-contain (a different axis, and it chains vertically)", () => {
    expect(FILTER_SHEET).toContain("overscroll-x-contain");
  });
});
