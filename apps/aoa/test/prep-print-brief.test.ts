import { describe, expect, it, vi } from "vitest";
import {
  PRINT_ANCESTOR_ATTR,
  PRINT_BODY_ATTR,
  PRINT_BODY_VALUE,
  markPrintAncestors,
  printBrief,
  type PrintElement,
  type PrintHost,
} from "@/components/prep/print-brief";

// "Export PDF" is browser print-to-PDF, not a generated file (no PDF library —
// see components/prep/print-brief.ts for why). Two things are worth testing:
//   1. the ancestor walk, which is what lets a multi-page brief paginate instead
//      of being clipped inside the fixed-position slide-over; and
//   2. the stamp lifecycle — the stamps must be ON while print() runs and OFF
//      afterwards, or the next plain Cmd-P would silently print only the brief.

/** A tiny DOM stand-in: attributes in a Map, parents by reference. */
function el(parent: PrintElement | null = null) {
  const attrs = new Map<string, string>();
  const node: PrintElement & { attrs: Map<string, string> } = {
    attrs,
    parentElement: parent,
    setAttribute: (n, v) => void attrs.set(n, v),
    removeAttribute: (n) => void attrs.delete(n),
  };
  return node;
}

function fakeHost(withRoot = true) {
  const body = el(null);
  const layout = el(body);
  const backdrop = el(layout);
  const root = el(backdrop);
  const stampsDuringPrint: Record<string, boolean> = {};
  const listeners: (() => void)[] = [];
  const timeouts: (() => void)[] = [];
  const host: PrintHost = {
    body,
    printRoot: () => (withRoot ? root : null),
    print: vi.fn(() => {
      stampsDuringPrint.body = body.attrs.has(PRINT_BODY_ATTR);
      stampsDuringPrint.layout = layout.attrs.has(PRINT_ANCESTOR_ATTR);
      stampsDuringPrint.backdrop = backdrop.attrs.has(PRINT_ANCESTOR_ATTR);
      stampsDuringPrint.root = root.attrs.has(PRINT_ANCESTOR_ATTR);
    }),
    addEventListener: (_t, l) => void listeners.push(l),
    removeEventListener: (_t, l) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
    setTimeout: (h) => void timeouts.push(h),
  };
  return { host, body, layout, backdrop, root, stampsDuringPrint, listeners, timeouts };
}

describe("markPrintAncestors", () => {
  it("stamps every ancestor up to and including the body — but NOT the root", () => {
    const body = el(null);
    const layout = el(body);
    const backdrop = el(layout);
    const root = el(backdrop);
    const marked = markPrintAncestors(root, body);
    expect(marked).toEqual([backdrop, layout, body]);
    expect(root.attrs.has(PRINT_ANCESTOR_ATTR)).toBe(false);
  });

  it("stops at the body — it never walks up into <html>", () => {
    const html = el(null);
    const body = el(html);
    const root = el(body);
    markPrintAncestors(root, body);
    expect(html.attrs.has(PRINT_ANCESTOR_ATTR)).toBe(false);
  });

  it("does nothing when there is no print root (panel not mounted)", () => {
    const body = el(null);
    expect(markPrintAncestors(null, body)).toEqual([]);
    expect(body.attrs.has(PRINT_ANCESTOR_ATTR)).toBe(false);
  });

  it("terminates at the top of the tree when the root is not under stopAt", () => {
    const detachedParent = el(null);
    const root = el(detachedParent);
    const body = el(null);
    expect(markPrintAncestors(root, body)).toEqual([detachedParent]);
  });
});

describe("printBrief", () => {
  it("stamps the body AND the ancestor chain before printing", () => {
    const f = fakeHost();
    printBrief(f.host);
    expect(f.stampsDuringPrint).toEqual({
      body: true,
      layout: true,
      backdrop: true,
      root: false,
    });
    expect(f.host.print).toHaveBeenCalledTimes(1);
  });

  it("un-stamps everything on afterprint, so a later Cmd-P prints normally", () => {
    const f = fakeHost();
    printBrief(f.host);
    expect(f.body.attrs.has(PRINT_BODY_ATTR)).toBe(true);
    f.listeners[0]!();
    expect(f.body.attrs.has(PRINT_BODY_ATTR)).toBe(false);
    expect(f.body.attrs.has(PRINT_ANCESTOR_ATTR)).toBe(false);
    expect(f.layout.attrs.has(PRINT_ANCESTOR_ATTR)).toBe(false);
    expect(f.backdrop.attrs.has(PRINT_ANCESTOR_ATTR)).toBe(false);
    // …and detaches its own listener.
    expect(f.listeners).toHaveLength(0);
  });

  it("un-stamps via the timeout fallback when afterprint never fires", () => {
    const f = fakeHost();
    printBrief(f.host);
    expect(f.backdrop.attrs.has(PRINT_ANCESTOR_ATTR)).toBe(true);
    f.timeouts[0]!();
    expect(f.backdrop.attrs.has(PRINT_ANCESTOR_ATTR)).toBe(false);
    expect(f.body.attrs.has(PRINT_BODY_ATTR)).toBe(false);
  });

  it("cleans up only once when BOTH paths fire", () => {
    const f = fakeHost();
    printBrief(f.host);
    f.listeners[0]!();
    f.timeouts[0]!();
    expect(f.body.attrs.has(PRINT_BODY_ATTR)).toBe(false);
  });

  it("uses the value the stylesheet keys on", () => {
    const f = fakeHost();
    printBrief(f.host);
    expect(f.body.attrs.get(PRINT_BODY_ATTR)).toBe(PRINT_BODY_VALUE);
  });

  it("still schedules cleanup when print() throws (a blocked print dialog)", () => {
    const f = fakeHost();
    f.host.print = () => {
      throw new Error("print blocked");
    };
    expect(() => printBrief(f.host)).toThrow();
    expect(f.timeouts).toHaveLength(1);
    f.timeouts[0]!();
    expect(f.body.attrs.has(PRINT_BODY_ATTR)).toBe(false);
    expect(f.backdrop.attrs.has(PRINT_ANCESTOR_ATTR)).toBe(false);
  });
});
