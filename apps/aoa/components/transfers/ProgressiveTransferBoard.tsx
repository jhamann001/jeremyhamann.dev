"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProgressiveList } from "@/components/navigation/useProgressiveList";
import { ProgressiveListControls } from "@/components/navigation/ProgressiveListControls";
import type { ProgressivePage } from "@/lib/navigation/progressive-page";
import type { TransferBoardClientRow } from "@/lib/data/transfer-board-client";
import type { TransferDirectoryMeta } from "@/lib/data/transfer-directory";
import type { AcatChipMap } from "@/lib/data/acat-lane";
import { TRANSFER_SORT_KEYS, type TransferBoardQuery } from "@/lib/navigation/transfer-query";
import { STAGE_ORDER, type SortDir } from "@/lib/data/transfer-types";
import { safeListHref } from "@/lib/navigation/list-routes";
import { TransferLane } from "./TransferLane";
import { TransferOpsBar } from "./TransferOpsBar";
import { ClientSearch } from "./ClientSearch";
import styles from "./TransferBoard.module.css";

const EMPTY_META: TransferDirectoryMeta = { lanes: { DECISION: 0, IN_TRANSFER: 0, FUNDED: 0 }, hiddenCompleted: 0, stats: { outstanding: 0, active: 0, bouncing: 0 } };
export function ProgressiveTransferBoard({ initialPage, query, scope }: {
  initialPage: ProgressivePage<TransferBoardClientRow, TransferDirectoryMeta>; query: TransferBoardQuery; scope: string;
}) {
  const router = useRouter();
  const endpoint = query.href.replace("/asset-transfer", "/api/navigation/transfers");
  const list = useProgressiveList({ initialPage, scope, href: query.href, endpoint, rowIdKey: "id", emptyMeta: EMPTY_META });
  const { invalidateAuthorization, invalidateSnapshot } = list;
  const [chips, setChips] = useState<AcatChipMap>({});
  const completedChipPages = useRef(new Set<number>());
  const activeSnapshot = useRef(list.page.snapshot);
  useEffect(() => {
    if (activeSnapshot.current !== list.page.snapshot || ["changed", "unauthorized"].includes(list.loadState)) {
      activeSnapshot.current = list.page.snapshot; completedChipPages.current.clear(); setChips({});
    }
    if (list.loadState !== "idle" || !list.page.rows.length) return;
    const controller = new AbortController();
    void (async () => {
      for (let number = list.page.page; number <= list.lastPage; number++) {
        if (completedChipPages.current.has(number)) continue;
        const url = new URL(endpoint, "https://navigation.invalid");
        url.searchParams.set("mode", "chips"); url.searchParams.set("page", String(number));
        url.searchParams.set("pageSize", String(list.page.pageSize)); url.searchParams.set("snapshot", list.page.snapshot);
        try {
          const response = await fetch(`${url.pathname}?${url.searchParams}`, { signal: controller.signal, cache: "no-store", credentials: "same-origin", redirect: "error" });
          if (response.status === 401 || response.status === 403 || response.headers.get("X-AOA-Navigation-Scope") !== scope) { invalidateAuthorization(); return; }
          if (response.status === 409 || response.status === 416) { invalidateSnapshot(); return; }
          if (!response.ok) return;
          const result = await response.json();
          if (controller.signal.aborted) return;
          if (result.chips && typeof result.chips === "object" && !Array.isArray(result.chips)) {
            completedChipPages.current.add(number); setChips(previous => ({ ...previous, ...result.chips }));
          }
        } catch { return; } // Optional tracker enrichment has the existing graceful fallback.
      }
    })();
    return () => controller.abort();
  }, [endpoint, scope, list.loadState, list.page.snapshot, list.page.page, list.page.pageSize, list.page.rows.length, list.lastPage, invalidateAuthorization, invalidateSnapshot]);
  const hrefFor = (key: string, value: string) => {
    const url = new URL(query.href, "https://navigation.invalid");
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    url.searchParams.delete("page");
    return `${url.pathname}${url.searchParams.size ? `?${url.searchParams}` : ""}`;
  };
  const focused = !!query.household || !!query.query;
  const pauseNavigation = (event: MouseEvent<HTMLAnchorElement>, target: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (safeListHref(target) !== safeListHref(query.href)) list.pause();
  };
  const freshSearch = !["changed", "unauthorized", "restoring"].includes(list.loadState);
  return <div ref={list.rootRef} data-list-ready={list.ready ? "true" : "false"}>
    {freshSearch ? <ClientSearch scope={scope} onRecordNavigate={list.rememberReturn} onUnauthorized={invalidateAuthorization} /> : null}
    <TransferOpsBar stats={list.page.meta.stats} />
    <nav aria-label="Filter transfers by owner" style={{ display: "flex", gap: 12, margin: "14px 0" }}>
      {[["", "All"], ["OPERATIONS", "Operations"], ["CLIENT_SERVICE", "Client Service"]].map(([value, label]) =>
        <Link key={value} href={hrefFor("owner", value)} prefetch={false} onClick={event => pauseNavigation(event, hrefFor("owner", value))} aria-current={query.owner === value ? "page" : undefined}>{label}</Link>)}
    </nav>
    {focused ? <p>Showing {query.household || query.query} · {list.page.total} transfers across all stages. <Link href={hrefFor(query.household ? "household" : "q", "")} prefetch={false} onClick={event => pauseNavigation(event, hrefFor(query.household ? "household" : "q", ""))}>Clear focus</Link></p> : null}
    <div className={styles.boardHead}><label className={styles.showCompleted}>
      <input type="checkbox" checked={query.completed || focused} disabled={focused} onChange={event => {
        list.pause(); router.push(hrefFor("completed", event.target.checked ? "1" : ""), { scroll: false });
      }} /> Show completed ({list.page.meta.hiddenCompleted})
    </label></div>
    <div className={styles.lanes}>{STAGE_ORDER.map(stage => <TransferLane key={stage} stage={stage}
      rows={list.page.rows.filter(row => row.stage === stage)} chips={chips} total={list.page.meta.lanes[stage]}
      sortDirection={(query.sorts[stage] || null) as SortDir | null} onSort={direction => {
        list.pause(); router.push(hrefFor(TRANSFER_SORT_KEYS[stage], direction), { scroll: false });
      }} onRecordNavigate={list.rememberReturn} />)}</div>
    <ProgressiveListControls state={list} label="Transfers" href={query.href} />
  </div>;
}
