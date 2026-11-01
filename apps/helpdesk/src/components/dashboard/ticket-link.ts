/**
 * The link INTO a ticket, carrying the list it was opened from (integration round 1).
 *
 * `SwipeNav` (`src/components/ticket/swipe-nav.tsx`) resolves its neighbours from three sources in
 * order: the page's props, then `?prev=&next=&back=` on the URL, then a `sessionStorage` snapshot the
 * table writes. CONTRACT §9 fixes the page's props at `null`, so the URL form is the one the contract
 * actually asks for — and every link into the ticket page lives in a component B2 does not own
 * (`ticket-card.tsx`, `ticket-preview-sheet.tsx`, `columns.tsx`). This module is the shared spelling
 * of those three parameters, so the three call sites cannot drift and `SwipeNav` has one thing to read.
 *
 * WHY THE URL AND NOT ONLY THE SNAPSHOT. The snapshot is per tab and dies with it; a link is a link.
 * Opening a ticket in a new tab, restoring a session, or following a link somebody pasted all keep the
 * gesture working, and none of them has a snapshot.
 *
 * WHAT MAY GO IN IT. Ticket IDS and a path, never a subject, a requester name or an address (I14 — a
 * query string reaches access logs and browser history). The ids are opaque cuids that a reader of the
 * log learns nothing from, and they are already in the path of the link they sit beside.
 *
 * Pure, L1, no imports: usable from a server component and a client component alike.
 */

/** The neighbours of one row in the list it was rendered from, plus where that list lives. */
export type TicketListContext = {
  /** The id of the row ABOVE this one, in the order the list is displayed. */
  prevId?: string | null;
  /** The id of the row BELOW this one. */
  nextId?: string | null;
  /**
   * Where the list itself lives, so "back to the list" keeps the filters. A path with its query
   * string, e.g. `/dashboard?status=OPEN&page=2`. Absolute URLs are refused — see `safeBack`.
   */
  backHref?: string | null;
};

/**
 * A `back` value is only ever a same-origin PATH. Anything that could navigate off-origin is dropped
 * rather than sanitised: `//host` and `/\host` are both protocol-relative in a browser, and a `back`
 * parameter is attacker-controllable the moment a link is shared. This is the same rule B10 had to
 * add to the push payload's click target, for the same reason.
 */
function safeBack(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  return value;
}

/**
 * `/tickets/<id>` with whatever list context was supplied. With no context — or a context whose
 * neighbours are all absent — it returns the bare path, so a link is never decorated with empty
 * parameters and an unchanged surface produces the exact href it produced before.
 */
export function ticketHref(id: string, ctx?: TicketListContext | null): string {
  const base = `/tickets/${encodeURIComponent(id)}`;
  if (!ctx) return base;

  const params = new URLSearchParams();
  if (typeof ctx.prevId === "string" && ctx.prevId.length > 0) params.set("prev", ctx.prevId);
  if (typeof ctx.nextId === "string" && ctx.nextId.length > 0) params.set("next", ctx.nextId);
  const back = safeBack(ctx.backHref);
  if (back !== null) params.set("back", back);

  const query = params.toString();
  return query.length === 0 ? base : `${base}?${query}`;
}

/**
 * The context for the row at `index` of `ids`. Out-of-range or unknown indexes yield a context with no
 * neighbours, which `ticketHref` renders as a bare path — a list of one is not an error.
 */
export function listContextAt(
  ids: readonly string[],
  index: number,
  backHref?: string | null,
): TicketListContext {
  return {
    prevId: index > 0 ? (ids[index - 1] ?? null) : null,
    nextId: index >= 0 ? (ids[index + 1] ?? null) : null,
    backHref: backHref ?? null,
  };
}

/** The same, found by id rather than by position. Returns no neighbours when the id is not in the list. */
export function listContextFor(
  ids: readonly string[],
  id: string,
  backHref?: string | null,
): TicketListContext {
  return listContextAt(ids, ids.indexOf(id), backHref);
}
