/**
 * Static source checks over the ticket-detail segment's loading and streaming boundaries
 * (docs/MOBILE_FIRST.md §7 probe G13).
 *
 * The finding this covers: the segment had no `loading.tsx` and no `<Suspense>` anywhere, while Wave A
 * mounted two async server components that own their own loads. A client navigation therefore left the
 * previous screen on display — unchanged, with no feedback — for three sequential database waves, on
 * the app's most-used navigation and its declared primary device.
 *
 * These are SOURCE assertions, in the style of `src/lib/guardrails.test.ts`, because the repo has no
 * DOM test environment: what must not regress is structural (a boundary exists, the audited read is
 * outside it, the fallback holds no ticket data), and the pixels are §7's job.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SEGMENT = fileURLToPath(new URL(".", import.meta.url));

function read(file: string): string {
  return readFileSync(path.join(SEGMENT, file), "utf8");
}

const PAGE = read("page.tsx");
const LOADING = read("loading.tsx");

/** The body of the file with comments stripped, so a pattern never matches prose in a doc block. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const PAGE_CODE = code(PAGE);
const LOADING_CODE = code(LOADING);

describe("ticket detail — loading and streaming boundaries", () => {
  it("has a loading.tsx for the segment, so a client navigation paints immediately", () => {
    expect(LOADING_CODE).toMatch(/export default function \w+\(\)/);
    expect(LOADING_CODE).toContain("Skeleton");
  });

  it("renders no ticket data in the loading UI — it runs before the audited read (I3, I11)", () => {
    // No server module, no session, no params: loading.tsx cannot read and must not try.
    expect(LOADING_CODE).not.toMatch(/from "@\/server\//);
    expect(LOADING_CODE).not.toMatch(/from "@\/lib\/(session|db|audit)"/);
    expect(LOADING_CODE).not.toContain("params");
    expect(LOADING_CODE).not.toContain("await ");
  });

  it("announces the wait to a screen reader rather than only to the eye (R10)", () => {
    expect(LOADING_CODE).toMatch(/aria-busy="true"/);
    expect(LOADING_CODE).toMatch(/role="status"/);
  });

  it("wraps every self-loading panel on the page in a Suspense boundary", () => {
    expect(PAGE_CODE).toMatch(/import \{ Suspense \} from "react"/);

    for (const mount of ["<AttachmentsPanel", "<RequesterHistory"]) {
      const occurrences = PAGE_CODE.split(mount).length - 1;
      expect(occurrences).toBeGreaterThan(0);
      // Every occurrence is preceded, within the enclosing element, by a Suspense open tag.
      for (const before of PAGE_CODE.split(mount).slice(0, -1)) {
        const tail = before.slice(-200);
        expect(tail).toMatch(/<Suspense fallback=\{/);
      }
    }
  });

  it("keeps the audited read OUTSIDE every boundary — a failed TICKET_VIEWED still serves nothing (I3)", () => {
    const detailAt = PAGE_CODE.indexOf("await getTicketDetail(");
    const firstSuspenseAt = PAGE_CODE.indexOf("<Suspense");
    expect(detailAt).toBeGreaterThan(-1);
    expect(firstSuspenseAt).toBeGreaterThan(detailAt);
    // and it is still awaited before the notFound() gate, not fired and forgotten.
    expect(PAGE_CODE).toMatch(/const ticket = await getTicketDetail\([\s\S]{0,120}\n\s*if \(!ticket\) notFound\(\);/);
  });

  it("keeps the prefetch guard ahead of the read (I11)", () => {
    const prefetchAt = PAGE_CODE.indexOf("ctx.isPrefetch");
    expect(prefetchAt).toBeGreaterThan(-1);
    expect(prefetchAt).toBeLessThan(PAGE_CODE.indexOf("await getTicketDetail("));
  });

  it("gives each fallback a real size, so the column does not jump when the panel lands", () => {
    for (const m of PAGE_CODE.matchAll(/<PanelSkeleton[^/]*\/>/g)) {
      expect(m[0]).toMatch(/className="h-\d+"/);
      expect(m[0]).toMatch(/label="[^"]+"/);
    }
    expect(PAGE_CODE).toMatch(/function PanelSkeleton\(/);
  });

  it("is listed in the mobile QA checklist as a per-screen loading check", () => {
    const mobileFirst = readFileSync(
      path.join(fileURLToPath(new URL("../../../../..", import.meta.url)), "docs/MOBILE_FIRST.md"),
      "utf8",
    );
    expect(mobileFirst).toContain("G13");
    expect(mobileFirst).toMatch(/Loading state \(G13\)/);
  });
});
