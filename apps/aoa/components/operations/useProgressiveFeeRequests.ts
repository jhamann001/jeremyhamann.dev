"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { OperationsFeeRequestDirectory } from "@/lib/data/operations-fee-requests";
import type { FeeRequestFilters } from "@/lib/operations/fee-request-query";
import {
  getBrowserListNavigationMemory,
  MAX_REMEMBERED_LIST_PAGES,
  type ListNavigationEntry,
} from "@/lib/navigation/list-memory";
import { appendFeeRequestRows, fetchFeeRequestPage, FeeRequestPageError } from "@/lib/operations/fee-request-pages";
import { clearListHistoryState, getListHistoryEntryId, touchListHistoryEntry } from "@/lib/navigation/history-entry";

type LoadState = "idle" | "loading" | "restoring" | "error" | "changed" | "unauthorized";
const scrollContainer = () => document.querySelector<HTMLElement>("[data-list-scroll-container]");

function clearedDirectory(value: OperationsFeeRequestDirectory): OperationsFeeRequestDirectory {
  return { ...value, rows: [], counts: { pending: 0, approved: 0, credited: 0, closed: 0, total: 0 } };
}

/** Only mounted render state contains rows. Across navigation we retain positions, not client data. */
export function useProgressiveFeeRequests(
  initial: OperationsFeeRequestDirectory,
  filters: FeeRequestFilters,
  scope: string,
  href: string,
) {
  const router = useRouter();
  const [directory, setDirectory] = useState(initial);
  const [lastPage, setLastPage] = useState(initial.page);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const expanded = useRef<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const paused = useRef(false);
  const busy = useRef(false);
  const restorePosition = useRef<ListNavigationEntry | null>(null);
  const historyEntryId = useRef<string | undefined>(undefined);
  const state = useRef({ directory, lastPage, loadState });
  state.current = { directory, lastPage, loadState };

  const savePosition = useCallback(() => {
    const current = state.current;
    if (current.loadState === "restoring" || current.loadState === "changed" || current.loadState === "unauthorized") return;
    if (current.directory.rows.length === 0 && current.directory.total > 0) return;
    const container = scrollContainer();
    if (!container || !rootRef.current) return;
    const top = container.getBoundingClientRect().top;
    const anchor = Array.from(rootRef.current.querySelectorAll<HTMLElement>("[data-request-id]"))
      .find((row) => row.getBoundingClientRect().bottom > top);
    const saved = getBrowserListNavigationMemory()?.save(scope, href, {
      firstPage: current.directory.page, lastPage: current.lastPage,
      anchorId: anchor?.dataset.requestId ?? null,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      scrollTop: container.scrollTop,
      expandedIds: expanded.current,
    }, historyEntryId.current);
    if (saved) touchListHistoryEntry(scope, href, historyEntryId.current);
  }, [scope, href]);

  const fail = useCallback((error: unknown) => {
    if (error instanceof FeeRequestPageError && error.kind === "unauthorized") {
      paused.current = true;
      controller.current?.abort();
      getBrowserListNavigationMemory()?.clear(scope);
      clearListHistoryState(scope);
      restorePosition.current = null;
      historyEntryId.current = undefined;
      const empty = { ...clearedDirectory(state.current.directory), total: 0, pageCount: 1 };
      // Invalidate synchronous scroll/unmount saves before requesting a fresh
      // authenticated render; React state commits may follow the refresh call.
      state.current = { directory: empty, lastPage: empty.page, loadState: "unauthorized" };
      setDirectory(empty);
      setLastPage(empty.page);
      setLoadState("unauthorized");
      router.refresh();
    } else if (error instanceof FeeRequestPageError && error.kind === "changed") {
      getBrowserListNavigationMemory()?.forget(scope, href, historyEntryId.current);
      // A scope/book reassignment can also change the snapshot. Do not retain
      // old request details or counts after that signal.
      setDirectory((value) => ({ ...clearedDirectory(value), total: 0, pageCount: 1 }));
      setLoadState("changed");
    } else {
      setLoadState("error");
    }
  }, [scope, href, router]);

  // On return, reauthorize and re-read every page instead of exposing cached rows
  // from a previous book/permission assignment. At most two reads run in parallel.
  const restore = useCallback(async (entry: ListNavigationEntry) => {
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    busy.current = true;
    state.current = { ...state.current, directory: clearedDirectory(state.current.directory), loadState: "restoring" };
    setLoadState("restoring");
    setDirectory(clearedDirectory);
    try {
      const first = await fetchFeeRequestPage(filters, 1, null, initial.pageSize, request.signal, scope);
      let start = Math.min(entry.firstPage, first.pageCount);
      const disappeared = start !== entry.firstPage;
      // Direct numbered URLs may have disappeared since the last visit.
      if (start !== entry.firstPage) start = 1;
      const base = start === 1 ? first : await fetchFeeRequestPage(filters, start, first.snapshot, initial.pageSize, request.signal, scope);
      const end = disappeared ? 1 : Math.min(entry.lastPage, first.pageCount, start + MAX_REMEMBERED_LIST_PAGES - 1);
      let rows = base.rows;
      for (let page = start + 1; page <= end; page += 2) {
        const pages = await Promise.all(Array.from({ length: Math.min(2, end - page + 1) }, (_, index) =>
          fetchFeeRequestPage(filters, page + index, first.snapshot, initial.pageSize, request.signal, scope)));
        for (const result of pages) rows = appendFeeRequestRows(rows, result.rows);
      }
      if (request.signal.aborted || paused.current) return;
      expanded.current = entry.expandedIds ?? [];
      setExpandedIds(expanded.current);
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
  }, [filters, initial.pageSize, scope, fail]);

  useLayoutEffect(() => {
    paused.current = false;
    setReady(true);
    const memory = getBrowserListNavigationMemory();
    memory?.setScope(scope);
    historyEntryId.current = getListHistoryEntryId(scope, href) ?? undefined;
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
  }, [scope, href, restore, savePosition]);

  useLayoutEffect(() => {
    const entry = restorePosition.current;
    if (loadState !== "idle" || !entry || !rootRef.current) return;
    restorePosition.current = null;
    const container = scrollContainer();
    if (!container) return;
    // IDs are compared as attributes, never interpolated into a CSS selector.
    const anchor = Array.from(rootRef.current.querySelectorAll<HTMLElement>("[data-request-id]"))
      .find((row) => row.dataset.requestId === entry.anchorId);
    if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - entry.anchorOffset;
    else {
      container.scrollTop = Math.min(entry.scrollTop, container.scrollHeight - container.clientHeight);
      if (entry.anchorId) setNotice("Your previous request is no longer in these results. The list has been refreshed.");
    }
    savePosition();
  }, [directory, loadState, savePosition]);

  const loadMore = useCallback(async () => {
    const current = state.current;
    if (busy.current || paused.current || current.lastPage >= current.directory.pageCount ||
      current.lastPage - current.directory.page + 1 >= MAX_REMEMBERED_LIST_PAGES ||
      !["idle", "error"].includes(current.loadState)) return;
    const request = new AbortController();
    controller.current = request;
    busy.current = true;
    setLoadState("loading");
    try {
      const next = await fetchFeeRequestPage(filters, current.lastPage + 1, current.directory.snapshot, initial.pageSize, request.signal, scope);
      if (request.signal.aborted || paused.current) return;
      const rows = appendFeeRequestRows(current.directory.rows, next.rows);
      state.current = { directory: { ...current.directory, rows }, lastPage: next.page, loadState: "idle" };
      setDirectory({ ...current.directory, rows });
      setLastPage(next.page);
      setLoadState("idle");
    } catch (error) {
      if (!request.signal.aborted && !paused.current) fail(error);
    } finally {
      if (controller.current === request) busy.current = false;
    }
  }, [filters, initial.pageSize, scope, fail]);

  const canLoadMore = lastPage < directory.pageCount && lastPage - directory.page + 1 < MAX_REMEMBERED_LIST_PAGES;
  useEffect(() => {
    if (!canLoadMore || loadState !== "idle" || !sentinelRef.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root: scrollContainer(), rootMargin: "600px 0px" });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [canLoadMore, loadState, loadMore]);

  function pause() {
    savePosition();
    paused.current = true;
    controller.current?.abort();
  }

  function rememberRequest(id: string) {
    savePosition();
    getBrowserListNavigationMemory()?.rememberReturn(scope, `/operations/fee-requests?request=${encodeURIComponent(id)}`, href, historyEntryId.current);
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

  function toggleExpanded(id: string, open: boolean) {
    expanded.current = open ? [...new Set([...expanded.current, id])].slice(-20) : expanded.current.filter((value) => value !== id);
    setExpandedIds(expanded.current);
    savePosition();
  }

  return { expandedIds, toggleExpanded, directory, lastPage, loadState, notice, ready, rootRef, sentinelRef, canLoadMore, loadMore, pause, resume, rememberRequest, retry };
}
