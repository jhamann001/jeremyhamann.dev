/**
 * Source guard for `StatusBadge`'s `describe` prop and for the tooltip it replaced.
 *
 * Round 1 added `describe` to the badge (the crosswalk sentence on the `title` AND on the accessible
 * name) and never passed it anywhere: nine call sites, zero uses. The two surfaces that actually wanted
 * the sentence kept an interim `<span title={statusHelpText(...)}>` wrapper around the badge, which is
 * precisely the tooltip-only form MOBILE_FIRST R10 forbids — unreachable on a touch device, invisible to
 * a screen reader, and the reason `describe` exists at all
 * (the build record).
 *
 * Both halves of that failure are invisible at typecheck: an unread optional prop compiles, and so does
 * a `title` on any element. Same technique as `ticket-surface-probe.test.ts` — the repo runs
 * `environment: "node"` with no DOM, so this asserts the SHAPE of the source.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Reading ONE ticket, where a sentence per chip is help rather than noise. Kept in step with the
 * docstring on `status-badge.tsx`, which names the same five.
 */
const DESCRIBING_SURFACES: readonly string[] = [
  "src/components/ticket/ticket-header.tsx",
  "src/components/ticket/properties-panel.tsx",
  "src/components/ticket/links/links-panel.tsx",
  "src/components/ticket/links/duplicate-candidates.tsx",
  "src/components/dashboard/ticket-preview-sheet.tsx",
];

/** Lists. Fifty rows of the same sentence is noise, so the chip stays bare — deliberately, not by accident. */
const BARE_SURFACES: readonly string[] = [
  "src/components/dashboard/columns.tsx",
  "src/components/dashboard/ticket-card.tsx",
  "src/components/dashboard/ticket-table.tsx",
  "src/components/ticket/requester-history.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const TSX = walk(path.join(ROOT, "src")).map((full) => ({
  rel: path.relative(ROOT, full),
  src: readFileSync(full, "utf8"),
}));

/** Every `<StatusBadge … />` element in a file, opening tag only. */
function badgeTags(src: string): string[] {
  return src.match(/<StatusBadge\b[^>]*>/g) ?? [];
}

describe("StatusBadge `describe` is wired, not decorative", () => {
  it("is passed on every surface that reads one ticket", () => {
    for (const rel of DESCRIBING_SURFACES) {
      const tags = badgeTags(read(rel));
      expect(tags.length, `${rel} no longer renders a StatusBadge — this guard's premise changed`).toBeGreaterThan(0);
      expect(
        tags.some((tag) => /\bdescribe\b/.test(tag)),
        `${rel} renders StatusBadge without \`describe\` — the crosswalk sentence is dead code again`,
      ).toBe(true);
    }
  });

  it("is withheld on the list surfaces, where the same sentence would repeat per row", () => {
    for (const rel of BARE_SURFACES) {
      const tags = badgeTags(read(rel));
      expect(tags.length, `${rel} no longer renders a StatusBadge`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(/\bdescribe\b/.test(tag), `${rel} describes every row's status`).toBe(false);
      }
    }
  });

  it("is a real prop on the badge, carried by the accessible name and not by `title` alone", () => {
    const badge = read("src/components/tickets/status-badge.tsx");
    expect(badge).toMatch(/describe\s*=\s*false/);
    expect(badge, "the help never reaches the accessible name — R10 makes a `title` alone unreachable").toMatch(
      /aria-label=\{[^}]*help/,
    );
  });
});

describe("no status help is tooltip-only (MOBILE_FIRST R10)", () => {
  it("no element anywhere hangs statusHelpText off a `title`", () => {
    const offenders = TSX
      // The badge itself is exempt: its docstring QUOTES the wrapper it replaced, and its own `title`
      // is a supplement to the accessible name rather than the only carrier.
      .filter(({ rel }) => rel !== "src/components/tickets/status-badge.tsx")
      .filter(({ src }) => /title=\{\s*statusHelpText/.test(src))
      .map(({ rel }) => rel);
    expect(offenders, "a `title` is a tooltip, not an explanation — use `describe` or a visible sub-line").toEqual([]);
  });

  it("no surface wraps the badge in a title-bearing span again", () => {
    const offenders = TSX.filter(({ src }) => /<span[^>]*\btitle=[^>]*>\s*<StatusBadge/.test(src)).map(({ rel }) => rel);
    expect(offenders, "the interim wrapper is back; pass `describe` to the badge instead").toEqual([]);
  });

  it("the bulk bar shows the sentence under each status option instead", () => {
    const bar = read("src/components/dashboard/bulk-actions-bar.tsx");
    expect(bar, "the bulk bar stopped quoting the crosswalk where a status is chosen").toContain("statusHelpText(s)");
    // Rendered as element CONTENT — `{statusHelpText(s)}` between tags, never as an attribute value.
    expect(bar).toMatch(/>\s*\{statusHelpText\(s\)\}\s*</);
  });
});
