"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import {
  getBrowserListNavigationMemory,
  MAX_REMEMBERED_LIST_PAGES,
  type ListNavigationEntry,
} from "@/lib/navigation/list-memory";
import { appendProgressiveRows, fetchProgressivePage, ProgressivePageError, type ProgressivePage } from "@/lib/navigation/progressive-page";
import { clearListHistoryState, getListHistoryEntryId, touchListHistoryEntry } from "@/lib/navigation/history-entry";

type LoadState = "idle" | "loading" | "restoring" | "error" | "changed" | "unauthorized";

export type ProgressiveLoadState = LoadState;

/** Fresh authenticated reads rebuild remembered ranges; only positions survive unmount. */
export function useProgressiveList<Row extends object, Meta extends object>({
  initialPage: initial, scope, href, endpoint, rowIdKey, emptyMeta,
  historyHref = href, scrollSelector = "[data-list-scroll-container]",
}: {
  initialPage: ProgressivePage<Row, Meta>;
  scope: string;
  href: string;
  endpoint: string;
  rowIdKey: keyof Row;
  emptyMeta: Meta;
  /** Nested card lists share the actual page's occurrence, not competing tokens. */
  historyHref?: string;
  /** Static code-owned selector for a nested list's independent scroll owner. */
  scrollSelector?: string;
}) {
  const scrollContainer = useCallback(() => document.querySelector<HTMLElement>(scrollSelector), [scrollSelector]);
  const maxPages = Math.min(MAX_REMEMBERED_LIST_PAGES, Math.floor(5_000 / initial.pageSize));
  const clearedDirectory = useCallback((value: ProgressivePage<Row, Meta>): ProgressivePage<Row, Meta> =>
    ({ ...value, rows: [], meta: emptyMeta }), [emptyMeta]);
  const router = useRouter();
  const [directory, setDirectory] = useState(initial);
  const [lastPage, setLastPage] = useState(initial.page);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [expandedIds, setExpandedState] = useState<string[]>([]);
  const expandedRef = useRef<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const paused = useRef(false);
  const busy = useRef(false);
  const restorePosition = useRef<ListNavigationEntry | null>(null);
  const historyEntryId = useRef<string | undefined>(undefined);
  const historyBinding = useRef<{ scope: string; href: string; entryId: string | undefined } | null>(null);
  const resolveHistoryEntry = useCallback(() => {
    const prior = historyBinding.current;
    const entryId = getListHistoryEntryId(scope, historyHref,
      prior?.scope === scope && prior.href === historyHref ? prior.entryId : undefined) ?? undefined;
    historyBinding.current = { scope, href: historyHref, entryId };
    historyEntryId.current = entryId;
    return entryId;
  }, [scope, historyHref]);
  const state = useRef({ directory, lastPage, loadState });
  const serverRows = useRef(initial.rows);
  state.current = { directory, lastPage, loadState };

  const savePosition = useCallback(() => {
    const current = state.current;
    if (current.loadState === "restoring" || current.loadState === "changed" || current.loadState === "unauthorized") return;
    if (current.directory.rows.length === 0 && current.directory.total > 0) return;
    const container = scrollContainer();
    if (!container || !rootRef.current) return;
    const top = container.getBoundingClientRect().top;
    const anchor = Array.from(rootRef.current.querySelectorAll<HTMLElement>("[data-list-row-id]"))
      .find((row) => row.getBoundingClientRect().bottom > top);
    const saved = getBrowserListNavigationMemory()?.save(scope, href, {
      firstPage: current.directory.page, lastPage: current.lastPage,
      anchorId: anchor?.dataset.listRowId ?? null,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      scrollTop: container.scrollTop,
      expandedIds: expandedRef.current,
    }, historyEntryId.current);
    if (saved) touchListHistoryEntry(scope, historyHref, historyEntryId.current);
  }, [scope, href, historyHref, scrollContainer]);

  const fail = useCallback((error: unknown) => {
    if (error instanceof ProgressivePageError && error.kind === "unauthorized") {
      paused.current = true;
      controller.current?.abort();
      getBrowserListNavigationMemory()?.clear(scope);
      clearListHistoryState(scope);
      restorePosition.current = null;
      historyEntryId.current = undefined;
      historyBinding.current = null;
      const empty = { ...clearedDirectory(state.current.directory), total: 0, pageCount: 1 };
      // Invalidate synchronous scroll/unmount saves before requesting a fresh
      // authenticated render; React state commits may follow the refresh call.
      state.current = { directory: empty, lastPage: empty.page, loadState: "unauthorized" };
      setDirectory(empty);
      setLastPage(empty.page);
      setLoadState("unauthorized");
      router.refresh();
    } else if (error instanceof ProgressivePageError && error.kind === "changed") {
      getBrowserListNavigationMemory()?.forget(scope, href, historyEntryId.current);
      // A scope/book reassignment can also change the snapshot. Do not retain
      // old summaries, advisor options or balances after that signal.
      const empty = { ...clearedDirectory(state.current.directory), total: 0, pageCount: 1 };
      state.current = { directory: empty, lastPage: empty.page, loadState: "changed" };
      restorePosition.current = null;
      setDirectory(empty);
      setLastPage(empty.page);
      setLoadState("changed");
    } else {
      setLoadState("error");
    }
  }, [scope, href, router, clearedDirectory]);

  // On return, reauthorize and re-read every page instead of exposing cached rows
  // from a previous book/permission assignment. At most two reads run in parallel.
  const restore = useCallback(async (entry: ListNavigationEntry) => {
    expandedRef.current = entry.expandedIds ?? [];
    setExpandedState(expandedRef.current);
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    busy.current = true;
    state.current = { ...state.current, directory: clearedDirectory(state.current.directory), loadState: "restoring" };
    setLoadState("restoring");
    setDirectory(clearedDirectory);
    try {
      const first = await fetchProgressivePage<Row, Meta>(endpoint, 1, initial.pageSize, null, request.signal, scope, rowIdKey);
      let start = Math.min(entry.firstPage, first.pageCount);
      const disappeared = start !== entry.firstPage;
      // Direct numbered URLs may have disappeared since the last visit.
      if (start !== entry.firstPage) start = 1;
      const base = start === 1 ? first : await fetchProgressivePage<Row, Meta>(endpoint, start, initial.pageSize, first.snapshot, request.signal, scope, rowIdKey);
      const end = disappeared ? 1 : Math.min(entry.lastPage, first.pageCount, start + maxPages - 1);
      let rows = base.rows;
      for (let page = start + 1; page <= end; page += 2) {
        const pages = await Promise.all(Array.from({ length: Math.min(2, end - page + 1) }, (_, index) =>
          fetchProgressivePage<Row, Meta>(endpoint, page + index, initial.pageSize, first.snapshot, request.signal, scope, rowIdKey)));
        for (const result of pages) rows = appendProgressiveRows(rows, result.rows, rowIdKey);
      }
      if (request.signal.aborted || paused.current) return;
      restorePosition.current = entry;
      state.current = { directory: { ...base, rows }, lastPage: end, loadState: "idle" };
      setDirectory({ ...base, rows });
      setLastPage(end);
      setLoadState("idle");
    } catch (error) {
      if (!request.signal.aborted && !paused.current) fail(error);
    } finally {
      if (controller.current === request) busy.current = false;
    }
  }, [endpoint, initial.pageSize, scope, fail, rowIdKey, maxPages, clearedDirectory]);

  useLayoutEffect(() => {
    paused.current = false;
    setReady(true);
    const memory = getBrowserListNavigationMemory();
    memory?.setScope(scope);
    resolveHistoryEntry();
    const entry = memory?.read(scope, href, historyEntryId.current);
    if (entry) void restore(entry);
    else scrollContainer()?.scrollTo({ top: 0 });
    const container = scrollContainer();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (!timer) timer = setTimeout(() => { timer = undefined; savePosition(); }, 200);
    };
    container?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", savePosition);
    return () => {
      savePosition();
      paused.current = true;
      controller.current?.abort();
      if (timer) clearTimeout(timer);
      container?.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", savePosition);
    };
  }, [scope, href, historyHref, restore, savePosition, scrollContainer, resolveHistoryEntry]);

  // router.refresh may return the same query/snapshot without remounting this
  // client component. A newly delivered server array is a fresh authorized
  // result, not the mounted list's append state. Recover after a transient auth
  // failure (and adopt mutation revalidation) instead of remaining denied.
  // Adapters must pass the server rows directly, not map them on every render.
  useLayoutEffect(() => {
    if (serverRows.current === initial.rows) return;
    serverRows.current = initial.rows;
    controller.current?.abort();
    busy.current = false;
    paused.current = false;
    restorePosition.current = null;
    const memory = getBrowserListNavigationMemory();
    memory?.setScope(scope);
    resolveHistoryEntry();
    const entry = memory?.read(scope, href, historyEntryId.current);
    if (entry) void restore(entry);
    else {
      state.current = { directory: initial, lastPage: initial.page, loadState: "idle" };
      setDirectory(initial);
      setLastPage(initial.page);
      setLoadState("idle");
      setNotice("");
    }
  }, [initial, scope, href, historyHref, restore, resolveHistoryEntry]);

  useLayoutEffect(() => {
    const entry = restorePosition.current;
    if (loadState !== "idle" || !entry || !rootRef.current) return;
    restorePosition.current = null;
    const container = scrollContainer();
    if (!container) return;
    // IDs are compared as attributes, never interpolated into a CSS selector.
    const anchor = Array.from(rootRef.current.querySelectorAll<HTMLElement>("[data-list-row-id]"))
      .find((row) => row.dataset.listRowId === entry.anchorId);
    if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - entry.anchorOffset;
    else {
      container.scrollTop = Math.min(entry.scrollTop, container.scrollHeight - container.clientHeight);
      if (entry.anchorId) setNotice("Your previous record is no longer in these results. The list has been refreshed.");
    }
    savePosition();
  }, [directory, loadState, savePosition, scrollContainer]);

  const loadMore = useCallback(async () => {
    const current = state.current;
    if (busy.current || paused.current || current.lastPage >= current.directory.pageCount ||
      current.lastPage - current.directory.page + 1 >= maxPages ||
      !["idle", "error"].includes(current.loadState)) return;
    const request = new AbortController();
    controller.current = request;
    busy.current = true;
    setLoadState("loading");
    try {
      const next = await fetchProgressivePage<Row, Meta>(endpoint, current.lastPage + 1, initial.pageSize, current.directory.snapshot, request.signal, scope, rowIdKey);
      if (request.signal.aborted || paused.current) return;
      const rows = appendProgressiveRows(current.directory.rows, next.rows, rowIdKey);
      state.current = { directory: { ...current.directory, rows }, lastPage: next.page, loadState: "idle" };
      setDirectory({ ...current.directory, rows });
      setLastPage(next.page);
      setLoadState("idle");
    } catch (error) {
      if (!request.signal.aborted && !paused.current) fail(error);
    } finally {
      if (controller.current === request) busy.current = false;
    }
  }, [endpoint, initial.pageSize, scope, fail, rowIdKey, maxPages]);

  const canLoadMore = lastPage < directory.pageCount && lastPage - directory.page + 1 < maxPages;
  useEffect(() => {
    if (!canLoadMore || loadState !== "idle" || !sentinelRef.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root: scrollContainer(), rootMargin: "600px 0px" });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [canLoadMore, loadState, loadMore, scrollContainer]);

  function pause() {
    savePosition();
    paused.current = true;
    controller.current?.abort();
  }

  function rememberReturn(detailHref: string) {
    savePosition();
    getBrowserListNavigationMemory()?.rememberReturn(scope, detailHref, href, historyEntryId.current);
  }

  function retry() {
    paused.current = false;
    if (directory.rows.length > 0) void loadMore();
    else void restore(getBrowserListNavigationMemory()?.read(scope, href, historyEntryId.current) ?? {
      href, savedAt: Date.now(), firstPage: 1, lastPage: 1, anchorId: null, anchorOffset: 0, scrollTop: 0,
    });
  }

  function resume() {
    paused.current = false;
    busy.current = false;
    if (state.current.directory.rows.length === 0 && state.current.directory.total > 0) retry();
    else setLoadState("idle");
  }

  const setExpandedIds = useCallback((value: SetStateAction<string[]>) => {
    const next = typeof value === "function" ? value(expandedRef.current) : value;
    expandedRef.current = [...new Set(next.filter(id => /^[A-Za-z0-9_.:-]{1,192}$/.test(id)))].slice(-20);
    setExpandedState(expandedRef.current);
    savePosition();
  }, [savePosition]);

  const invalidateAuthorization = useCallback(() => fail(new ProgressivePageError("unauthorized")), [fail]);
  const invalidateSnapshot = useCallback(() => fail(new ProgressivePageError("changed")), [fail]);
  return { page: directory, lastPage, loadState, notice, ready, rootRef, sentinelRef,
    canLoadMore, loadMore, pause, resume, rememberReturn, retry, expandedIds, setExpandedIds,
    invalidateAuthorization, invalidateSnapshot };

}
