"use client";

import Link from "next/link";
import type { RefObject } from "react";
import { listPageHref } from "@/lib/navigation/list-routes";
import type { WindowPage } from "@/lib/navigation/window-page";
import type { WindowLoadState } from "./useWindowList";

export function WindowListControls({ state, label, href, total, totalState = "loading" }: {
  state: {
    page: WindowPage<unknown, object>;
    lastPage: number;
    loadState: WindowLoadState;
    ready: boolean;
    notice: string;
    canLoadMore: boolean;
    sentinelRef: RefObject<HTMLDivElement | null>;
    loadMore(): void;
    retry(): void;
  };
  label: string;
  href: string;
  total?: number | null;
  totalState?: "loading" | "available" | "unavailable" | "not_requested";
}) {
  const { page, loadState } = state;
  const busy = !state.ready || loadState === "loading" || loadState === "restoring";
  const first = page.rows.length === 0 ? 0 : (page.firstPage - 1) * page.pageSize + 1;
  const last = page.rows.length ? first + page.rows.length - 1 : 0;
  const exactTotal = typeof total === "number" && Number.isSafeInteger(total) && total >= last ? total : null;
  const showRange = !["restoring", "changed", "unauthorized"].includes(loadState)
    && !(loadState === "error" && page.rows.length === 0);
  return <nav aria-label={`${label} pages`} style={{ padding: 14, fontSize: 13 }}>
    <div role="status" aria-live="polite">
      {loadState === "restoring" ? "Restoring your place with current data… " : null}
      {loadState === "loading" ? "Loading more… " : null}
      {showRange ? <>Showing {first.toLocaleString()}–{last.toLocaleString()}
        {exactTotal !== null ? <> of {exactTotal.toLocaleString()}</> : totalState === "not_requested" ? null :
          <> · {totalState === "unavailable" ? "Total unavailable" : "Total loading…"}</>}</> : null}
    </div>
    {state.notice ? <p role="status">{state.notice}</p> : null}
    {loadState === "changed" ? <p role="status">These results changed. Refresh to load the current list.</p> : null}
    {loadState === "error" ? <p role="status">{page.rows.length
      ? "The next records could not be loaded. Your current rows are still here."
      : "Your results could not be restored. Retry to load the current list."}</p> : null}
    {(loadState === "error" || loadState === "changed") ?
      <button type="button" onClick={state.retry}>{loadState === "changed" ? "Refresh" : "Retry"}</button> :
      loadState !== "unauthorized" && state.canLoadMore ?
        <button type="button" disabled={busy} onClick={state.loadMore}>Load more {label.toLowerCase()}</button> :
        loadState === "idle" && page.hasMore ?
          // Audit and CRM numbered entry routes render canonical 100-row pages.
          // Convert the absolute next offset, not the transport's page number.
          <Link prefetch={false} href={listPageHref(href, ((page.firstPage - 1) * page.pageSize + page.loaded) / 100 + 1)}>Continue to the next results window</Link> :
          loadState === "idle" && page.rows.length === 0 && page.firstPage > 1 ?
            <Link prefetch={false} href={listPageHref(href, 1)}>Return to the first results</Link> :
          loadState === "idle" ? <span>End of results</span> : null}
    <div ref={state.sentinelRef} aria-hidden="true" style={{ height: 1 }} />
  </nav>;
}
