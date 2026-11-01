"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Swipe to the next ticket (MOBILE_FIRST).
 *
 * The order followed is the order the operator was actually looking at — the list they arrived from,
 * not "the next ticket by id". Three sources, in this order:
 *
 *  1. **The props.** `prevHref` / `nextHref`, when the page computes them. The foundation's mount
 *     passes `null` for both (the props are the contract), so today this is the future path.
 *  2. **The URL.** `?prev=<id>&next=<id>` on the ticket link, which is the contract's "list context in
 *     the URL". Any surface that links to a ticket can add them without importing anything.
 *  3. **The list snapshot** this session's dashboard wrote (`TICKET_LIST_CONTEXT_KEY`). This is what
 *     makes the gesture work TODAY: the links into the ticket page live in unowned components
 *     (`ticket-card.tsx`, `ticket-preview-sheet.tsx`), so B2 cannot put the parameters on them. See
 *     the build record.
 *
 * Both ends are ORDINARY NAVIGATIONS. A swipe produces exactly the same audited `TICKET_VIEWED` as a
 * tap and never a silent prefetch — `router.push`, no `prefetch`, no speculative fetch of
 * the ticket either side.
 *
 * A VISIBLE AFFORDANCE is mandatory (MOBILE_FIRST: a gesture nobody can see is a feature nobody finds),
 * so the two buttons are the primary control and the gesture is the shortcut. `prefers-reduced-motion`
 * removes the transition on the affordance; the navigation itself is unchanged, because a person who
 * has asked for less motion still wants the next ticket.
 */
export type SwipeNavProps = { prevHref: string | null; nextHref: string | null };

/** sessionStorage key the dashboard's table writes and this component reads. Per tab, never persisted. */
export const TICKET_LIST_CONTEXT_KEY = "wmhd.ticket-list-context" as const;

export type TicketListContext = {
  /** Where the list itself lives, so "back to the list" keeps the filters. */
  href: string;
  /** Ticket ids, in the order the list rendered them. */
  ids: string[];
};

/** Pure: read and validate the snapshot. Exported for the test; returns null on anything unexpected. */
export function parseListContext(raw: string | null): TicketListContext | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { href, ids } = parsed as { href?: unknown; ids?: unknown };
    if (typeof href !== "string") return null;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return null;
    return { href, ids: ids as string[] };
  } catch {
    return null;
  }
}

/** Pure: the ids either side of `currentId` in the list, or nulls. Exported for the test. */
export function neighbours(ids: readonly string[], currentId: string): { prev: string | null; next: string | null } {
  const i = ids.indexOf(currentId);
  if (i < 0) return { prev: null, next: null };
  return { prev: ids[i - 1] ?? null, next: ids[i + 1] ?? null };
}

