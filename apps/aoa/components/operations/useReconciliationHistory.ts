"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReconciliationHistoryPage } from "@/lib/data/reconciliation-history";
import { getBrowserListNavigationMemory, MAX_REMEMBERED_LIST_PAGES, type ListNavigationEntry } from "@/lib/navigation/list-memory";
import { clearListHistoryState, getListHistoryEntryId, touchListHistoryEntry } from "@/lib/navigation/history-entry";
import { appendReconciliationHistory, fetchReconciliationHistory, ReconciliationHistoryError } from "@/lib/navigation/reconciliation-history-pages";
import { reconciliationHref, type ReconciliationHistoryView } from "@/lib/operations/reconciliation-history-query";

type Status = "loading" | "idle" | "error" | "changed" | "unauthorized";
const scrollContainer = () => document.querySelector<HTMLElement>("[data-list-scroll-container]");

export function useReconciliationHistory(view: ReconciliationHistoryView, scope: string, href: string) {
  const router = useRouter();
  const [page, setPage] = useState<ReconciliationHistoryPage | null>(null);
  const [lastPage, setLastPage] = useState(1);
  const [status, setStatus] = useState<Status>("loading");
  const [notice, setNotice] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const entryId = useRef<string | undefined>(undefined);
  const selectedRun = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const restoring = useRef<ListNavigationEntry | null>(null);
  const state = useRef({ page, lastPage, status });
  state.current = { page, lastPage, status };

  const save = useCallback(() => {
    const current = state.current;
    const container = scrollContainer();
    if (!current.page || !container || !rootRef.current || !["idle", "error"].includes(current.status)) return;
    const top = container.getBoundingClientRect().top;
    const anchor = Array.from(rootRef.current.querySelectorAll<HTMLElement>("[data-history-id]"))
      .find((row) => row.getBoundingClientRect().bottom > top);
    if (getBrowserListNavigationMemory()?.save(scope, href, {
      firstPage: current.page.page, lastPage: current.lastPage, anchorId: anchor?.dataset.historyId ?? null,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - top : 0, scrollTop: container.scrollTop,
      expandedIds: selectedRun.current ? [selectedRun.current] : [],
    }, entryId.current)) touchListHistoryEntry(scope, href, entryId.current);
  }, [scope, href]);

  const fail = useCallback((error: unknown) => {
    const kind = error instanceof ReconciliationHistoryError ? error.kind : "unavailable";
    if (kind === "unauthorized") {
      getBrowserListNavigationMemory()?.clear(scope);
      clearListHistoryState(scope);
      state.current = { page: null, lastPage: 1, status: "unauthorized" };
      setPage(null); setStatus("unauthorized");
      router.refresh();
    } else if (kind === "changed") {
      getBrowserListNavigationMemory()?.forget(scope, href, entryId.current);
      state.current = { page: null, lastPage: 1, status: "changed" };
      setPage(null); setStatus("changed");
    } else setStatus("error");
  }, [scope, href, router]);

  const load = useCallback(async (position: ListNavigationEntry | null = null, append = false, nextWindow = false) => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    const current = state.current;
    setStatus("loading");
    try {
      if (append && current.page) {
        const next = await fetchReconciliationHistory(view, current.lastPage + 1, current.page.snapshot, request.signal, scope);
        const result = nextWindow ? next : { ...current.page, rows: appendReconciliationHistory(current.page.rows, next.rows, view) };
        if (request.signal.aborted) return;
        state.current = { page: result, lastPage: next.page, status: "idle" };
        setPage(result); setLastPage(next.page); setStatus("idle");
        if (nextWindow) scrollContainer()?.scrollTo({ top: 0 });
        return;
      }
      const first = await fetchReconciliationHistory(view, 1, null, request.signal, scope);
      const start = position && position.firstPage <= first.pageCount ? position.firstPage : 1;
      const end = Math.min(position?.lastPage ?? 1, first.pageCount, start + MAX_REMEMBERED_LIST_PAGES - 1);
      const base = start === 1 ? first : await fetchReconciliationHistory(view, start, first.snapshot, request.signal, scope);
      let rows = base.rows;
      for (let number = start + 1; number <= end; number += 2) {
        const pages = await Promise.all(Array.from({ length: Math.min(2, end - number + 1) }, (_, index) => fetchReconciliationHistory(view, number + index, first.snapshot, request.signal, scope)));
        for (const item of pages) rows = appendReconciliationHistory(rows, item.rows, view);
      }
      if (request.signal.aborted) return;
      restoring.current = position;
      selectedRun.current = position?.expandedIds?.[0] ?? null;
      const result = { ...base, rows };
      state.current = { page: result, lastPage: end, status: "idle" };
      setPage(result); setLastPage(end); setStatus("idle");
    } catch (error) { if (!request.signal.aborted) fail(error); }
    finally { if (controller.current === request) controller.current = null; }
  }, [scope, view, fail]);

  useLayoutEffect(() => {
    const memory = getBrowserListNavigationMemory();
    memory?.setScope(scope);
    entryId.current = getListHistoryEntryId(scope, href) ?? undefined;
    const position = memory?.read(scope, href, entryId.current) ?? null;
    void load(position);
    const container = scrollContainer();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => { if (!timer) timer = setTimeout(() => { timer = undefined; save(); }, 200); };
    container?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      save(); controller.current?.abort(); controller.current = null;
      if (timer) clearTimeout(timer);
      container?.removeEventListener("scroll", onScroll); window.removeEventListener("pagehide", save);
    };
  }, [scope, href, load, save]);

  useLayoutEffect(() => {
    const position = restoring.current;
    if (status !== "idle" || !position || !rootRef.current) return;
    restoring.current = null;
    const container = scrollContainer();
    if (!container) return;
    const anchor = Array.from(rootRef.current.querySelectorAll<HTMLElement>("[data-history-id]"))
      .find((row) => row.dataset.historyId === position.anchorId);
    if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - position.anchorOffset;
    else {
      container.scrollTop = Math.max(0, Math.min(position.scrollTop, container.scrollHeight - container.clientHeight));
      if (position.anchorId) setNotice("Your previous run is no longer in these results. History has been refreshed.");
    }
    save();
  }, [page, status, save]);

  const canLoadMore = !!page && lastPage < page.pageCount;
  const windowFull = !!page && lastPage - page.page + 1 >= MAX_REMEMBERED_LIST_PAGES;
  useEffect(() => {
    if (!canLoadMore || windowFull || status !== "idle" || !sentinelRef.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((item) => item.isIntersecting)) void load(null, true);
    }, { root: scrollContainer(), rootMargin: "400px 0px" });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [canLoadMore, windowFull, status, load]);

  function rememberRun(run: string) {
    selectedRun.current = run; save();
    getBrowserListNavigationMemory()?.rememberReturn(scope, reconciliationHref({ tab: "current", history: "daily", run }), href, entryId.current);
  }
  return { page, status, notice, rootRef, sentinelRef, canLoadMore, windowFull, rememberRun,
    retry: () => void load(state.current.page ? null : getBrowserListNavigationMemory()?.read(scope, href, entryId.current) ?? null, !!state.current.page, windowFull),
    loadMore: () => void load(null, true, windowFull) };
}
