/**
 * Guards the dashboard/queue LIST probe in docs/MOBILE_FIRST.md §7 against the defect it was filed for:
 * the check was written as `document.querySelectorAll('[data-ticket-id]').length === Math.min(pageSize, total)`,
 * but `data-ticket-id` is carried by FOUR nodes per ticket on those screens — the card `li`, the table `tr`,
 * and the `AssigneeSelect` trigger rendered inside each of them. The layout was correct; the probe was not,
 * so every reviewer running the documented checklist recorded a FAIL on a passing build.
 *
 * These are SOURCE assertions, in the style of `src/app/(app)/tickets/[id]/streaming.test.ts`, because the
 * repo has no DOM test environment (vitest `environment: "node"`). What must not regress is structural: the
 * probe's selectors stay element-scoped, and the elements they name still exist in the components.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

const MOBILE_FIRST = read("docs/MOBILE_FIRST.md");
const TICKET_TABLE = read("src/components/dashboard/ticket-table.tsx");
const TICKET_CARD = read("src/components/dashboard/ticket-card.tsx");
const UI_TABLE = read("src/components/ui/table.tsx");

/** §7 only — §3/§4 describe the markup and legitimately quote the attribute on its own. */
const QA_SECTION = (() => {
  const start = MOBILE_FIRST.indexOf("## (7) QA checklist");
  const end = MOBILE_FIRST.indexOf("## (8)", start);
  if (start < 0 || end <= start) throw new Error("docs/MOBILE_FIRST.md: section (7) not found");
  return MOBILE_FIRST.slice(start, end);
})();

/** Every `document.querySelector(All)?('<selector>')` literal in §7. */
function probeSelectors(text: string): string[] {
  return [...text.matchAll(/querySelector(?:All)?\(\s*(['"])([^'"]+)\1/g)].map((m) => m[2]);
}

function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe("MOBILE_FIRST §7 ticket-list probe", () => {
  it("never counts tickets with the bare [data-ticket-id] selector", () => {
    const bare = probeSelectors(QA_SECTION).filter((s) => s.startsWith("[data-ticket-id]"));
    expect(bare).toEqual([]);
  });

  it("counts cards and rows with element-scoped selectors that match one node per ticket", () => {
    expect(QA_SECTION).toContain(`document.querySelectorAll('ol[aria-label="Tickets"] > li[data-ticket-id]').length`);
    expect(QA_SECTION).toContain("document.querySelectorAll('tbody tr[data-ticket-id]').length");
    // the count alone never proves which rendering is on screen — both are always in the DOM
    expect(QA_SECTION).toMatch(/cardsVisible[\s\S]{0,200}tableVisible/);
    expect(QA_SECTION).toMatch(/expected at every width: cards === rows === Math\.min\(pageSize, total\)/);
  });

  it("G13 clicks the row container that is on screen, not the first bare match", () => {
    expect(QA_SECTION).toContain("document.querySelectorAll('li[data-ticket-id],tr[data-ticket-id]')");
    expect(QA_SECTION).toMatch(/getBoundingClientRect\(\)\.height > 0/);
    expect(QA_SECTION).toContain(`src.querySelector('a[href^="/tickets/"]')`);
  });

  it("documents why the attribute is ambiguous, and the file list in that note is still true", () => {
    for (const file of [
      "ticket-card.tsx",
      "ticket-table.tsx",
      "assignee-select.tsx",
      "columns.tsx",
      "ticket-header.tsx",
    ]) {
      expect(QA_SECTION).toContain(file);
    }
    const emitters = walk("src")
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
      .filter((f) => read(f).includes("data-ticket-id"))
      .map((f) => path.basename(f))
      .sort();
    // If this set changes, the §7 selector note above it is stale and must be updated with it.
    expect(emitters).toEqual(["assignee-select.tsx", "ticket-card.tsx", "ticket-header.tsx", "ticket-table.tsx"]);
  });
});

describe("the elements the §7 list probe names", () => {
  it("renders the phone cards as <li data-ticket-id> inside <ol aria-label=\"Tickets\">", () => {
    expect(TICKET_TABLE).toMatch(/<ol\s+className=\{cn\("[^"]*md:hidden[^"]*"[\s\S]{0,60}aria-label="Tickets"/);
    expect(TICKET_CARD).toMatch(/as="li"/);
    expect(TICKET_CARD).toMatch(/data-ticket-id=\{row\.id\}/);
  });

  it("renders the table rows as <tr data-ticket-id> inside a hidden md:block wrapper", () => {
    expect(TICKET_TABLE).toMatch(/<TableRow[\s\S]{0,120}data-ticket-id=\{t\.id\}/);
    expect(TICKET_TABLE).toMatch(/className=\{cn\("hidden [^"]*md:block"/);
    expect(UI_TABLE).toMatch(/data-slot="table-container"/);
    // the probe reads that wrapper as the container's parentElement
    expect(UI_TABLE).toMatch(/data-slot="table-container"[\s\S]{0,200}<table/);
  });
});
