/**
 * A disabled dock item must explain itself without a tooltip and without
 * growing the bar.
 *
 * The bar is `position: fixed` with `min-h-[calc(var(--wm-bottom-bar-h)+…)]`, and `<main>` reserves
 * exactly one `--wm-bottom-bar-h` via `pb-bar-safe`. So a reason line rendered above the item row
 * would make the bar taller than the reservation and cover the last line of page content at full
 * scroll — which probe G10 exists to catch — and a line rendered as a direct bar CHILD would also
 * break §7's `[data-sticky-action-bar] > *` length `=== 5` on the ticket dock. The reason therefore
 * rides as an `sr-only` node named by `aria-describedby`, and is *seen* in the sheet the item opens.
 *
 * The repo has no DOM test environment, so this is a source guard in the established style
 * (`requester-email-flow.test.ts`, `mobile-first-doc.test.ts`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const bar = read("src/components/shell/sticky-action-bar.tsx");
const dock = read("src/components/ticket/ticket-action-dock.tsx");
const mobileFirst = read("docs/MOBILE_FIRST.md");

describe("a disabled sticky-action item explains itself without a tooltip", () => {
  it("renders the reason as an sr-only node and names it with aria-describedby", () => {
    expect(bar).toContain('className="sr-only"');
    expect(bar).toContain("aria-describedby={describedBy}");
    // Both renderings of a disabled item — the <span role="link"> and the <button> — must carry it.
    const describedBy = bar.match(/aria-describedby=\{describedBy\}/g) ?? [];
    expect(describedBy.length).toBeGreaterThanOrEqual(2);
  });

  it("only produces a description when the item is actually disabled and the reason is non-empty", () => {
    expect(bar).toContain("const reason = disabled ? disabledReason?.trim() : undefined;");
    expect(bar).toContain("const hasReason = reason !== undefined && reason.length > 0;");
    // An empty id would collide across items and break G11 (no duplicate ids).
    expect(bar).toContain("const describedBy = hasReason ? reasonId(label) : undefined;");
  });

  it("never paints the reason into the bar — the bar's height is the reservation <main> makes", () => {
    // No text node may be rendered by StickyActionBar itself: its only child is {children}. A reason
    // line there is taller than `--wm-bottom-bar-h` and covers content at full scroll.
    const barFn = /export function StickyActionBar\([\s\S]*?\n}\n/.exec(bar)?.[0] ?? "";
    expect(barFn, "StickyActionBar not found — the bar was restructured").not.toBe("");
    expect(barFn).toContain("{children}");
    expect(barFn, "StickyActionBar now renders its own <p> — that grows the fixed bar past pb-bar-safe")
      .not.toMatch(/<p[\s>]/);
    // The item itself must add no visible box either.
    expect(bar, "the reason node is no longer sr-only").not.toMatch(
      /id=\{describedBy\}\s+className="(?!sr-only)/,
    );
  });

  it("the sr-only class is the only thing keeping it out of layout", () => {
    // Belt to the braces above: if someone swaps sr-only for a visible class, this fails loudly.
    const node = /<span id=\{describedBy\} className="([^"]*)">/.exec(bar)?.[1];
    expect(node, "the reason node changed shape").toBe("sr-only");
  });
});

describe("the spec and the dock no longer claim a `title` is visible", () => {
  it("no source or spec file calls a title attribute visible", () => {
    for (const [name, text] of [
      ["sticky-action-bar.tsx", bar],
      ["ticket-action-dock.tsx", dock],
      ["docs/MOBILE_FIRST.md", mobileFirst],
    ] as const) {
      expect(text, `${name} still calls a title visible — a title IS the tooltip R10 forbids`).not.toMatch(
        /visible\s+`?title`?/i,
      );
    }
  });

  it("R10 says where the reason is actually seen", () => {
    const r10 = /- \*\*R10 — Accessibility\.\*\*[\s\S]*?\n(?=- \*\*R11|\n)/.exec(mobileFirst)?.[0] ?? "";
    expect(r10, "R10 not found").not.toBe("");
    expect(r10).toMatch(/sr-only/);
    expect(r10).toMatch(/aria-describedby/);
  });

  it("the dock records why the bar cannot paint it", () => {
    expect(dock).toMatch(/G10/);
    expect(dock).toMatch(/aria-describedby/);
  });

  it("at least one comment channel is always enabled when the dock renders either item", () => {
    // This is what makes the composer's own visible line reachable: the reason for the DISABLED
    // channel is printed under the TabsList of the sheet the ENABLED one opens.
    expect(dock).toContain("const anyComment = permissions.canInternalNote || permissions.canPublicReply;");
    expect(dock).toContain("{anyComment ? (");
    const composer = read("src/components/ticket/composer.tsx");
    expect(composer).toContain('data-slot="channel-disabled-reason"');
  });
});
