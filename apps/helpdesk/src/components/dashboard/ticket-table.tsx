"use client";

import { useCallback, useEffect, useMemo, useRef, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronsUpDown } from "lucide-react";
import type { AssigneeOption, QueueKey, TicketListPage, TicketListQuery, TicketSort, Viewer } from "@/types/domain";
import { TICKET_SORTS } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { INTERACTIVE_SELECTOR } from "@/components/shell/mobile-card";
import { COLUMN_CLASSES, buildColumns } from "@/components/dashboard/columns";
import { listContextFor } from "@/components/dashboard/ticket-link";
import { StatusBadge } from "@/components/tickets/status-badge";
import { TicketCard } from "@/components/dashboard/ticket-card";
import { useBulkSelection } from "@/components/dashboard/bulk-actions-bar";
import { TICKET_LIST_CONTEXT_KEY } from "@/components/ticket/swipe-nav";
import { SHORTCUT_ROW_ATTR } from "@/components/shell/keyboard-shortcuts";
import { formatTicketNumber } from "@/lib/format";
import { PAGE_SIZE_OPTIONS, hasActiveFilters, ticketQueryHref } from "@/components/dashboard/ticket-filters";
import { cn } from "@/lib/utils";

function isTicketSort(id: string): id is TicketSort {
  return (TICKET_SORTS as readonly string[]).includes(id);
}

/**
 * Dense, server-paginated ticket list. TanStack Table handles presentation only: pagination and
 * sorting are `manual` and every change writes URL params (page/sort/dir), which re-renders the RSC.
 * Row click → `onPreview` (the slide-over fetches `/api/tickets/[id]/preview`, one open = one view).
 *
 * One component, two presentations (docs/MOBILE_FIRST.md §4.3 item 4, decision D2): the table is
 * `hidden md:block`, a `TicketCard` list is `md:hidden`, and BOTH render the same `table.getRowModel()`
 * rows from ONE `useReactTable` with ONE footer/pager writing the URL. No second fetch, no second pager.
 *
 * WAVE B adds three things and changes nothing else:
 *
 *  - **A multi-select column at md+**, in front of the generated columns rather than inside
 *    `buildColumns` — `columns.tsx` belongs to no slice and B2 must not edit it. The
 *    checkbox is a `button[role=checkbox]`, so `INTERACTIVE_SELECTOR` already keeps a tick from opening
 *    the preview.
 *  - **A select mode on phones**, entered by long-press on a card or by the visible "Select" button —
 *    a gesture nobody can see is a feature nobody finds (MOBILE_FIRST). In select mode the card list is
 *    replaced by a checkable list this component owns, because `ticket-card.tsx` is unowned and cannot
 *    grow a checkbox.
 *  - **`data-shortcut-row` on the md+ rows**, which is how a page opts into the j/k cursor in
 *    `KeyboardShortcuts`. The shortcut layer has its own attribute namespace rather than reusing the
 *    already-ambiguous `data-ticket-id`.
 *  - **A list-context snapshot** in sessionStorage, so `SwipeNav` on the ticket page can move between
 *    adjacent tickets IN THE ORDER THIS LIST RENDERED THEM. UI state only, per tab, never record
 *    content: ids and the list's own href.
 *
 * The selection itself lives in `useBulkSelection` (owned by `bulk-actions-bar.tsx`) rather than in a
 * prop, because the dashboard passes the selection to the BAR and not to the TABLE and the dashboard is
 * foundation-owned. See the build record.
 */
