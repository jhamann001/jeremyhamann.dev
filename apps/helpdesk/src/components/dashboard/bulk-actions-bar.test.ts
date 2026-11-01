/**
 * What the bulk bar offers, and what it says afterwards (the build record rule 4).
 *
 * Two rules are tested because both are honesty rather than ergonomics:
 *  - an option is offered only when EVERY selected ticket could take it, so the bar never invites a
 *    click that the server will refuse ticket by ticket;
 *  - the summary never says "done". Partial success is the contract, and the sentence names what was
 *    skipped.
 *
 * `@/server/bulk.actions` is mocked: this file tests pure helpers, and importing a `"use server"`
 * module would drag a Prisma client into a unit test that has no database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BulkActionResult, TicketListRow, Viewer } from "@/types/domain";

vi.mock("@/server/bulk.actions", () => ({ applyBulkAction: vi.fn() }));

const {
  commonQueueTargets,
  commonStatusTargets,
  effectiveSelection,
  summarizeOutcome,
} = await import("@/components/dashboard/bulk-actions-bar");

function row(over: Partial<TicketListRow>): TicketListRow {
  return {
    id: "t1",
    number: 1,
    subject: "s",
    category: "OTHER",
    priority: "STANDARD",
    status: "OPEN",
    queueKey: "OPERATIONS",
    assignee: null,
    requesterName: "Dana",
    brand: "CEDAR_RIDGE_WEALTH",
    source: "STAFF_FORM",
    isComplaint: false,
    complaintFiledAt: null,
    escalationTarget: "NONE",
    followUpAt: null,
    externalRef: null,
    resolution: "NONE",
    mergedIntoId: null,
    mergedIntoNumber: null,
    createdAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T12:00:00.000Z",
    firstResponseDueAt: "2026-09-20T16:00:00.000Z",
    resolutionDueAt: "2026-09-21T12:00:00.000Z",
    firstRespondedAt: null,
    resolvedAt: null,
    piiRedacted: false,
    piiRedactionCount: 0,
    version: 1,
    sla: {
      phase: "FIRST_RESPONSE",
      status: "ON_TRACK",
      dueAt: "2026-09-20T16:00:00.000Z",
      remainingMs: 3_600_000,
      firstResponseMet: null,
      resolutionMet: null,
    },
    ...over,
  };
}

const ops: Viewer = { id: "u1", email: "ops@wm-helpdesk.local", name: "Ops", image: null, groups: ["ops_team"], isDev: false };
const cs: Viewer = { ...ops, id: "u2", groups: ["client_services"] };

describe("effectiveSelection", () => {
  it("takes the union of the contract prop and the table's own store", () => {
    const rows = [row({ id: "a" }), row({ id: "b" })];
    expect(effectiveSelection(["a"], ["b"], rows).sort()).toEqual(["a", "b"]);
  });

  it("deduplicates, so one ticket is never counted or written twice", () => {
    expect(effectiveSelection(["a"], ["a"], [row({ id: "a" })])).toEqual(["a"]);
  });

  it("drops an id that is not on the page any more — a stale selection is not a selection", () => {
    expect(effectiveSelection(["gone"], [], [row({ id: "a" })])).toEqual([]);
  });
});

describe("commonStatusTargets", () => {
  it("offers only what EVERY selected ticket could move to", () => {
    // NEW → Resolved is allowed; PENDING_CLIENT → Pending internal is not.
    const targets = commonStatusTargets([row({ id: "a", status: "NEW" }), row({ id: "b", status: "PENDING_CLIENT" })]);
    expect(targets).toContain("RESOLVED");
    expect(targets).not.toContain("PENDING_INTERNAL");
  });

  it("offers nothing once a terminal ticket is in the selection", () => {
    expect(commonStatusTargets([row({ id: "a", status: "OPEN" }), row({ id: "b", status: "CLOSED" })])).toEqual([]);
  });

  it("offers nothing for an empty selection", () => {
    expect(commonStatusTargets([])).toEqual([]);
  });
});

describe("commonQueueTargets", () => {
  it("lets ops move anywhere it can write", () => {
    expect(commonQueueTargets([row({ queueKey: "OPERATIONS" })], ops).length).toBeGreaterThan(0);
  });

  it("offers a queue only when every selected ticket can reach it", () => {
    const mixed = [row({ id: "a", queueKey: "OPERATIONS" }), row({ id: "b", queueKey: "ADVICE" })];
    for (const q of commonQueueTargets(mixed, cs)) {
      expect(commonQueueTargets([mixed[0] as TicketListRow], cs)).toContain(q);
      expect(commonQueueTargets([mixed[1] as TicketListRow], cs)).toContain(q);
    }
  });
});

describe("summarizeOutcome", () => {
  const numbers = new Map([
    ["a", 12],
    ["b", 13],
  ]);

  it("never says 'done' — it says how many, and what was skipped", () => {
    const result: BulkActionResult = {
      applied: 4,
      skipped: [{ ticketId: "a", code: "CONFLICT", message: "The record changed since you loaded it" }],
    };
    const text = summarizeOutcome(result, numbers);
    expect(text).toContain("4 applied");
    expect(text).toContain("1 skipped");
    expect(text).toContain("HD-12");
    expect(text.toLowerCase()).not.toContain("done");
  });

  it("is quiet when nothing was skipped", () => {
    expect(summarizeOutcome({ applied: 2, skipped: [] }, numbers)).toBe("2 applied");
  });

  it("names the first three and counts the rest, so a toast stays readable", () => {
    const skipped = Array.from({ length: 5 }, (_, i) => ({
      ticketId: `x${i}`,
      code: "FORBIDDEN" as const,
      message: "Forbidden: bulk:apply",
    }));
    expect(summarizeOutcome({ applied: 0, skipped }, numbers)).toContain("+2 more");
  });
});

describe("commonStatusTargets — Decision #96", () => {
  it("NEVER offers Voided, not even back to a ticket that is already voided", () => {
    // A ticket trivially satisfies "already at that status", so without the explicit exclusion the
    // dropdown would hand every holder of queue:write a one-click way off every counter.
    expect(commonStatusTargets([row({ status: "VOIDED" })])).not.toContain("VOIDED");
    expect(commonStatusTargets([row({ id: "a", status: "OPEN" }), row({ id: "b", status: "NEW" })])).not.toContain("VOIDED");
  });

  it("offers nothing that would change nothing", () => {
    expect(commonStatusTargets([row({ status: "OPEN" })])).not.toContain("OPEN");
  });
});

/**
 * Fix round 2 — the bar must not stick to the same edge as the topbar.
 *
 * `sticky top-0 z-20` pinned this bar to y = 0, which is where the shell's topbar already sits
 * (`sticky top-0 z-40`, an ancestor-sibling in the same document scroll: safe area + environment
 * banner + identity row, ~64 px on a phone, near-opaque and backdrop-blurred). So the instant an
 * operator scrolled the board to check another row, the "N selected" count and every action went
 * under the chrome — defeating the only reason the bar is sticky. Neither QA round caught it because
 * §7's G10 probe only ever looked at the BOTTOM bars.
 *
 * Source assertions, like `ticket-list-probe.test.ts`: vitest runs in `environment: "node"`, so there
 * is no DOM to measure and what must not regress is structural — the offset token exists and is
 * defined from the topbar's real parts, the bar consumes it instead of `top-0`, it stacks below the
 * topbar, and §7 carries a probe that would catch a relapse against the live DOM.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const readRepo = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

describe("the bulk bar clears the topbar", () => {
  const BAR = readRepo("src/components/dashboard/bulk-actions-bar.tsx");
  const CSS = readRepo("src/app/globals.css");
  const TOPBAR = readRepo("src/components/topbar.tsx");

  it("offsets by --wm-topbar-h and never sticks to top-0", () => {
    expect(BAR).toContain("sticky top-(--wm-topbar-h)");
    expect(BAR, "back on top-0 — the topbar owns that edge").not.toMatch(/className="[^"]*sticky top-0/);
  });

  it("stacks above the list but below the topbar", () => {
    const barZ = /className="sticky top-\(--wm-topbar-h\) z-(\d+)/.exec(BAR)?.[1];
    const topbarZ = /<header data-topbar className="sticky top-0 z-(\d+)/.exec(TOPBAR)?.[1];
    expect(barZ, "the bar carries no z-index — a blurred list row can paint over it").toBeDefined();
    expect(topbarZ, "the topbar's z-index could not be read — this guard's premise changed").toBeDefined();
    expect(Number(barZ)).toBeGreaterThan(0);
    expect(Number(barZ)).toBeLessThan(Number(topbarZ));
  });

  it("defines the token from the topbar's real parts, at both breakpoints", () => {
    expect(CSS).toMatch(
      /--wm-topbar-h:\s*calc\(env\(safe-area-inset-top, 0px\) \+ var\(--wm-topbar-banner-h\) \+ var\(--wm-topbar-row-h\)\)/,
    );
    // Row: min-h-11 (44px) on phones, md:min-h-12 (48px) — the token must carry both.
    expect(TOPBAR).toContain("min-h-11");
    expect(TOPBAR).toContain("md:min-h-12");
    expect(CSS).toContain("--wm-topbar-row-h: 2.75rem");
    expect(CSS).toContain("--wm-topbar-row-h: 3rem");
    // Banner: h-5 / md:h-6, and absent in production — which is what the :has() rule encodes.
    expect(TOPBAR).toContain("data-env-banner");
    expect(CSS).toContain(":root:has([data-env-banner])");
    expect(CSS).toContain("--wm-topbar-banner-h: 0rem");
    expect(CSS).toContain("--wm-topbar-banner-h: 1.25rem");
    expect(CSS).toContain("--wm-topbar-banner-h: 1.5rem");
  });

  it("is probeable: both DOM handles exist and §7 asserts the top edge", () => {
    expect(TOPBAR).toContain("<header data-topbar");
    expect(BAR).toContain("data-sticky-top-bar");

    const doc = readRepo("docs/MOBILE_FIRST.md");
    const qa = doc.slice(doc.indexOf("## (7) QA checklist"), doc.indexOf("## (8)", doc.indexOf("## (7) QA checklist")));
    expect(qa, "§7 has no G14 probe — top-edge occlusion is unchecked again").toContain("// G14 \u2014");
    expect(qa).toContain("[data-sticky-top-bar]");
    expect(qa).toContain("[data-topbar]");
    // The assertion itself, not just the selectors: bar top at or below the topbar bottom.
    expect(qa).toMatch(/getBoundingClientRect\(\)\.top\s*>=\s*topBottom/);
  });
});
