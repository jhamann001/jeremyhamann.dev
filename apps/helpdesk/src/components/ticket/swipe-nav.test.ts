/**
 * Swipe navigation, as pure functions.
 *
 * The list snapshot is read from `sessionStorage`, which is a value somebody else's code (or a hostile
 * page) can put anything in, so `parseListContext` is tested as a VALIDATOR rather than as a parser.
 * The gesture thresholds are tested because "did the finger mean this" is the whole feature.
 */
import { describe, expect, it } from "vitest";
import {
  HORIZONTAL_SLOP,
  SWIPE_EXCLUDED,
  SWIPE_MAX_Y,
  SWIPE_MIN_X,
  isSwipe,
  neighbours,
  parseListContext,
  scrollsHorizontally,
  ticketIdFromPath,
} from "@/components/ticket/swipe-nav";

describe("parseListContext", () => {
  it("accepts a well-formed snapshot", () => {
    expect(parseListContext('{"href":"/dashboard?status=OPEN","ids":["a","b"]}')).toEqual({
      href: "/dashboard?status=OPEN",
      ids: ["a", "b"],
    });
  });

  it("refuses anything it did not write, rather than trusting it", () => {
    expect(parseListContext(null)).toBeNull();
    expect(parseListContext("")).toBeNull();
    expect(parseListContext("not json")).toBeNull();
    expect(parseListContext("null")).toBeNull();
    expect(parseListContext('{"href":"/x"}')).toBeNull();
    expect(parseListContext('{"href":12,"ids":[]}')).toBeNull();
    expect(parseListContext('{"href":"/x","ids":[1,2]}')).toBeNull();
  });
});

describe("neighbours", () => {
  const ids = ["a", "b", "c"];

  it("follows the order the list rendered, not the order of the ids", () => {
    expect(neighbours(ids, "b")).toEqual({ prev: "a", next: "c" });
  });

  it("has no wrap-around: the ends of the list are the ends of the list", () => {
    expect(neighbours(ids, "a")).toEqual({ prev: null, next: "b" });
    expect(neighbours(ids, "c")).toEqual({ prev: "b", next: null });
  });

  it("offers nothing for a ticket that is not in the list you came from", () => {
    expect(neighbours(ids, "zzz")).toEqual({ prev: null, next: null });
    expect(neighbours([], "a")).toEqual({ prev: null, next: null });
  });
});

describe("ticketIdFromPath", () => {
  it("reads the detail route and nothing else", () => {
    expect(ticketIdFromPath("/tickets/ckabc123")).toBe("ckabc123");
    expect(ticketIdFromPath("/tickets/ckabc123/")).toBe("ckabc123");
    expect(ticketIdFromPath("/dashboard")).toBeNull();
    expect(ticketIdFromPath("/tickets/new")).toBe("new");
    expect(ticketIdFromPath("/tickets/wm/12")).toBeNull();
  });
});

describe("isSwipe", () => {
  it("moves forward on a left swipe, back on a right one", () => {
    expect(isSwipe(-(SWIPE_MIN_X + 10), 0)).toBe("next");
    expect(isSwipe(SWIPE_MIN_X + 10, 0)).toBe("prev");
  });

  it("ignores a tap and a short drag", () => {
    expect(isSwipe(0, 0)).toBeNull();
    expect(isSwipe(SWIPE_MIN_X - 1, 0)).toBeNull();
  });

  it("ignores a scroll: a mostly vertical gesture is never a page change", () => {
    expect(isSwipe(SWIPE_MIN_X + 100, SWIPE_MAX_Y + 1)).toBeNull();
  });
});

/**
 * Fix round 2. The gesture used to fire on a horizontal drag inside a wide GFM table, so reading a
 * client's table on a 360 px phone scrolled it a little and then threw the operator onto a different
 * ticket (writing an audited TICKET_VIEWED on the way). MOBILE_FIRST R2 names exactly three sanctioned
 * element-level horizontal scrollers; all three must disarm the gesture.
 */
describe("SWIPE_EXCLUDED", () => {
  it("names every horizontal scroller MOBILE_FIRST R2 sanctions", () => {
    // R2: `[data-snap-row]`, `[data-slot=table-container]`, `[data-slot=markdown] pre|table`.
    expect(SWIPE_EXCLUDED).toContain("[data-snap-row]");
    expect(SWIPE_EXCLUDED).toContain("[data-slot=table-container]");
    expect(SWIPE_EXCLUDED).toContain("[data-slot=markdown] pre");
    expect(SWIPE_EXCLUDED).toContain("[data-slot=markdown] table");
  });

  it("names the scrollers precisely, not the whole markdown block", () => {
    // Excluding `[data-slot=markdown]` outright would disarm the gesture over the description card and
    // every comment body — most of the phone screen — to protect the rare card with a wide table.
    expect(SWIPE_EXCLUDED).not.toMatch(/\[data-slot=markdown\](?! )/);
  });

  it("keeps the form controls and sheets it already excluded", () => {
    for (const sel of ["input", "textarea", "select", "[contenteditable=true]", "[role=dialog]", "[data-slot=sheet-content]", "[data-no-swipe]"]) {
      expect(SWIPE_EXCLUDED).toContain(sel);
    }
  });
});

describe("scrollsHorizontally", () => {
  it("is true only when the box both scrolls sideways and has something to scroll", () => {
    expect(scrollsHorizontally("auto", 900, 360)).toBe(true);
    expect(scrollsHorizontally("scroll", 900, 360)).toBe(true);
    expect(scrollsHorizontally("visible", 900, 360)).toBe(false);
    expect(scrollsHorizontally("hidden", 900, 360)).toBe(false);
    expect(scrollsHorizontally("clip", 900, 360)).toBe(false);
  });

  it("ignores a scroller with nothing to scroll, so the gesture survives on an ordinary card", () => {
    expect(scrollsHorizontally("auto", 360, 360)).toBe(false);
  });

  it("tolerates sub-pixel layout rather than disarming on a box nobody can scroll", () => {
    expect(scrollsHorizontally("auto", 360 + HORIZONTAL_SLOP, 360)).toBe(false);
    expect(scrollsHorizontally("auto", 360 + HORIZONTAL_SLOP + 0.5, 360)).toBe(true);
  });
});
