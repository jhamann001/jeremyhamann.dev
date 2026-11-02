"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RowChangeRow } from "@/lib/data/row-changes";
import type { WindowPage } from "@/lib/navigation/window-page";
import { safeListHref } from "@/lib/navigation/list-routes";
import { useWindowList } from "@/components/navigation/useWindowList";
import { WindowListControls } from "@/components/navigation/WindowListControls";
import { RememberedListLink } from "@/components/navigation/RememberedListLink";
import { Card, CardHeader, CardBody, Pill } from "@/components/ui";
import { RecentRowChangeFilters, type RecentRowChangeQuery } from "./RecentRowChangeFilters";
import { RowChangeTable } from "./RowChangeTable";

const EMPTY_META: Record<string, never> = {};

function AuditViews({ scope }: { scope: string }) {
  return <nav aria-label="Audit view" style={{ display: "flex", gap: 6, margin: "16px 0" }}>
    <RememberedListLink scope={scope} href="/audit-log" match={{ view: "" }}>Events</RememberedListLink>
    <RememberedListLink scope={scope} href="/audit-log?view=changes" match={{ view: "changes" }} active>Field changes</RememberedListLink>
  </nav>;
}

/** A failed first row read has its own retry, without replacing the app shell. */
export function AuditFieldChangesUnavailable({ scope }: { scope: string }) {
  const router = useRouter();
  const [pending, transition] = useTransition();
  return <><AuditViews scope={scope} /><Card><CardHeader><h2>Field changes</h2></CardHeader><CardBody>
    <p role="status">Field changes could not be loaded. No data was changed.</p>
    <button type="button" disabled={pending} onClick={() => transition(() => router.refresh())}>
      {pending ? "Retrying…" : "Retry field changes"}
    </button>
  </CardBody></Card></>;
}

export function AuditFieldChangesDirectory({ initialPage, initialFilters, href, scope }: {
  initialPage: WindowPage<RowChangeRow, Record<string, never>>;
  initialFilters: RecentRowChangeQuery; href: string; scope: string;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<RecentRowChangeQuery>(() => ({
    table: initialFilters.table, op: initialFilters.op, actor: initialFilters.actor,
    from: initialFilters.from, to: initialFilters.to,
  }));
  const [pending, transition] = useTransition();
  const list = useWindowList({ initialPage, scope, href,
    endpoint: href.replace("/audit-log", "/api/navigation/audit/rows"), rowIdKey: "id", emptyMeta: EMPTY_META });

  function apply(next: RecentRowChangeQuery) {
    const params = new URLSearchParams({ view: "changes" });
    for (const key of ["table", "op", "actor", "from", "to"] as const) if (next[key]) params.set(key, next[key]);
    const target = safeListHref(`/audit-log?${params}`);
    if (!target) return; // The form validates; URL validation remains fail-closed.
    if (target === safeListHref(href)) return;
    setFilters(next); list.pause();
    transition(() => router.push(target, { scroll: false }));
  }
  const toggle = (id: string) => list.setExpandedIds(previous => previous.includes(id)
    ? previous.filter(value => value !== id) : [...previous, id]);
  const tables = [...new Set(list.page.rows.map(row => row.table))].sort();
  const actors = [...new Set(list.page.rows.flatMap(row => row.actorEmail ? [row.actorEmail] : []))].sort();
  const recent = list.page.firstPage === 1 && list.page.rows.length > 0 && list.page.rows.length <= list.page.pageSize
    && !Object.values(filters).some(Boolean);
  return <div ref={list.rootRef} data-list-ready={list.ready ? "true" : "false"}
    aria-busy={pending || list.loadState === "restoring"}>
    <AuditViews scope={scope} />
    <Card><CardHeader><h2>Field changes</h2><Pill tone="gray">
      {list.page.rows.length.toLocaleString()} {recent ? "most recent changes" : "loaded matching changes"}
    </Pill></CardHeader><CardBody>
      <p>Newest first. Load more or choose dates to explore older records. All history is retained; no full-history total is requested.</p>
      <RecentRowChangeFilters initial={filters} tables={tables} actors={actors} pending={pending} onApply={apply} />
      <RowChangeTable rows={list.page.rows} expandedIds={list.expandedIds} onToggle={toggle} onRecordNavigate={list.rememberReturn} />
      {!list.page.rows.length && list.loadState === "idle" ? <p>{list.page.firstPage === 1
        ? "No changes match the current filters." : "This results window no longer contains changes. Return to the first page to refresh the list."}</p> : null}
      <WindowListControls state={list} label="Field changes" href={href} totalState="not_requested" />
    </CardBody></Card>
  </div>;
}
