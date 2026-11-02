"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AuditLogRow } from "@/lib/data/audit-log";
import type { RowChangeRow } from "@/lib/data/row-changes";
import type { ProgressivePage } from "@/lib/navigation/progressive-page";
import { useProgressiveList } from "@/components/navigation/useProgressiveList";
import { ProgressiveListControls } from "@/components/navigation/ProgressiveListControls";
import { RememberedListLink } from "@/components/navigation/RememberedListLink";
import { Card, CardHeader, CardBody, Pill } from "@/components/ui";
import { AuditTable } from "./AuditTable";
import { RowChangeTable } from "./RowChangeTable";
import { AuditFilters } from "./AuditFilters";
import { RowChangeFilters } from "./RowChangeFilters";

export type AuditDirectoryMeta = { actions: string[]; actors: string[]; tables: string[]; ops: string[] };
const EMPTY_META: AuditDirectoryMeta = { actions: [], actors: [], tables: [], ops: [] };
type Filters = { action: string; actor: string; table: string; op: string };

export function AuditDirectory({ initialPage, initialFilters, view, href, scope }: {
  initialPage: ProgressivePage<AuditLogRow | RowChangeRow, AuditDirectoryMeta>;
  initialFilters: Filters; view: "events" | "changes"; href: string; scope: string;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState(initialFilters);
  const filtersRef = useRef(filters);
  const [pending, transition] = useTransition();
  const list = useProgressiveList({
    initialPage, scope, href, endpoint: href.replace("/audit-log", "/api/navigation/audit"),
    rowIdKey: "id", emptyMeta: EMPTY_META,
  });
  const { rows, meta, total } = list.page;
  function change(key: keyof Filters, value: string) {
    const next = { ...filtersRef.current, [key]: value };
    filtersRef.current = next; setFilters(next); list.pause();
    const params = new URLSearchParams();
    if (view === "changes") params.set("view", "changes");
    for (const field of (view === "changes" ? ["table", "op", "actor"] : ["action", "actor"]) as (keyof Filters)[]) {
      if (next[field]) params.set(field, next[field]);
    }
    const target = `/audit-log${params.size ? `?${params}` : ""}`;
    transition(() => {
      if (!pending && target === href) { list.resume(); return; }
      router.push(target, { scroll: false });
    });
  }
  const toggle = (id: string) => list.setExpandedIds(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  return <div ref={list.rootRef} data-list-ready={list.ready ? "true" : "false"} aria-busy={pending || list.loadState === "restoring"}>
    <nav aria-label="Audit view" style={{ display: "flex", gap: 6, margin: "16px 0" }}>
      <RememberedListLink scope={scope} href="/audit-log" match={{ view: "" }} active={view === "events"}>Events</RememberedListLink>
      <RememberedListLink scope={scope} href="/audit-log?view=changes" match={{ view: "changes" }} active={view === "changes"}>Field changes</RememberedListLink>
    </nav>
    <Card>
      <CardHeader><h2>{view === "changes" ? "Field changes" : "Activity audit"}</h2><Pill tone="gray">{total} {view === "changes" ? "changes" : "events"}</Pill></CardHeader>
      <CardBody>
        {view === "changes" ? <RowChangeFilters {...meta} {...filters} onChange={change} /> : <AuditFilters {...meta} {...filters} onChange={change} />}
        {view === "changes" ?
          <RowChangeTable rows={rows as RowChangeRow[]} expandedIds={list.expandedIds} onToggle={toggle} onRecordNavigate={list.rememberReturn} /> :
          <AuditTable rows={rows as AuditLogRow[]} expandedIds={list.expandedIds} onToggle={toggle} />}
        {rows.length === 0 && list.loadState === "idle" ? <p>No {view === "changes" ? "changes" : "events"} match the current filters.</p> : null}
        <ProgressiveListControls state={list} label={view === "changes" ? "Field changes" : "Audit events"} href={href} />
      </CardBody>
    </Card>
  </div>;
}
