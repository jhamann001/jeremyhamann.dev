"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import type {
  AssigneeOption,
  QueueKey,
  QueueSummary,
  TicketListPage,
  TicketListQuery,
  Viewer,
} from "@/types/domain";
import { QUEUE_LABELS } from "@/types/domain";
import { creatableQueues, readableQueues } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { AutoRefresh } from "@/components/dashboard/auto-refresh";
// Wave B MOUNT POINT: the bulk-action bar, owned by slice B2. A compiling
// stub that renders null until B2 lands; the props are the contract.
import { BulkActionsBar } from "@/components/dashboard/bulk-actions-bar";
import { useDashboardStore } from "@/components/dashboard/dashboard-store";
import { ExportTicketsButton } from "@/components/dashboard/export-tickets-button";
import { QueueCounters } from "@/components/dashboard/queue-counters";
import { TicketFilters } from "@/components/dashboard/ticket-filters";
import { TicketPreviewSheet } from "@/components/dashboard/ticket-preview-sheet";
import { ticketQueryHref } from "@/components/dashboard/ticket-query-params";
import { TicketTable } from "@/components/dashboard/ticket-table";

/** The RSC re-renders on this cadence while the tab is visible. */
const AUTO_REFRESH_MS = 30_000;

/** Union of the assignable users across the shown queues, deduplicated by id, for the assignee filter. */
function unionAssignees(
  assigneesByQueue: Partial<Record<QueueKey, AssigneeOption[]>>,
  queues: readonly QueueKey[],
): AssigneeOption[] {
  const seen = new Map<string, AssigneeOption>();
  for (const q of queues) {
    for (const a of assigneesByQueue[q] ?? []) if (!seen.has(a.id)) seen.set(a.id, a);
  }
  return [...seen.values()].sort((a, b) =>
    (a.name?.trim() || a.email).localeCompare(b.name?.trim() || b.email, undefined, { sensitivity: "base" }),
  );
}

/**
 * The operator screen: counters (polled), URL-driven filters, the dense server-paginated table, the
 * slide-over preview and a 30 s RSC auto-refresh. Serves both /dashboard (all readable queues) and
 * /queues/[queue] (`pinnedQueue` set, queue column and selector hidden).
 */
export function DashboardView({
  viewer,
  summaries,
  page,
  query,
  assigneesByQueue,
  pinnedQueue,
}: {
  viewer: Viewer;
  summaries: QueueSummary[];
  page: TicketListPage;
  query: TicketListQuery;
  assigneesByQueue: Partial<Record<QueueKey, AssigneeOption[]>>;
  pinnedQueue?: QueueKey;
}): React.JSX.Element {
  const previewTicketId = useDashboardStore((s) => s.previewTicketId);
  const openPreview = useDashboardStore((s) => s.openPreview);
  const closePreview = useDashboardStore((s) => s.closePreview);

  const readable = useMemo(() => readableQueues(viewer.groups), [viewer.groups]);
  const canCreate = creatableQueues(viewer.groups).length > 0;
  const showQueue = pinnedQueue === undefined;
  const assignees = useMemo(
    () => unionAssignees(assigneesByQueue, pinnedQueue ? [pinnedQueue] : readable),
    [assigneesByQueue, pinnedQueue, readable],
  );

  const pinnedSummary = pinnedQueue ? summaries.find((s) => s.key === pinnedQueue) : undefined;
  const title = pinnedQueue ? (pinnedSummary?.name ?? QUEUE_LABELS[pinnedQueue]) : "Dashboard";
  const subtitle = pinnedQueue
    ? pinnedSummary?.description || "Tickets in this queue"
    : readable.length > 0
      ? `Tickets across ${readable.map((q) => QUEUE_LABELS[q]).join(", ")}`
      : "No queues are visible to your groups";

  /**
   * Label for an active `requesterExternalId` chip. The filter key is opaque on purpose and the
   * chip must print neither it nor the client's address, so the NAME is resolved from the rows the
   * filter itself returned — every one of them is the same requester, by definition of an exact match.
   * An empty page (the id matches nothing the viewer may read) falls back to neutral wording.
   */
  const requesterFilterName = useMemo(() => {
    if (query.requesterExternalId === undefined || query.requesterExternalId.length === 0) return undefined;
    const name = page.rows[0]?.requesterName?.trim() ?? "";
    return name.length > 0 ? name : undefined;
  }, [query.requesterExternalId, page.rows]);

  /**
   * the checked selection for the bulk bar.
   *
   * It lives HERE rather than in `dashboard-store` on purpose. A selection is about the page currently
   * on screen — change a filter and the rows underneath it change meaning — so it must not survive a
   * navigation the way the store's preview id does. Local state clears on every re-render of a new
   * page, which is the behaviour a checkbox column needs.
   */
  const pathname = usePathname();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const clearSelection = useCallback(() => setSelectedIds([]), []);

  // The list AS IT IS RIGHT NOW — filters, sort and page. It rides on every link into a ticket as
  // `?back=`, so the ticket page's "back to the list" returns to what the reader was looking at
  // instead of to a default board. Ids and a path only; never a subject or an address.
  const listHref = ticketQueryHref(pathname, query, { includeQueueKey: showQueue });

  const onPreview = useCallback((id: string) => openPreview(id), [openPreview]);
  const onOpenChange = useCallback(
    (o: boolean) => {
      if (!o) closePreview();
    },
    [closePreview],
  );

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Wave A: the CSV export of exactly what the filters select (contract §8). */}
          <ExportTicketsButton query={query} viewer={viewer} />
          {/* The bottom tab bar owns "New" on phones (docs/MOBILE_FIRST.md §4.3 item 1). */}
          {canCreate ? (
            <Button asChild size="sm" className="hidden md:inline-flex">
              <Link href="/tickets/new" prefetch={false}>
                <Plus aria-hidden />
                New ticket
              </Link>
            </Button>
          ) : null}
        </div>
      </header>

      <QueueCounters initial={pinnedQueue ? summaries.filter((s) => s.key === pinnedQueue) : summaries} />

      <TicketFilters
        query={query}
        assignees={assignees}
        showQueue={showQueue}
        queues={readable}
        total={page.total}
        requesterName={requesterFilterName}
      />

      {/* Wave B: between the filters and the list, so it appears exactly where a selection is made and
          cannot cover a row. It renders null while nothing is selected. `TicketTable` owns the
          checkbox column and mirrors its selection up through the two props below (integration round
          1), so `selectedIds` here is the list the bar acts on and `clearSelection` clears it. */}
      <BulkActionsBar
        rows={page.rows}
        viewer={viewer}
        selectedIds={selectedIds}
        onClearSelection={clearSelection}
      />

      <TicketTable
        page={page}
        query={query}
        viewer={viewer}
        assigneesByQueue={assigneesByQueue}
        showQueue={showQueue}
        onPreview={onPreview}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
      />

      <TicketPreviewSheet
        ticketId={previewTicketId}
        open={previewTicketId !== null}
        onOpenChange={onOpenChange}
        assigneesByQueue={assigneesByQueue}
        rows={page.rows}
        backHref={listHref}
      />

      <AutoRefresh intervalMs={AUTO_REFRESH_MS} />
    </div>
  );
}
