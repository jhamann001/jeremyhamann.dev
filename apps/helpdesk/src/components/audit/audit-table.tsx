"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { ArrowRight, LoaderCircle, ShieldAlert } from "lucide-react";
import type { AuditPage, AuditQuery, AuditRow } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AuditActionBadge } from "@/components/audit/audit-action-badge";
import { auditQueryToParams } from "@/components/audit/audit-query-params";
import { AuditRowCard, truncateValue } from "@/components/audit/audit-row-card";
import { AuditRowDialog } from "@/components/audit/audit-row-dialog";
import { formatDateTime, formatTicketNumber, GROUP_LABELS, labelize } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One RSC-rendered page of rows, keyed by the cursor that produced it. */
type Chunk = { cursor: string | undefined; rows: AuditRow[] };

type Accumulated = {
  /** Filters without the cursor — a change here means a new result set. */
  baseKey: string;
  /** The `page` object the last chunk was built from (identity check, so a refresh replaces it). */
  page: AuditPage;
  chunks: Chunk[];
};

/**
 * "Load more" is URL-driven: it navigates to `?…&cursor=<lastSeq>` and the RSC page renders (and audits)
 * the next page. This client-side merge keeps the pages already on screen so the table grows instead of
 * being replaced. Pure so the render-time reconciliation below stays predictable.
 */
function mergePage(prev: Accumulated | null, page: AuditPage, cursor: string | undefined, baseKey: string): Accumulated {
  const chunk: Chunk = { cursor, rows: page.rows };
  if (prev === null || prev.baseKey !== baseKey) return { baseKey, page, chunks: [chunk] };

  const existing = prev.chunks.findIndex((c) => c.cursor === cursor);
  if (existing >= 0) {
    // Same cursor rendered again (router.refresh or back navigation): replace that page in place.
    const chunks = prev.chunks.slice();
    chunks[existing] = chunk;
    return { baseKey, page, chunks };
  }

  const last = prev.chunks[prev.chunks.length - 1];
  const lastSeq = last && last.rows.length > 0 ? last.rows[last.rows.length - 1].seq : undefined;
  if (cursor !== undefined && lastSeq === cursor) return { baseKey, page, chunks: [...prev.chunks, chunk] };

  // A cursor that does not continue what is on screen (hand-edited URL): start over from that page.
  return { baseKey, page, chunks: [chunk] };
}

function flattenRows(chunks: Chunk[]): AuditRow[] {
  const seen = new Set<string>();
  const out: AuditRow[] = [];
  for (const chunk of chunks) {
    for (const row of chunk.rows) {
      if (seen.has(row.seq)) continue;
      seen.add(row.seq);
      out.push(row);
    }
  }
  return out;
}

const COLUMNS: ColumnDef<AuditRow>[] = [
  {
    id: "seq",
    accessorKey: "seq",
    header: "Seq",
    cell: ({ row }) => <span className="font-mono text-xs tabular-nums">{row.original.seq}</span>,
  },
  {
    id: "occurredAt",
    accessorKey: "occurredAt",
    header: "Occurred",
    cell: ({ row }) => (
      <time dateTime={row.original.occurredAt} title={row.original.occurredAt} className="tabular-nums" suppressHydrationWarning>
        {formatDateTime(row.original.occurredAt)}
      </time>
    ),
  },
  {
    id: "actor",
    accessorKey: "actorEmail",
    header: "Actor",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium" title={r.actorEmail}>
            {r.actorEmail}
          </span>
          <span className="flex flex-wrap items-center gap-1">
            {r.actorGroups.map((g) => (
              <Badge key={g} variant="secondary" className="h-4 px-1.5 text-[10px] font-normal" data-group={g}>
                {GROUP_LABELS[g]}
              </Badge>
            ))}
            {r.dualRole ? (
              <Badge
                className="h-4 gap-0.5 border-transparent bg-red-600 px-1.5 text-[10px] text-white dark:bg-red-700"
                data-dual-role
                title="Compliance plus an operational group"
              >
                <ShieldAlert aria-hidden />
                Dual role
              </Badge>
            ) : null}
          </span>
        </div>
      );
    },
  },
  {
    id: "action",
    accessorKey: "action",
    header: "Action",
    cell: ({ row }) => <AuditActionBadge action={row.original.action} />,
  },
  {
    id: "entity",
    accessorKey: "entityType",
    header: "Entity",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{labelize(r.entityType)}</span>
          {r.ticketId && r.ticketNumber !== null ? (
            <Link
              href={`/tickets/${r.ticketId}`}
              prefetch={false}
              className="font-medium underline-offset-4 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {formatTicketNumber(r.ticketNumber)}
            </Link>
          ) : r.entityId ? (
            <span className="max-w-40 truncate font-mono text-xs" title={r.entityId}>
              {r.entityId}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      );
    },
  },
  {
    id: "field",
    accessorKey: "fieldChanged",
    header: "Field",
    cell: ({ row }) =>
      row.original.fieldChanged ? (
        <code className="font-mono text-xs">{row.original.fieldChanged}</code>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: "change",
    header: "Old → New",
    cell: ({ row }) => {
      const r = row.original;
      if (r.oldValue === null && r.newValue === null) return <span className="text-muted-foreground">—</span>;
      return (
        <span className="flex max-w-96 items-center gap-1.5 text-xs">
          <span className={cn("truncate", r.oldValue === null && "text-muted-foreground italic")}>
            {r.oldValue === null ? "null" : truncateValue(r.oldValue)}
          </span>
          <ArrowRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className={cn("truncate", r.newValue === null && "text-muted-foreground italic")}>
            {r.newValue === null ? "null" : truncateValue(r.newValue)}
          </span>
        </span>
      );
    },
  },
  {
    id: "ip",
    accessorKey: "ipAddress",
    header: "IP",
    cell: ({ row }) => <code className="font-mono text-xs">{row.original.ipAddress}</code>,
  },
];

