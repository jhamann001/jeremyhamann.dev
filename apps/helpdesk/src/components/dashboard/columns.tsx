import Link from "next/link";
import { listContextFor, ticketHref } from "@/components/dashboard/ticket-link";
import type { ColumnDef } from "@tanstack/react-table";
import { CATEGORY_LABELS } from "@/types/domain";
import type { AssigneeOption, QueueKey, TicketListRow, Viewer } from "@/types/domain";
import { canWriteQueue } from "@/lib/rbac";
import { formatDateTime, formatRelative, formatTicketNumber } from "@/lib/format";
import { AssigneeSelect } from "@/components/tickets/assignee-select";
import { FlagBadges } from "@/components/tickets/flag-badges";
import { PiiIndicator } from "@/components/tickets/pii-indicator";
import { PriorityBadge } from "@/components/tickets/priority-badge";
import { QueueBadge } from "@/components/tickets/queue-badge";
import { SlaBadge } from "@/components/tickets/sla-badge";
import { StatusBadge } from "@/components/tickets/status-badge";
import { cn } from "@/lib/utils";

/**
 * Column ids double as sort keys: the ids `resolutionDueAt`, `priority`, `updatedAt` and `createdAt`
 * are exactly the `TICKET_SORTS` values, so a header click maps 1:1 onto the URL `sort` param.
 */
export const COLUMN_IDS = {
  number: "number",
  sla: "resolutionDueAt",
  priority: "priority",
  status: "status",
  subject: "subject",
  queue: "queueKey",
  requester: "requesterName",
  assignee: "assignee",
  updated: "updatedAt",
} as const;

/** Per-column cell classes; kept beside the defs so the table stays a dumb renderer. */
export const COLUMN_CLASSES: Readonly<Record<string, string>> = {
  [COLUMN_IDS.number]: "w-[5.5rem] font-mono text-xs",
  [COLUMN_IDS.sla]: "w-[9.5rem]",
  [COLUMN_IDS.priority]: "w-24",
  [COLUMN_IDS.status]: "w-32",
  [COLUMN_IDS.subject]: "min-w-[16rem] max-w-[36rem]",
  [COLUMN_IDS.queue]: "w-32",
  [COLUMN_IDS.requester]: "w-40",
  [COLUMN_IDS.assignee]: "w-44",
  [COLUMN_IDS.updated]: "w-24 text-right",
};

export function buildColumns(opts: {
  viewer: Viewer;
  assigneesByQueue: Partial<Record<QueueKey, AssigneeOption[]>>;
  showQueue: boolean;
  onPreview: (id: string) => void;
  /** The page's row ids IN DISPLAY ORDER, so a subject link carries its neighbours. */
  rowIds?: readonly string[];
  /** Where this list lives, so the ticket page's "back to the list" keeps the filters. */
  backHref?: string | null;
}): ColumnDef<TicketListRow>[] {
  const { viewer, assigneesByQueue, showQueue, onPreview, rowIds = [], backHref = null } = opts;
  const contextFor = (id: string) => listContextFor(rowIds, id, backHref);

  const columns: ColumnDef<TicketListRow>[] = [
    {
      id: COLUMN_IDS.number,
      accessorKey: "number",
      header: "#",
      enableSorting: false,
      cell: ({ row }) => (
        <Link
          href={ticketHref(row.original.id, contextFor(row.original.id))}
          prefetch={false}
          className="rounded-sm font-medium text-foreground tabular-nums outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={`Open ticket ${formatTicketNumber(row.original.number)}`}
        >
          {formatTicketNumber(row.original.number)}
        </Link>
      ),
    },
    {
      id: COLUMN_IDS.sla,
      accessorKey: "resolutionDueAt",
      header: "SLA",
      enableSorting: true,
      cell: ({ row }) => {
        const t = row.original;
        return (
          <SlaBadge
            timers={{
              firstResponseDueAt: t.firstResponseDueAt,
              resolutionDueAt: t.resolutionDueAt,
              firstRespondedAt: t.firstRespondedAt,
              resolvedAt: t.resolvedAt,
            }}
            initial={t.sla}
          />
        );
      },
    },
    {
      id: COLUMN_IDS.priority,
      accessorKey: "priority",
      header: "Priority",
      enableSorting: true,
      cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
    },
    {
      id: COLUMN_IDS.status,
      accessorKey: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: COLUMN_IDS.subject,
      accessorKey: "subject",
      header: "Subject",
      enableSorting: false,
      cell: ({ row }) => {
        const t = row.original;
        return (
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onPreview(t.id)}
              className={cn(
                "min-w-0 truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50",
                t.status === "CLOSED" && "text-muted-foreground",
              )}
              title={t.subject}
              aria-label={`Preview ${formatTicketNumber(t.number)}: ${t.subject}`}
            >
              {t.subject}
            </button>
            <span className="hidden shrink-0 text-[11px] text-muted-foreground xl:inline">{CATEGORY_LABELS[t.category]}</span>
            {/* Wave A compliance flags travel on the list row, so this needs no second fetch (contract §10 S7). */}
            <FlagBadges ticket={t} className="shrink-0" />
            <PiiIndicator count={t.piiRedactionCount} scope="ticket" />
          </div>
        );
      },
    },
  ];

  if (showQueue) {
    columns.push({
      id: COLUMN_IDS.queue,
      accessorKey: "queueKey",
      header: "Queue",
      enableSorting: false,
      cell: ({ row }) => <QueueBadge queueKey={row.original.queueKey} />,
    });
  }

  columns.push(
    {
      id: COLUMN_IDS.requester,
      accessorKey: "requesterName",
      header: "Requester",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="block truncate" title={row.original.requesterName}>
          {row.original.requesterName}
        </span>
      ),
    },
    {
      id: COLUMN_IDS.assignee,
      accessorFn: (r) => r.assignee?.id ?? "",
      header: "Assignee",
      enableSorting: false,
      cell: ({ row }) => {
        const t = row.original;
        // §g S5: inline assignee control, disabled unless the viewer writes this row's queue and the ticket is
        // not CLOSED. `t.version` is the OCC token (contract amendment #46) — on success the
        // control's own `router.refresh()` re-renders the list, so the next row carries the incremented
        // version; a stale token surfaces as CONFLICT → toast + refresh, never a silent overwrite.
        const editable = canWriteQueue(viewer.groups, t.queueKey) && t.status !== "CLOSED";
        return (
          <AssigneeSelect
            ticketId={t.id}
            version={t.version}
            value={t.assignee}
            options={assigneesByQueue[t.queueKey] ?? []}
            disabled={!editable}
          />
        );
      },
    },
    {
      id: COLUMN_IDS.updated,
      accessorKey: "updatedAt",
      header: "Updated",
      enableSorting: true,
      cell: ({ row }) => (
        <time
          dateTime={row.original.updatedAt}
          title={formatDateTime(row.original.updatedAt)}
          className="text-xs text-muted-foreground tabular-nums"
          suppressHydrationWarning
        >
          {formatRelative(row.original.updatedAt)}
        </time>
      ),
    },
  );

  return columns;
}
