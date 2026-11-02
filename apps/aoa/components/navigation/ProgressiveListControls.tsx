"use client";

import Link from "next/link";
import type { RefObject } from "react";
import { listPageHref } from "@/lib/navigation/list-routes";
import type { ProgressiveLoadState } from "./useProgressiveList";

export function ProgressiveListControls({ state, label, href }: {
  state: {
    page: { rows: unknown[]; page: number; pageSize: number; total: number; pageCount: number };
    lastPage: number; loadState: ProgressiveLoadState; ready: boolean;
    notice: string; canLoadMore: boolean;
    sentinelRef: RefObject<HTMLDivElement | null>;
    loadMore(): void; retry(): void;
  };
  label: string;
  href: string;
}) {
  const { page, lastPage, loadState } = state;
  const busy = !state.ready || loadState === "loading" || loadState === "restoring";
  const first = page.rows.length === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const last = page.rows.length ? first + page.rows.length - 1 : 0;
  return <nav aria-label={`${label} pages`} style={{ padding: 14, fontSize: 13 }}>
    <div role="status" aria-live="polite">
      {loadState === "restoring" ? "Restoring your place with current data… " : null}
      {loadState === "loading" ? "Loading more… " : null}
      {loadState !== "restoring" && loadState !== "changed" && loadState !== "unauthorized" &&
        !(loadState === "error" && !page.rows.length) ?
        <>Showing {first.toLocaleString()}–{last.toLocaleString()} of {page.total.toLocaleString()}</> : null}
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
        loadState === "idle" && lastPage < page.pageCount ?
          <Link href={listPageHref(href, lastPage + 1)} prefetch={false}>Continue to the next results window</Link> :
          loadState === "idle" ? <span>End of results</span> : null}
    <div ref={state.sentinelRef} aria-hidden="true" style={{ height: 1 }} />
  </nav>;
}