/** `/tickets/<id>` → `<id>`. Pure. */
export function ticketIdFromPath(pathname: string): string | null {
  const m = /^\/tickets\/([^/]+)\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

/** A swipe, not a scroll and not a tap: mostly horizontal, far enough to be deliberate. */
export const SWIPE_MIN_X = 72;
export const SWIPE_MAX_Y = 48;

export function isSwipe(dx: number, dy: number): "prev" | "next" | null {
  if (Math.abs(dy) > SWIPE_MAX_Y) return null;
  if (Math.abs(dx) < SWIPE_MIN_X) return null;
  // Swiping LEFT (negative dx) moves forward, matching every list-detail pager on a phone.
  return dx < 0 ? "next" : "prev";
}

/**
 * Gestures that start inside a sheet, a form control or a horizontally scrolling region are not ours.
 *
 * Fix round 2. The docstring always claimed the scrolling regions; the selector did not list them, and
 * `data-no-swipe` was never set on anything in the app. MOBILE_FIRST R2 sanctions exactly three
 * element-level horizontal scrollers and two of them are on THIS page — `[data-slot=markdown] pre` and
 * `[data-slot=markdown] table` (the description card and every comment body). Reading a wide GFM table
 * on a 360 px phone is a ~72 px horizontal drag with almost no vertical movement, which is the swipe
 * gesture exactly: the operator was thrown onto a different ticket, writing an audited `TICKET_VIEWED`
 * on the way, for trying to read a client's table. §7's own ticket-detail check ("the card scrolls
 * internally") and this gesture were in direct conflict.
 *
 * The three R2 scrollers are named here as the declared floor, and named PRECISELY — `[data-slot=markdown]
 * pre|table`, not the whole `[data-slot=markdown]` block. Excluding the block would disarm the gesture
 * over the description card and every comment body, which is most of the phone screen, to protect the
 * rare card that actually holds a wide table. `startsInHorizontalScroller` below is the general rule
 * behind the floor: ANY ancestor that is actually scrolling sideways disarms the gesture, so a scroller
 * added later needs no entry here at all.
 */
export const SWIPE_EXCLUDED =
  "input,textarea,select,[contenteditable=true],[role=dialog],[data-slot=sheet-content],[data-no-swipe]," +
  "[data-slot=markdown] pre,[data-slot=markdown] table,[data-slot=table-container],[data-snap-row]";

/** Sub-pixel layout routinely leaves scrollWidth a fraction above clientWidth on a box nobody can scroll. */
export const HORIZONTAL_SLOP = 1;

/**
 * True when this element is itself scrolling sideways: its own `overflow-x` scrolls AND it has more
 * content than box. Both halves matter — an `overflow-x: auto` box with nothing to scroll is not a
 * scroller, and taking the gesture away from it would disable the shortcut on most of the page.
 *
 * Pure, and the computed style is passed in rather than read here, so it is testable without a DOM.
 */
export function scrollsHorizontally(overflowX: string, scrollWidth: number, clientWidth: number): boolean {
  if (overflowX !== "auto" && overflowX !== "scroll") return false;
  return scrollWidth > clientWidth + HORIZONTAL_SLOP;
}

/** Walks target → body looking for a live horizontal scroller. Returns false when there is no view. */
function startsInHorizontalScroller(target: Element): boolean {
  const view = target.ownerDocument.defaultView;
  if (view === null) return false;
  for (let el: Element | null = target; el !== null; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    if (scrollsHorizontally(style.overflowX, el.scrollWidth, el.clientWidth)) return true;
  }
  return false;
}

export function SwipeNav({ prevHref, nextHref }: SwipeNavProps): React.JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [fromStorage, setFromStorage] = useState<TicketListContext | null>(null);

  const currentId = ticketIdFromPath(pathname ?? "");

  useEffect(() => {
    try {
      setFromStorage(parseListContext(window.sessionStorage.getItem(TICKET_LIST_CONTEXT_KEY)));
    } catch {
      // Private mode, blocked storage, or a hostile value: the buttons simply do not appear.
      setFromStorage(null);
    }
  }, [currentId]);

  const resolved = useMemo(() => {
    if (prevHref !== null || nextHref !== null) return { prev: prevHref, next: nextHref, back: null as string | null };

    const urlPrev = search?.get("prev") ?? null;
    const urlNext = search?.get("next") ?? null;
    if (urlPrev !== null || urlNext !== null) {
      return {
        prev: urlPrev === null ? null : `/tickets/${encodeURIComponent(urlPrev)}`,
        next: urlNext === null ? null : `/tickets/${encodeURIComponent(urlNext)}`,
        back: search?.get("back") ?? null,
      };
    }

    if (fromStorage === null || currentId === null) return { prev: null, next: null, back: null };
    const { prev, next } = neighbours(fromStorage.ids, currentId);
    return {
      prev: prev === null ? null : `/tickets/${encodeURIComponent(prev)}`,
      next: next === null ? null : `/tickets/${encodeURIComponent(next)}`,
      back: fromStorage.href,
    };
  }, [prevHref, nextHref, search, fromStorage, currentId]);

  const go = useCallback(
    (href: string | null) => {
      if (href === null) return;
      router.push(href);
    },
    [router],
  );

  useEffect(() => {
    if (resolved.prev === null && resolved.next === null) return;
    let startX = 0;
    let startY = 0;
    let armed = false;

    function onStart(e: TouchEvent): void {
      const touch = e.touches[0];
      if (e.touches.length !== 1 || touch === undefined) {
        armed = false;
        return;
      }
      const target = e.target;
      armed = !(
        target instanceof Element &&
        (target.closest(SWIPE_EXCLUDED) !== null || startsInHorizontalScroller(target))
      );
      startX = touch.clientX;
      startY = touch.clientY;
    }
    function onEnd(e: TouchEvent): void {
      if (!armed) return;
      armed = false;
      const touch = e.changedTouches[0];
      if (touch === undefined) return;
      const direction = isSwipe(touch.clientX - startX, touch.clientY - startY);
      if (direction === "next") go(resolved.next);
      if (direction === "prev") go(resolved.prev);
    }

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, [resolved, go]);

  if (resolved.prev === null && resolved.next === null) return null;

  return (
    <nav
      aria-label="Adjacent tickets in the list you came from"
      data-slice="B2-swipe-nav"
      className="flex items-center gap-2 md:hidden"
    >
      <Button
        type="button"
        variant="outline"
        className="min-h-11 flex-1 transition-transform motion-reduce:transition-none active:scale-[0.98] motion-reduce:active:scale-100"
        disabled={resolved.prev === null}
        onClick={() => go(resolved.prev)}
      >
        <ChevronLeft aria-hidden />
        Previous
      </Button>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 flex-1 transition-transform motion-reduce:transition-none active:scale-[0.98] motion-reduce:active:scale-100"
        disabled={resolved.next === null}
        onClick={() => go(resolved.next)}
      >
        Next
        <ChevronRight aria-hidden />
      </Button>
      <span className="sr-only">Swipe left or right anywhere on this page to move between tickets.</span>
    </nav>
  );
}