export function TicketTable({
  page,
  query,
  viewer,
  assigneesByQueue,
  showQueue,
  onPreview,
  selectedIds: selectedIdsProp,
  onSelectionChange,
}: {
  page: TicketListPage;
  query: TicketListQuery;
  viewer: Viewer;
  assigneesByQueue: Partial<Record<QueueKey, AssigneeOption[]>>;
  showQueue: boolean;
  onPreview: (id: string) => void;
  /**
   * The dashboard's own selection state (integration round 1). OPTIONAL, and it does not replace the
   * `useBulkSelection` store: the store is what lets `BulkActionsBar` — a sibling, not an ancestor —
   * read a selection this table owns, and it stays the source of truth inside the table. These two
   * props mirror it OUT so `dashboard-view.tsx`'s `selectedIds` stops being permanently empty and its
   * `onClearSelection` clears something. Adding them is a no-op for behaviour because the bar reads
   * the UNION of the prop and the store.
   */
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
}): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [pending, startTransition] = useTransition();

  const selectedIds = useBulkSelection((s) => s.ids);
  const selectMode = useBulkSelection((s) => s.selectMode);
  const toggleSelected = useBulkSelection((s) => s.toggle);
  const setSelected = useBulkSelection((s) => s.set);
  const clearSelected = useBulkSelection((s) => s.clear);
  const setSelectMode = useBulkSelection((s) => s.setSelectMode);

  // Mirror the store OUT to the dashboard, so its `selectedIds` is the same list the bar renders and
  // its `onClearSelection` has something to clear. One direction only: the store stays the source of
  // truth inside the table, and an effect that also wrote the prop back INTO the store would make two
  // owners of one list and a loop out of a checkbox.
  const lastMirrored = useRef<string>("");
  useEffect(() => {
    if (onSelectionChange === undefined) return;
    const key = selectedIds.join(",");
    if (key === lastMirrored.current) return;
    lastMirrored.current = key;
    onSelectionChange(selectedIds);
  }, [selectedIds, onSelectionChange]);

  // The dashboard clearing its copy (its "Clear" affordance, or a navigation) clears the store too.
  // Guarded on a non-empty store so the initial empty prop cannot fight a selection made before the
  // first mirror lands.
  const propKey = (selectedIdsProp ?? []).join(",");
  useEffect(() => {
    if (selectedIdsProp === undefined) return;
    if (selectedIdsProp.length === 0 && lastMirrored.current !== "") {
      lastMirrored.current = "";
      clearSelected();
    }
    // `propKey` is the stable identity of the array; the array itself is a new reference every render.
  }, [propKey, selectedIdsProp, clearSelected]);

  // The href of the list AS IT IS RIGHT NOW — filters, sort and page — so a ticket opened from it can
  // send the reader back to what they were looking at rather than to a default board.
  const backHref = ticketQueryHref(pathname, query, { includeQueueKey: showQueue });
  // From `page.rows` rather than from `table.getRowModel()`, because the columns are built BEFORE the
  // table exists. Same data in the same order: pagination and sorting are both manual, so the table
  // renders `page.rows` as given.
  const pageRowIds = useMemo(() => page.rows.map((r) => r.id), [page.rows]);

  const columns = useMemo(
    () => buildColumns({ viewer, assigneesByQueue, showQueue, onPreview, rowIds: pageRowIds, backHref }),
    [viewer, assigneesByQueue, showQueue, onPreview, pageRowIds, backHref],
  );

  const pagination: PaginationState = { pageIndex: Math.max(0, page.page - 1), pageSize: page.pageSize };
  const sorting: SortingState = [{ id: query.sort, desc: query.dir === "desc" }];

  const navigate = (next: TicketListQuery) => {
    const href = ticketQueryHref(pathname, next, { includeQueueKey: showQueue });
    startTransition(() => router.push(href, { scroll: false }));
  };

  const table = useReactTable({
    data: page.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    manualPagination: true,
    manualSorting: true,
    enableSortingRemoval: false,
    enableMultiSort: false,
    rowCount: page.total,
    state: { pagination, sorting },
    onPaginationChange: (updater) => {
      const next = typeof updater === "function" ? updater(pagination) : updater;
      const nextQuery: TicketListQuery = { ...query, pageSize: next.pageSize };
      // A page-size change restarts at page 1 so the operator never lands on an out-of-range page.
      nextQuery.page = next.pageSize !== pagination.pageSize ? 1 : next.pageIndex + 1;
      navigate(nextQuery);
    },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const first = next[0];
      if (!first || !isTicketSort(first.id)) return;
      navigate({ ...query, sort: first.id, dir: first.desc ? "desc" : "asc", page: 1 });
    },
  });

  const rows = table.getRowModel().rows;
  const rowIds = useMemo(() => rows.map((r) => r.original.id), [rows]);
  const rowKey = rowIds.join(",");
  const selectedOnPage = useMemo(() => selectedIds.filter((id) => rowIds.includes(id)), [selectedIds, rowIds]);
  const allSelected = rowIds.length > 0 && selectedOnPage.length === rowIds.length;

  /**
   * A selection is about the page currently on screen. Change a filter, a sort or a page and the rows
   * underneath it change meaning, so the selection is dropped rather than silently re-pointed at
   * tickets the operator never looked at.
   */
  useEffect(() => {
    clearSelected();
  }, [rowKey, clearSelected]);

  /**
   * The swipe context. Written on every render of a new page so the ticket page can walk the list the
   * operator arrived from. `href` keeps the filters, so "back" returns to the same board.
   */
  useEffect(() => {
    const qs = search?.toString() ?? "";
    const href = qs.length > 0 ? `${pathname}?${qs}` : pathname;
    try {
      window.sessionStorage.setItem(TICKET_LIST_CONTEXT_KEY, JSON.stringify({ href, ids: rowIds }));
    } catch {
      // Private mode or blocked storage: the swipe affordance simply does not appear.
    }
  }, [rowKey, rowIds, pathname, search]);

  /** Long-press on a phone card enters select mode and ticks that card. 500 ms, cancelled by a move. */
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPress = useCallback(() => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);
  const onCardPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (selectMode) return;
      const target = e.target;
      const card = target instanceof Element ? target.closest("[data-ticket-id]") : null;
      const id = card?.getAttribute("data-ticket-id") ?? null;
      if (id === null) return;
      cancelPress();
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null;
        setSelectMode(true);
        toggleSelected(id);
      }, 500);
    },
    [selectMode, cancelPress, setSelectMode, toggleSelected],
  );
  useEffect(() => cancelPress, [cancelPress]);

  const total = page.total;
  const pageCount = Math.max(1, Math.ceil(total / page.pageSize));
  const from = total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const to = Math.min(total, page.page * page.pageSize);
  const filtersActive = hasActiveFilters(query, { includeQueueKey: showQueue });

  const clearFilters = () =>
    navigate({
      sort: "resolutionDueAt",
      dir: "asc",
      page: 1,
      pageSize: query.pageSize,
      ...(showQueue ? {} : query.queueKey !== undefined ? { queueKey: query.queueKey } : {}),
    });

  return (
    <div className="flex flex-col gap-2" aria-busy={pending || undefined} data-pending={pending || undefined}>
      {rows.length === 0 ? (
        // Shared empty state — rendered once for both presentations.
        <div
          className={cn(
            "flex min-h-24 flex-col items-center justify-center gap-2 rounded-lg border bg-card p-4 text-center text-sm text-muted-foreground transition-opacity",
            pending && "opacity-70",
          )}
        >
          {filtersActive ? (
            <>
              <span>No tickets match these filters.</span>
              <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            </>
          ) : (
            <span>No tickets.</span>
          )}
        </div>
      ) : (
        <>
          {/* md+: the dense table */}
          <div className={cn("hidden rounded-lg border bg-card transition-opacity md:block", pending && "opacity-70")}>
            <Table className="text-[13px]">
              <TableHeader className="bg-muted/40">
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id} className="hover:bg-transparent">
                    <TableHead className="h-8 w-9 px-2">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(v) => (v === true ? setSelected(rowIds) : clearSelected())}
                        aria-label={allSelected ? "Clear the selection" : `Select all ${rowIds.length} tickets on this page`}
                      />
                    </TableHead>
                    {hg.headers.map((header) => {
                      const canSort = header.column.getCanSort();
                      const sorted = header.column.getIsSorted();
                      const label = header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext());
                      return (
                        <TableHead
                          key={header.id}
                          className={cn("h-8 text-xs text-muted-foreground", COLUMN_CLASSES[header.column.id])}
                          aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : canSort ? "none" : undefined}
                        >
                          {canSort ? (
                            <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                                sorted && "text-foreground",
                              )}
                            >
                              {label}
                              {sorted === "asc" ? (
                                <ArrowUp aria-hidden className="size-3" />
                              ) : sorted === "desc" ? (
                                <ArrowDown aria-hidden className="size-3" />
                              ) : (
                                <ChevronsUpDown aria-hidden className="size-3 opacity-50" />
                              )}
                            </button>
                          ) : (
                            label
                          )}
                        </TableHead>
                      );
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const t = row.original;
                  return (
                    <TableRow
                      key={row.id}
                      tabIndex={0}
                      data-ticket-id={t.id}
                      {...{ [SHORTCUT_ROW_ATTR]: t.id }}
                      data-status={t.status}
                      className={cn(
                        "cursor-pointer outline-none focus-visible:bg-muted/60",
                        t.status === "CLOSED" && "text-muted-foreground",
                        t.sla.status === "BREACHED" && t.status !== "CLOSED" && "bg-destructive/[0.03]",
                      )}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest(INTERACTIVE_SELECTOR)) return;
                        onPreview(t.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onPreview(t.id);
                        }
                      }}
                      aria-label={`Ticket HD-${t.number}: ${t.subject}`}
                      data-selected={selectedIds.includes(t.id) || undefined}
                    >
                      <TableCell className="w-9 px-2 py-1.5">
                        <Checkbox
                          checked={selectedIds.includes(t.id)}
                          onCheckedChange={() => toggleSelected(t.id)}
                          aria-label={`Select ticket HD-${t.number}`}
                        />
                      </TableCell>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className={cn("py-1.5", COLUMN_CLASSES[cell.column.id])}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* phone: a visible way into select mode, because a long-press alone is undiscoverable */}
          <div className="flex items-center justify-between gap-2 md:hidden">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11"
              onClick={() => setSelectMode(!selectMode)}
              aria-pressed={selectMode}
            >
              {selectMode ? "Done selecting" : "Select tickets"}
            </Button>
            {selectMode ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11"
                onClick={() => (allSelected ? clearSelected() : setSelected(rowIds))}
              >
                {allSelected ? "Clear all" : "Select all"}
              </Button>
            ) : (
              <span className="pe-1 text-xs text-muted-foreground">Press and hold a ticket to select</span>
            )}
          </div>

          {/* phone: the same rows as cards, or as a checkable list while selecting */}
          {selectMode ? (
            <ol className={cn("flex flex-col gap-2 transition-opacity md:hidden", pending && "opacity-70")} aria-label="Select tickets">
              {rows.map((row) => {
                const t = row.original;
                const checked = selectedIds.includes(t.id);
                return (
                  <li key={row.id} data-ticket-id={t.id} data-selected={checked || undefined}>
                    <label
                      className={cn(
                        "flex min-h-11 items-start gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10",
                        checked && "ring-2 ring-primary",
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleSelected(t.id)}
                        className="mt-0.5 size-5"
                        aria-label={`Select ticket ${formatTicketNumber(t.number)}: ${t.subject}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="font-mono tabular-nums">{formatTicketNumber(t.number)}</span>
                          <StatusBadge status={t.status} />
                        </span>
                        <span className="mt-0.5 block truncate text-sm font-medium">{t.subject}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ol>
          ) : (
            <ol
              className={cn("flex flex-col gap-2 transition-opacity md:hidden", pending && "opacity-70")}
              aria-label="Tickets"
              onPointerDown={onCardPointerDown}
              onPointerUp={cancelPress}
              onPointerMove={cancelPress}
              onPointerCancel={cancelPress}
            >
              {rows.map((row) => (
                <TicketCard
                  key={row.id}
                  row={row.original}
                  viewer={viewer}
                  assignees={assigneesByQueue[row.original.queueKey] ?? []}
                  showQueue={showQueue}
                  onPreview={onPreview}
                  listContext={listContextFor(pageRowIds, row.original.id, backHref)}
                />
              ))}
            </ol>
          )}
        </>
      )}

      {/* One footer / pager for both presentations */}
      <div className="flex flex-col items-stretch gap-2 px-0.5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center justify-between gap-3 sm:justify-start">
          <span className="tabular-nums" aria-live="polite">
            {total === 0 ? "0 tickets" : `${from}–${to} of ${total}`}
          </span>
          <label className="flex items-center gap-1.5">
            <span>Rows</span>
            <Select value={String(page.pageSize)} onValueChange={(v) => table.setPageSize(Number.parseInt(v, 10))}>
              <SelectTrigger size="sm" aria-label="Rows per page" className="min-w-16 px-1.5 md:h-6 md:text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
        <div className="flex items-center justify-between gap-1 sm:justify-end">
          <span className="mr-1 tabular-nums">
            Page {page.page} of {pageCount}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              onClick={() => table.setPageIndex(0)}
              disabled={page.page <= 1 || pending}
              aria-label="First page"
            >
              <ChevronsLeft aria-hidden />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              onClick={() => table.previousPage()}
              disabled={page.page <= 1 || pending}
              aria-label="Previous page"
            >
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              onClick={() => table.nextPage()}
              disabled={page.page >= pageCount || pending}
              aria-label="Next page"
            >
              <ChevronRight aria-hidden />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              onClick={() => table.setPageIndex(pageCount - 1)}
              disabled={page.page >= pageCount || pending}
              aria-label="Last page"
            >
              <ChevronsRight aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
