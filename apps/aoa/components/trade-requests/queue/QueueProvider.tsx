"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchTradeRequestPage } from "@/lib/trade-requests/queue-fetch";
import {
  DEFAULT_QUEUE_SORT, QUEUE_POLL_INTERVAL_MS, QUEUE_SEARCH_DELAY_MS, nextQueueSort,
  type QueueSort, type QueueSortKey, type TradeRequestListEntry,
} from "@/lib/trade-requests/queue-model";

export type TradeRequestsQueueState = {
  entries: TradeRequestListEntry[];
  /** True until the first load settles while nothing is listed. */
  loading: boolean;
  error: string | null;
  notSetUp: boolean;
  /** The AOA session or role ended: nothing is listed and nothing refreshes. */
  signedOut: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  searchInput: string;
  sort: QueueSort;
};

export type TradeRequestsQueue = TradeRequestsQueueState & {
  setSearchInput: (value: string) => void;
  sortBy: (key: QueueSortKey) => void;
  retry: () => void;
  loadMore: () => void;
};

const QueueContext = createContext<TradeRequestsQueue | null>(null);

function sameList(a: TradeRequestListEntry[], b: TradeRequestListEntry[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry.id === b[i].id && entry.updatedAt === b[i].updatedAt);
}

// Workspace-level list state: the loaded pages, search and sort survive moving
// between workspace views, and the list refreshes while the workspace is open.
const SESSION_RELOAD_KEY = "trade-requests:session-ended-reload";
const SESSION_RELOAD_WINDOW_MS = 10_000;

// One reload per 10 s: if the reloaded page still ends the session (e.g. the
// server still renders the workspace), the sign-in prompt stays instead of a
// reload loop. Without storage there is no guard, so no reload.
function claimSessionReload(): boolean {
  try {
    const now = Date.now();
    const last = Number(window.sessionStorage.getItem(SESSION_RELOAD_KEY));
    if (Number.isFinite(last) && now - last >= 0 && now - last < SESSION_RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(SESSION_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

export function TradeRequestsQueueProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<TradeRequestListEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notSetUp, setNotSetUp] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<QueueSort>(DEFAULT_QUEUE_SORT);

  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const refreshing = useRef(false);
  const paginating = useRef(false);
  const hasData = useRef(false);
  const stopped = useRef(false);
  const searchRef = useRef(search);
  const cursorRef = useRef(nextCursor);

  useEffect(() => {
    cursorRef.current = nextCursor;
  }, [nextCursor]);

  const begin = useCallback(() => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    seq.current += 1;
    return { id: seq.current, signal: next.signal };
  }, []);

  // Never keep firm-wide rows on screen once the session or role is gone; the
  // reload lets middleware send the browser to sign-in (or the layout show the
  // permission screen).
  const endSession = useCallback(() => {
    stopped.current = true;
    controller.current?.abort();
    seq.current += 1;
    refreshing.current = false;
    paginating.current = false;
    hasData.current = false;
    cursorRef.current = null;
    setEntries([]);
    setNextCursor(null);
    setError(null);
    setLoading(false);
    setLoadingMore(false);
    setSignedOut(true);
    if (claimSessionReload()) window.location.reload();
  }, []);

  // `supersede` (search change, Retry) replaces any load in flight; the
  // schedule and tab visibility skip while one is running.
  const refresh = useCallback(async (supersede: boolean) => {
    if (stopped.current || (!supersede && (refreshing.current || paginating.current))) return;
    const { id, signal } = begin();
    refreshing.current = true;
    paginating.current = false;
    setLoadingMore(false);
    if (!hasData.current) setLoading(true);
    try {
      const result = await fetchTradeRequestPage({ q: searchRef.current }, signal);
      if (id !== seq.current) return;
      if (result.ok) {
        setEntries((prev) => (sameList(prev, result.data.data) ? prev : result.data.data));
        setNextCursor(result.data.nextCursor);
        cursorRef.current = result.data.nextCursor;
        setError(null);
        setNotSetUp(false);
        hasData.current = true;
      } else if (result.outcome === "signed_out") {
        endSession();
        return;
      } else if (result.outcome === "not_set_up") {
        setNotSetUp(true);
      } else {
        setError(result.message);
      }
    } catch {
      // Aborted by a newer load.
    } finally {
      if (id === seq.current) {
        refreshing.current = false;
        setLoading(false);
      }
    }
  }, [begin, endSession]);

  const loadMore = useCallback(async () => {
    const before = cursorRef.current;
    if (stopped.current || !before || paginating.current || refreshing.current) return;
    const { id, signal } = begin();
    paginating.current = true;
    setLoadingMore(true);
    try {
      const result = await fetchTradeRequestPage({ before, q: searchRef.current }, signal);
      if (id !== seq.current) return;
      if (result.ok) {
        setEntries((prev) => [...prev, ...result.data.data]);
        setNextCursor(result.data.nextCursor);
        cursorRef.current = result.data.nextCursor;
      } else if (result.outcome === "signed_out") {
        endSession();
        return;
      } else if (result.outcome === "not_set_up") {
        setNotSetUp(true);
      } else {
        setError(result.message);
      }
    } catch {
      // Aborted by a newer load.
    } finally {
      if (id === seq.current) {
        paginating.current = false;
        setLoadingMore(false);
      }
    }
  }, [begin, endSession]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), QUEUE_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    searchRef.current = search;
    void refresh(true);
  }, [search, refresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refresh(false);
    }, QUEUE_POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (!document.hidden) void refresh(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  useEffect(() => () => controller.current?.abort(), []);

  const value = useMemo<TradeRequestsQueue>(() => ({
    entries, loading, error, notSetUp, signedOut, loadingMore, searchInput, sort,
    hasMore: nextCursor != null && nextCursor !== "",
    setSearchInput,
    sortBy: (key) => setSort((current) => nextQueueSort(current, key)),
    retry: () => void refresh(true),
    loadMore: () => void loadMore(),
  }), [entries, loading, error, notSetUp, signedOut, loadingMore, searchInput, sort, nextCursor, refresh, loadMore]);

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useTradeRequestsQueue(): TradeRequestsQueue {
  const queue = useContext(QueueContext);
  if (!queue) throw new Error("useTradeRequestsQueue must be used inside TradeRequestsQueueProvider");
  return queue;
}

/** The list entry already loaded for a request, so opening it from the queue needs no separate load. */
export function useTradeRequestQueueEntry(id: string | null): TradeRequestListEntry | undefined {
  const queue = useContext(QueueContext);
  return id === null ? undefined : queue?.entries.find((entry) => entry.id === id);
}
