/**
 * The ONE URL writer and the ONE URL reader for `/inbox`.
 *
 * Pure, so the server page and the client view derive the same href from the same state and the
 * filter chips, the "Load more" link and a bookmarked URL can never disagree. Multi-value keys are
 * not needed here — the kind filter is single-select, which is what a 360 px chip row can carry —
 * but the reader still tolerates a repeated key by taking the first, exactly as convention 12's
 * readers do.
 */
import type { InboxPage, NotificationDTO, NotificationKind } from "@/types/domain";
import { NOTIFICATION_KINDS } from "@/types/domain";
import { startOfFirmDay } from "@/lib/firm-time";

export type InboxFilters = {
  kind: NotificationKind | undefined;
  unreadOnly: boolean;
  cursor: string | undefined;
};

export type SearchParamsLike = Record<string, string | string[] | undefined>;

function first(sp: SearchParamsLike, key: string): string | undefined {
  const raw = sp[key];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export function parseInboxFilters(sp: SearchParamsLike): InboxFilters {
  const kindRaw = first(sp, "kind");
  const kind = NOTIFICATION_KINDS.find((k) => k === kindRaw);
  const cursor = first(sp, "cursor");
  return {
    kind,
    // Unread-only is the DEFAULT view: the inbox is a work list, and a work list that opens on
    // everything you have ever been told is a list nobody uses twice. `?unread=0` is how you widen it.
    unreadOnly: first(sp, "unread") !== "0",
    cursor: cursor === undefined || cursor === "" ? undefined : cursor,
  };
}

/** `/inbox?…`. A cursor is dropped whenever the filter changes — a new filter is a new result set. */
export function inboxHref(filters: Partial<InboxFilters> & { unreadOnly: boolean }): string {
  const params = new URLSearchParams();
  if (filters.kind !== undefined) params.set("kind", filters.kind);
  if (!filters.unreadOnly) params.set("unread", "0");
  if (filters.cursor !== undefined) params.set("cursor", filters.cursor);
  const qs = params.toString();
  return qs.length > 0 ? `/inbox?${qs}` : "/inbox";
}

// ---------------------------------------------------------------------------
// Accumulated pages
// ---------------------------------------------------------------------------

/** One RSC-rendered page, keyed by the cursor that produced it (the `HeldIntakeView` recipe). */
export type Chunk = { cursor: string | undefined; rows: NotificationDTO[] };
export type Accumulated = { baseKey: string; page: InboxPage; chunks: Chunk[] };

/**
 * Keeps the pages already on screen when the server hands down the next one, so "Load more" grows
 * the list instead of replacing it. PURE, because the reconciliation runs during render — and pure
 * is also what lets it be tested without mounting anything.
 */
export function mergePage(
  prev: Accumulated | null,
  page: InboxPage,
  cursor: string | undefined,
  baseKey: string,
): Accumulated {
  const chunk: Chunk = { cursor, rows: page.rows };
  if (prev === null || prev.baseKey !== baseKey) return { baseKey, page, chunks: [chunk] };

  const existing = prev.chunks.findIndex((c) => c.cursor === cursor);
  if (existing >= 0) {
    // The same cursor rendered again (a router.refresh after "Mark all read", or a Back navigation):
    // replace that page in place so the rows' new read state is the one on screen.
    const chunks = prev.chunks.slice();
    chunks[existing] = chunk;
    return { baseKey, page, chunks };
  }
  const last = prev.chunks[prev.chunks.length - 1];
  if (cursor !== undefined && last !== undefined && prev.page.nextCursor === cursor) {
    return { baseKey, page, chunks: [...prev.chunks, chunk] };
  }
  // A cursor that does not continue what is on screen (a pasted or stale URL): start from that page.
  return { baseKey, page, chunks: [chunk] };
}

export function flattenRows(chunks: Chunk[]): NotificationDTO[] {
  const seen = new Set<string>();
  const out: NotificationDTO[] = [];
  for (const chunk of chunks) {
    for (const row of chunk.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

/**
 * Today / Earlier, on the FIRM clock.
 *
 * Two groups and not seven: an inbox is triage, and "Today" versus "before today" is the only cut
 * that changes what someone does next. The boundary is midnight in America/New_York wherever the
 * code runs, so a row cannot change group between the server render and the client one.
 */
export function groupRows(
  rows: readonly NotificationDTO[],
  now: Date = new Date(),
): { today: NotificationDTO[]; earlier: NotificationDTO[] } {
  const boundary = startOfFirmDay(now).getTime();
  const today: NotificationDTO[] = [];
  const earlier: NotificationDTO[] = [];
  for (const row of rows) {
    const at = new Date(row.createdAt).getTime();
    if (!Number.isNaN(at) && at >= boundary) today.push(row);
    else earlier.push(row);
  }
  return { today, earlier };
}
