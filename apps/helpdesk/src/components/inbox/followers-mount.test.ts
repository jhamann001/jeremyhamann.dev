/**
 * Source guard for the FOLLOW control's reach (slice **B1**).
 *
 * The defect this pins: `TicketFollowers` was mounted only inside the ticket page's `hidden md:flex`
 * properties column, so at 360/390/430 the "Follow ticket HD-n" / "Stop following ticket HD-n" button
 * was present in the DOM with a 0x0 box and could not be tapped. A phone operator's only route to
 * following a ticket was to leave the ticket, select it on the dashboard and use the bulk bar. That
 * was the contract's stated placement rather than a build error, and
 * the build record recorded it as a known gap; the fix is the
 * second mount §1.6 proposed, not a move.
 *
 * Same technique as `src/components/ticket/ticket-surface-probe.test.ts`: `vitest.config.mts` runs
 * `environment: "node"`, so there is no DOM to measure. This asserts the SHAPE of the source — that
 * both mounts exist, that the phone one is inside a `md:hidden` container and the md+ one inside a
 * `hidden md:` container, and that the toggle is not buried inside the phone sheet, which would put a
 * one-tap act two taps and a dialog away.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const PAGE = "src/app/(app)/tickets/[id]/page.tsx";
const PANEL = "src/components/inbox/ticket-followers.tsx";
const SHEET = "src/components/inbox/followers-sheet.tsx";

/** The `<div className="…">…</div>` block whose class list contains `marker`, by brace-free scan. */
function blockWithClass(source: string, marker: string): string {
  const open = source.indexOf(`<div className="${marker}`);
  if (open === -1) {
    const alt = source.split("\n").findIndex((l) => l.includes("<div className=") && l.includes(marker));
    expect(alt, `no <div> carrying ${marker}`).toBeGreaterThan(-1);
  }
  expect(open, `no <div className="${marker}…`).toBeGreaterThan(-1);
  const end = source.indexOf("\n      </div>", open);
  expect(end, "unterminated block").toBeGreaterThan(open);
  return source.slice(open, end);
}

describe("the follow control is reachable at every width", () => {
  const page = read(PAGE);

  it("mounts TicketFollowers twice — the md+ column and the phone block", () => {
    const mounts = page.match(/<TicketFollowers\b/g) ?? [];
    expect(mounts).toHaveLength(2);
  });

  it("puts the phone mount inside the md:hidden block above the action dock", () => {
    const phoneBlock = blockWithClass(page, "flex flex-col gap-2 md:hidden");
    expect(phoneBlock).toContain('<TicketFollowers ticket={ticket} viewer={viewer} variant="sheet" />');
    // It must stay above the dock, which is fixed on phones and would cover it.
    expect(page.indexOf("variant=\"sheet\" />", page.indexOf("<TicketFollowers"))).toBeLessThan(
      page.indexOf("<TicketActionDock"),
    );
  });

  it("leaves the contract's md+ placement alone", () => {
    const aside = blockWithClass(page, "hidden flex-col gap-4 md:flex");
    expect(aside).toContain("<TicketFollowers ticket={ticket} viewer={viewer} />");
    expect(aside).not.toContain('variant="sheet"');
  });

  it("streams the phone mount behind its own boundary, like every other self-loading panel", () => {
    expect(page).toContain('<Suspense fallback={<PanelSkeleton label="Loading followers…" className="h-11" />}>');
  });
});

describe("TicketFollowers", () => {
  const panel = read(PANEL);

  it("keeps the contract's props callable — variant is optional and defaults to the md+ panel", () => {
    expect(panel).toMatch(/variant\?: TicketFollowersVariant/);
    expect(panel).toMatch(/variant = "inline"/);
  });

  it("stays a server component (no directive) and collapses the two mounts into one load", () => {
    expect(panel.trimStart().startsWith('"use client"')).toBe(false);
    expect(panel).toContain('import { cache } from "react"');
    expect(panel).toContain("const loadFollowers = cache(");
    // One call site for the data: a second, uncached call would double the queries per render.
    expect(panel.match(/loadFollowers\(/g) ?? []).toHaveLength(1);
  });

  it("renders the toggle in BOTH variants, and at the top level of the phone one", () => {
    expect(panel.match(/<FollowButton\b/g) ?? []).toHaveLength(2);
    const sheetBranch = panel.slice(panel.indexOf('if (variant === "sheet")'), panel.indexOf("  return (\n    <section"));
    const toggleAt = sheetBranch.indexOf("<FollowButton");
    const sheetAt = sheetBranch.indexOf("<FollowersSheet");
    expect(toggleAt).toBeGreaterThan(-1);
    expect(sheetAt).toBeGreaterThan(toggleAt);
  });

  it("names the panel once, for both presentations (R7)", () => {
    expect(panel).toContain('const FOLLOWERS_HEADING = "Followers" as const');
    expect(panel.match(/FOLLOWERS_HEADING/g) ?? []).toHaveLength(3);
  });
});

describe("FollowersSheet", () => {
  const sheet = read(SHEET);

  it("is the thin client half: open state only, no data and no server import", () => {
    expect(sheet.trimStart().startsWith('"use client"')).toBe(true);
    expect(sheet).not.toMatch(/from "@\/server\//);
    expect(sheet).not.toMatch(/from "@\/lib\/(db|env|audit|session)"/);
    expect(sheet).toContain("children: React.ReactNode");
  });

  it("pads for the home indicator and does not hold the follow toggle", () => {
    expect(sheet).toContain("env(safe-area-inset-bottom,0px)");
    expect(sheet).not.toContain("FollowButton");
  });

  it("carries a sheet title and a full-width trigger (R3/R10)", () => {
    expect(sheet).toContain("title={label}");
    expect(sheet).toContain('className="w-full justify-start"');
  });
});
