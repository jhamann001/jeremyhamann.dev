/**
 * Fix round 2 — the Held-mail badge must exist on BOTH navigation surfaces.
 *
 * `navItemsFor` now returns an optional `count` on an `AdminNavItem`, and the number is only useful if
 * every renderer of that array prints it: the md+ sidebar's Admin section
 * (`src/components/app-sidebar.tsx`) and the phone Account sheet's Admin block
 * (`src/components/shell/account-sheet.tsx`, two taps deep — Account tab, then scroll). A renderer that
 * quietly drops it reproduces the defect this fix closes, which is that nothing anywhere in the app
 * tells an operator that client messages are sitting refused and unread.
 *
 * Source probes, in the repo's existing pattern (`mobile-first-doc.test.ts`,
 * `src/components/admin/admin-surface-probe.test.ts`): this vitest project has no DOM.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const NAV_ITEMS = read("src/components/shell/nav-items.ts");
const SIDEBAR = read("src/components/app-sidebar.tsx");
const ACCOUNT_SHEET = read("src/components/shell/account-sheet.tsx");
const BOTTOM_NAV = read("src/components/shell/bottom-nav.tsx");
const APP_LAYOUT = read("src/app/(app)/layout.tsx");

describe("the Held-mail count reaches every surface that renders the Admin entries", () => {
  it("nav-items carries it as an optional count on AdminNavItem, fed by NavCounts", () => {
    expect(NAV_ITEMS).toMatch(/export type AdminNavItem = \{[^}]*count\?: number/);
    expect(NAV_ITEMS).toMatch(/export type NavCounts = \{[^}]*heldIntake\?: number/);
    expect(NAV_ITEMS).toMatch(/export function navItemsFor\([^)]*counts: NavCounts = \{\}\)/);
  });

  it("the md+ sidebar renders the count as a Badge", () => {
    // Wave B threads a second count (the inbox unread) through the same call, so the assertion is on
    // the ARGUMENT rather than on the whole call text — the property this test defends is that the
    // sidebar derives from the layout's number instead of reading for itself.
    expect(SIDEBAR, "sidebar must pass the layout's number into the derivation").toMatch(
      /navItemsFor\(viewer,\s*\{[^}]*heldIntake:\s*heldIntakeCount/,
    );
    expect(SIDEBAR, "the admin NavLink must forward the entry's count").toContain("count: a.count");
    expect(SIDEBAR).toMatch(/item\.count !== undefined[\s\S]{0,400}<Badge/);
    expect(SIDEBAR, "a bare number is not an accessible name").toMatch(/sr-only">\s*waiting/);
  });

  it("the phone Account sheet renders the same count as a Badge", () => {
    expect(ACCOUNT_SHEET).toContain("navItemsFor(viewer, { heldIntake: heldIntakeCount })");
    expect(ACCOUNT_SHEET).toMatch(/a\.count !== undefined[\s\S]{0,400}<Badge/);
    expect(ACCOUNT_SHEET).toMatch(/sr-only">\s*waiting/);
  });

  it("BottomNav threads the number through to the Account sheet", () => {
    expect(BOTTOM_NAV).toMatch(/heldIntakeCount\?: number/);
    expect(BOTTOM_NAV).toContain("heldIntakeCount={heldIntakeCount}");
  });

  it("the (app) layout does the read, gated and fail-soft — a badge cannot break every page", () => {
    expect(APP_LAYOUT, "the capability is checked before the read (no AUTHZ_DENIED row for a nav badge)").toContain(
      "canReviewHeldIntake(viewer.groups)",
    );
    expect(APP_LAYOUT).toContain("heldIntakeCounts(viewer)");
    expect(APP_LAYOUT, "a failed count degrades to no badge").toMatch(/try \{[\s\S]{0,400}catch[\s\S]{0,300}return undefined/);
    // Both navigations get the number. Matched as a pattern rather than as an exact tag because Wave B
    // added a second count beside it; what must not regress is that neither surface reads for itself.
    // One LITERAL per surface: `new RegExp(`<${surface}…`)` was a security scanner CWE-185 finding
    // (see the build record)
    expect(APP_LAYOUT, "the layout must pass the count to <AppSidebar>").toMatch(
      /<AppSidebar[^>]*heldIntakeCount=\{heldIntakeCount\}/,
    );
    expect(APP_LAYOUT, "the layout must pass the count to <BottomNav>").toMatch(
      /<BottomNav[^>]*heldIntakeCount=\{heldIntakeCount\}/,
    );
  });
});