/**
 * Cursor-paginated ledger (seq desc). Rows are what the RSC page loaded — the component never fetches on
 * its own, so every page shown corresponds to exactly one AUDIT_LOG_VIEWED row. Two presentations of the
 * SAME flattened rows from ONE `useReactTable`: the TanStack table from
 * `md`, an `AuditRowCard` list below it; one empty state, one footer, one "Load more" URL writer.
 * Activating a row/card opens `AuditRowDialog`; ticket links are `prefetch={false}`.
 */
export function AuditTable({ page, query }: { page: AuditPage; query: AuditQuery }): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const baseKey = auditQueryToParams(query, { includeCursor: false }).toString();

  // Adjust accumulated pages when the server hands us a new `page` (React's "derive state from props"
  // pattern: a guarded setState during render, not an effect, so the first paint is already correct).
  const [acc, setAcc] = useState<Accumulated>(() => mergePage(null, page, query.cursor, baseKey));
  let current = acc;
  if (acc.page !== page || acc.baseKey !== baseKey) {
    current = mergePage(acc, page, query.cursor, baseKey);
    setAcc(current);
  }

  const rows = useMemo(() => flattenRows(current.chunks), [current.chunks]);

  const table = useReactTable({
    data: rows,
    columns: COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.seq,
  });

  function openRow(row: AuditRow): void {
    setSelected(row);
    setDialogOpen(true);
  }

  function loadMore(): void {
    if (page.nextCursor === null) return;
    const params = auditQueryToParams({ ...query, cursor: page.nextCursor }, { includeCursor: true });
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    });
  }

  const firstChunkCursor = current.chunks[0]?.cursor;

  return (
    <div className="flex flex-col gap-3" data-audit-table>
      {firstChunkCursor !== undefined ? (
        <p className="text-xs text-muted-foreground">
          Showing rows after seq <span className="font-mono tabular-nums">{firstChunkCursor}</span>.{" "}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0 text-xs"
            data-tap="none"
            onClick={() => router.push(baseKey === "" ? pathname : `${pathname}?${baseKey}`)}
          >
            Start from the newest row
          </Button>
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground" data-audit-empty>
          No audit rows match these filters.
        </p>
      ) : null}

      <div className={cn("rounded-lg border", rows.length === 0 ? "hidden" : "hidden md:block")}>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id} scope="col">
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((r) => (
              <TableRow
                key={r.id}
                tabIndex={0}
                role="button"
                aria-label={`Open audit row ${r.original.seq}`}
                className="cursor-pointer align-top outline-none focus-visible:bg-muted/60"
                data-seq={r.original.seq}
                data-dual-role={r.original.dualRole || undefined}
                onClick={() => openRow(r.original)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openRow(r.original);
                  }
                }}
              >
                {r.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="whitespace-normal">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {rows.length > 0 ? (
        <ol className="flex flex-col gap-2 md:hidden" aria-label="Audit rows">
          {table.getRowModel().rows.map((r) => (
            <AuditRowCard key={r.id} row={r.original} onOpen={openRow} />
          ))}
        </ol>
      ) : null}

      <div className="flex flex-col items-stretch gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>
          Showing <span className="tabular-nums">{rows.length.toLocaleString()}</span> of{" "}
          <span className="tabular-nums">{page.total.toLocaleString()}</span> matching rows
        </span>
        {page.nextCursor !== null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            onClick={loadMore}
            disabled={pending}
            aria-busy={pending || undefined}
            data-audit-load-more
          >
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
            {pending ? "Loading…" : "Load more"}
          </Button>
        ) : rows.length > 0 ? (
          <span className="text-xs">End of matching rows</span>
        ) : null}
      </div>

      <AuditRowDialog row={selected} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
