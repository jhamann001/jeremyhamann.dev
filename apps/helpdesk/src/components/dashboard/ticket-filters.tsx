"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowDownNarrowWide, ArrowUpNarrowWide, CalendarRange, Inbox, Search, Tags, X } from "lucide-react";
import type {
  AssigneeOption,
  FollowUpFilter,
  QueueKey,
  SlaStatus,
  TicketBrand,
  TicketCategory,
  TicketListQuery,
  TicketPriority,
  TicketSort,
  TicketSource,
  TicketStatus,
} from "@/types/domain";
import {
  BRAND_LABELS,
  CATEGORY_LABELS,
  FOLLOW_UP_FILTERS,
  QUEUE_KEYS,
  QUEUE_LABELS,
  SLA_STATUSES,
  SOURCE_LABELS,
  TICKET_BRANDS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_SORTS,
  TICKET_SOURCES,
  TICKET_STATUSES,
} from "@/types/domain";
import { PRIORITY_LABELS, SLA_LABELS, STATUS_LABELS } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ActiveFilterChips,
  FilterCheckboxList,
  FilterDateRange,
  FilterSection,
  FilterSheet,
  FilterSheetTrigger,
  type ActiveFilterChip,
  type FilterCheckboxOption,
} from "@/components/shell/filter-sheet";
import {
  COMPLAINT_FILTER_LABELS,
  DEFAULT_DIR,
  DEFAULT_SORT,
  DEFAULT_STATUS_FILTER,
  FOLLOW_UP_FILTER_LABELS,
  SORT_LABELS,
  dateInputToIsoEndExclusive,
  dateInputToIsoStart,
  hasActiveFilters,
  isoEndExclusiveToDateInput,
  isoToDateInput,
  ticketQueryHref,
} from "@/components/dashboard/ticket-query-params";
import { buildTicketFilterChips, requesterFilterLabel } from "@/components/dashboard/ticket-filter-chips";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// URL serialization — the single writer S5 surfaces share (filters, table pagination/sorting).
// The serializer itself moved to ./ticket-query-params in Wave A so it can be unit tested in the
// repo's `node` vitest environment (no DOM, no testing-library) without importing this client
// component. Re-exported here so `ticket-table.tsx` and the export button keep one import path.
// ---------------------------------------------------------------------------

export {
  PAGE_SIZE_OPTIONS,
  hasActiveFilters,
  ticketExportHref,
  ticketQueryHref,
  ticketQueryToParams,
} from "@/components/dashboard/ticket-query-params";

// ---------------------------------------------------------------------------
// Controls — each rendered twice: inline in the md+ bar (`layout="bar"`) and inside the phone
// FilterSheet (`layout="sheet"`). Same handlers, same URL writer; only the chrome differs.
// ---------------------------------------------------------------------------

/** Radix Select forbids an empty-string item value; "anyone" travels under a sentinel. */
const ANY = "__any__";
const SEARCH_DEBOUNCE_MS = 300;

type Layout = "bar" | "sheet";

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Dense inline chip (md+ bar). */
function Chip({
  pressed,
  onClick,
  children,
  className,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size="xs"
      variant={pressed ? "secondary" : "ghost"}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn("h-6 px-1.5 font-normal", pressed ? "ring-1 ring-foreground/15" : "text-muted-foreground", className)}
    >
      {children}
    </Button>
  );
}

/** Tap-sized chip (phone sheet); 44px via the globals.css phone rule, `min-w-11` for short labels. */
function SheetChip({
  pressed,
  onClick,
  children,
  className,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant={pressed ? "secondary" : "outline"}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn("min-w-11", pressed && "ring-1 ring-foreground/15", className)}
    >
      {children}
    </Button>
  );
}

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <fieldset className="flex min-w-0 flex-wrap items-center gap-0.5 rounded-md border border-dashed px-1 py-0.5">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden className="px-1 text-[11px] text-muted-foreground">
        {label}
      </span>
      {children}
    </fieldset>
  );
}

/** One multi-select group (Status / Priority / SLA) in either layout. */
function ToggleChips<T extends string>({
  label,
  options,
  labels,
  selected,
  onChange,
  layout,
  chipClass,
}: {
  label: string;
  options: readonly T[];
  labels: Readonly<Record<T, string>>;
  selected: readonly T[];
  onChange: (next: T[]) => void;
  layout: Layout;
  chipClass?: (value: T, pressed: boolean) => string | undefined;
}): React.JSX.Element {
  if (layout === "sheet") {
    return (
      <FilterSection label={label}>
        {options.map((o) => {
          const pressed = selected.includes(o);
          return (
            <SheetChip key={o} pressed={pressed} onClick={() => onChange(toggle(selected, o))} className={chipClass?.(o, pressed)}>
              {labels[o]}
            </SheetChip>
          );
        })}
      </FilterSection>
    );
  }
  return (
    <ChipGroup label={label}>
      {options.map((o) => {
        const pressed = selected.includes(o);
        return (
          <Chip key={o} pressed={pressed} onClick={() => onChange(toggle(selected, o))} className={chipClass?.(o, pressed)}>
            {labels[o]}
          </Chip>
        );
      })}
    </ChipGroup>
  );
}

function slaChipClass(s: SlaStatus, pressed: boolean): string | undefined {
  if (!pressed) return undefined;
  if (s === "BREACHED") return "text-destructive";
  if (s === "WARNING") return "text-amber-800 dark:text-amber-200";
  return undefined;
}

function QueueSelect({
  value,
  queues,
  onChange,
  layout,
}: {
  value: QueueKey | undefined;
  queues: readonly QueueKey[];
  onChange: (value: string) => void;
  layout: Layout;
}): React.JSX.Element {
  return (
    <Select value={value ?? ANY} onValueChange={onChange}>
      <SelectTrigger
        size={layout === "bar" ? "sm" : "default"}
        aria-label="Queue"
        className={layout === "bar" ? "min-w-36" : "w-full"}
      >
        <SelectValue placeholder="All queues" />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectItem value={ANY}>All queues</SelectItem>
        {queues.map((q) => (
          <SelectItem key={q} value={q}>
            {QUEUE_LABELS[q]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AssigneeFilterSelect({
  value,
  assignees,
  onChange,
  layout,
}: {
  value: string | undefined;
  assignees: AssigneeOption[];
  onChange: (value: string) => void;
  layout: Layout;
}): React.JSX.Element {
  const unknownSelected =
    value !== undefined && value !== "me" && value !== "unassigned" && !assignees.some((a) => a.id === value);
  return (
    <Select value={value ?? ANY} onValueChange={onChange}>
      <SelectTrigger
        size={layout === "bar" ? "sm" : "default"}
        aria-label="Assignee"
        className={layout === "bar" ? "min-w-40" : "w-full"}
      >
        <SelectValue placeholder="Anyone" />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectItem value={ANY}>Anyone</SelectItem>
        <SelectItem value="me">Assigned to me</SelectItem>
        <SelectItem value="unassigned">Unassigned</SelectItem>
        {assignees.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name?.trim() || a.email}
          </SelectItem>
        ))}
        {unknownSelected ? (
          <SelectItem value={value} disabled>
            Selected user
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}

function SortControls({
  sort,
  dir,
  onSort,
  onFlip,
  layout,
}: {
  sort: TicketSort;
  dir: "asc" | "desc";
  onSort: (value: string) => void;
  onFlip: () => void;
  layout: Layout;
}): React.JSX.Element {
  const bar = layout === "bar";
  return (
    <div className={bar ? "contents" : "grid w-full grid-cols-[1fr_auto] gap-2"}>
      <Select value={sort} onValueChange={onSort}>
        <SelectTrigger size={bar ? "sm" : "default"} aria-label="Sort by" className={bar ? "min-w-28" : "w-full"}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align={bar ? "end" : "start"}>
          {TICKET_SORTS.map((s) => (
            <SelectItem key={s} value={s}>
              {SORT_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size={bar ? "icon-sm" : "icon"}
        onClick={onFlip}
        aria-label={dir === "asc" ? "Sorted ascending — click for descending" : "Sorted descending — click for ascending"}
        title={dir === "asc" ? "Ascending" : "Descending"}
      >
        {dir === "asc" ? <ArrowUpNarrowWide aria-hidden /> : <ArrowDownNarrowWide aria-hidden />}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wave A filter controls (the build record S6/S7). Each renders in both layouts from the
// same handlers and the same URL writer, exactly like the chip groups above.
// ---------------------------------------------------------------------------

const CATEGORY_OPTIONS: readonly FilterCheckboxOption[] = TICKET_CATEGORIES.map((c) => ({
  value: c,
  label: CATEGORY_LABELS[c],
}));

const SOURCE_OPTIONS: readonly FilterCheckboxOption[] = TICKET_SOURCES.map((s) => ({
  value: s,
  label: SOURCE_LABELS[s],
}));

/**
 * One option set too long for a chip row — Category is 22 values after Decision #61 and Source is 9.
 * A scrollable checkbox list in a Popover at md+, and the same list inline in the phone sheet (no
 * nested sheet: a sheet inside a sheet traps focus badly and Radix would stack two overlays).
 *
 * `values` is the enum's own tuple: the toggle refuses anything outside it, so a stale option can
 * never write a value the parser would reject.
 */
function CheckboxListFilter<T extends string>({
  label,
  icon,
  options,
  values,
  selected,
  onChange,
  layout,
  open,
  onOpenChange,
  columns = 1,
}: {
  label: string;
  icon: React.ReactNode;
  options: readonly FilterCheckboxOption[];
  values: readonly T[];
  selected: readonly T[];
  onChange: (next: T[]) => void;
  layout: Layout;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns?: 1 | 2;
}): React.JSX.Element {
  const toggleValue = (value: string) => {
    if (!(values as readonly string[]).includes(value)) return;
    onChange(toggle(selected, value as T));
  };

  const list = (
    <FilterCheckboxList
      label={label}
      options={options}
      selected={selected}
      onToggle={toggleValue}
      columns={columns}
    />
  );

  if (layout === "sheet") return <FilterSection label={label}>{list}</FilterSection>;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={selected.length > 0 ? "secondary" : "outline"}
          aria-label={`${label} filter, ${selected.length} selected`}
        >
          {icon}
          {label}
          {selected.length > 0 ? <span className="tabular-nums">({selected.length})</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
          {selected.length > 0 ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => onChange([])}>
              Clear
            </Button>
          ) : null}
        </div>
        {list}
      </PopoverContent>
    </Popover>
  );
}

/**
 * `isComplaint` is tri-state in the query (`true` / `false` / unset), so it is two mutually exclusive
 * chips rather than a checkbox: pressing the pressed one clears the filter.
 */
function ComplaintChips({
  value,
  onChange,
  layout,
}: {
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
  layout: Layout;
}): React.JSX.Element {
  const entries: Array<{ key: "yes" | "no"; on: boolean }> = [
    { key: "yes", on: true },
    { key: "no", on: false },
  ];
  const ChipComp = layout === "sheet" ? SheetChip : Chip;
  const body = entries.map(({ key, on }) => (
    <ChipComp
      key={key}
      pressed={value === on}
      onClick={() => onChange(value === on ? undefined : on)}
      className={value === on && on ? "text-red-800 dark:text-red-200" : undefined}
    >
      {COMPLAINT_FILTER_LABELS[key]}
    </ChipComp>
  ));
  return layout === "sheet" ? (
    <FilterSection label="Complaint">{body}</FilterSection>
  ) : (
    <ChipGroup label="Complaint">{body}</ChipGroup>
  );
}

/** Single-select: pressing the pressed chip clears the filter. */
function FollowUpChips({
  value,
  onChange,
  layout,
}: {
  value: FollowUpFilter | undefined;
  onChange: (next: FollowUpFilter | undefined) => void;
  layout: Layout;
}): React.JSX.Element {
  const ChipComp = layout === "sheet" ? SheetChip : Chip;
  const body = FOLLOW_UP_FILTERS.map((f) => (
    <ChipComp
      key={f}
      pressed={value === f}
      onClick={() => onChange(value === f ? undefined : f)}
      className={value === f && f === "overdue" ? "text-destructive" : undefined}
    >
      {FOLLOW_UP_FILTER_LABELS[f]}
    </ChipComp>
  ));
  return layout === "sheet" ? (
    <FilterSection label="Follow-up">{body}</FilterSection>
  ) : (
    <ChipGroup label="Follow-up">{body}</ChipGroup>
  );
}

/** Created-date range. The URL holds ISO instants; the control speaks local calendar days. */
function CreatedRangeFilter({
  fromIso,
  toIso,
  onFromChange,
  onToChange,
  layout,
  open,
  onOpenChange,
}: {
  fromIso: string | undefined;
  toIso: string | undefined;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  layout: Layout;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const fromValue = isoToDateInput(fromIso);
  const toValue = isoEndExclusiveToDateInput(toIso);
  const count = (fromValue.length > 0 ? 1 : 0) + (toValue.length > 0 ? 1 : 0);
  const range = (
    <FilterDateRange
      fromValue={fromValue}
      toValue={toValue}
      onFromChange={onFromChange}
      onToChange={onToChange}
      fromLabel="Created from"
      toLabel="Created to"
    />
  );

  if (layout === "sheet") return <FilterSection label="Created">{range}</FilterSection>;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={count > 0 ? "secondary" : "outline"}
          aria-label={`Created date range, ${count} of 2 bounds set`}
        >
          <CalendarRange aria-hidden />
          Created
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Created</span>
          {count > 0 ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                onFromChange("");
                onToChange("");
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
        {range}
        <p className="mt-2 text-[11px] text-muted-foreground">Both days are included.</p>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// TicketFilters
// ---------------------------------------------------------------------------

/**
 * URL-driven filter bar. Every change is written with `router.replace` (filters are ephemeral view
 * state, not navigation) and resets `page` to 1. Search is debounced 300 ms.
 *
 * Phone (< md): search box + "Filters (n)" trigger opening a bottom `FilterSheet`, then removable
 * `ActiveFilterChips`; md+: the inline controls and chip groups as before. Both presentations call the
 * same `write()` — there is exactly one URL writer (§4.3 item 3).
 *
 * `queues` and `total` are S5-internal optional props: the dashboard passes the viewer's readable queues
 * so the queue selector never offers a queue that would only ever return an empty page, and the list total
 * so the sheet footer can read "Show N tickets".
 */
export function TicketFilters({
  query,
  assignees,
  showQueue,
  queues = QUEUE_KEYS,
  total,
  requesterName,
}: {
  query: TicketListQuery;
  assignees: AssigneeOption[];
  showQueue: boolean;
  queues?: readonly QueueKey[];
  total?: number;
  /**
   * Display name for an active `requesterExternalId` filter, resolved by the caller from the rows.
   * The filter key is opaque on purpose and the chip must never print the id or the address.
   */
  requesterName?: string;
}): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [createdOpen, setCreatedOpen] = useState(false);

  const write = (next: TicketListQuery, mode: "replace" | "push" = "replace") => {
    const href = ticketQueryHref(pathname, { ...next, page: 1 }, { includeQueueKey: showQueue });
    startTransition(() => {
      if (mode === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    });
  };

  // --- Search (debounced). `pendingWrites` distinguishes our own in-flight URL writes from external
  // navigation (back/forward), so a slow RSC response never overwrites what the operator is typing.
  const [search, setSearch] = useState(query.search ?? "");
  const pendingWrites = useRef<string[]>([]);
  const serverSearch = query.search ?? "";

  useEffect(() => {
    const idx = pendingWrites.current.indexOf(serverSearch);
    if (idx >= 0) {
      pendingWrites.current.splice(0, idx + 1);
      return;
    }
    pendingWrites.current = [];
    setSearch(serverSearch);
  }, [serverSearch]);

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === serverSearch) return;
    const id = window.setTimeout(() => {
      pendingWrites.current.push(trimmed);
      const next: TicketListQuery = { ...query };
      if (trimmed.length > 0) next.search = trimmed;
      else delete next.search;
      write(next);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
    // `query` and `write` are intentionally excluded: only the typed value should schedule a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, serverSearch]);

  const statuses: readonly TicketStatus[] = query.status ?? DEFAULT_STATUS_FILTER;
  const priorities: readonly TicketPriority[] = query.priority ?? [];
  const slaStatuses: readonly SlaStatus[] = query.slaStatus ?? [];
  const categories: readonly TicketCategory[] = query.category ?? [];
  const brands: readonly TicketBrand[] = query.brand ?? [];
  const sources: readonly TicketSource[] = query.source ?? [];
  const active = hasActiveFilters(query, { includeQueueKey: showQueue });

  const setStatuses = (next: TicketStatus[]) => {
    const q: TicketListQuery = { ...query };
    if (next.length > 0) q.status = next;
    else delete q.status;
    write(q);
  };
  const setPriorities = (next: TicketPriority[]) => {
    const q: TicketListQuery = { ...query };
    if (next.length > 0) q.priority = next;
    else delete q.priority;
    write(q);
  };
  const setSla = (next: SlaStatus[]) => {
    const q: TicketListQuery = { ...query };
    if (next.length > 0) q.slaStatus = next;
    else delete q.slaStatus;
    write(q);
  };
  const setAssignee = (value: string) => {
    const q: TicketListQuery = { ...query };
    if (value === ANY) delete q.assigneeId;
    else q.assigneeId = value;
    write(q);
  };
  const setQueue = (value: string) => {
    const q: TicketListQuery = { ...query };
    if (value === ANY) delete q.queueKey;
    else q.queueKey = value as QueueKey;
    write(q);
  };
  const setCategories = (next: TicketCategory[]) => {
    const q: TicketListQuery = { ...query };
    if (next.length > 0) q.category = next;
    else delete q.category;
    write(q);
  };
  const setBrands = (next: TicketBrand[]) => {
    const q: TicketListQuery = { ...query };
    if (next.length > 0) q.brand = next;
    else delete q.brand;
    write(q);
  };
  const setSources = (next: TicketSource[]) => {
    const q: TicketListQuery = { ...query };
    if (next.length > 0) q.source = next;
    else delete q.source;
    write(q);
  };
  const setComplaint = (next: boolean | undefined) => {
    const q: TicketListQuery = { ...query };
    if (next === undefined) delete q.isComplaint;
    else q.isComplaint = next;
    write(q);
  };
  const setFollowUp = (next: FollowUpFilter | undefined) => {
    const q: TicketListQuery = { ...query };
    if (next === undefined) delete q.followUp;
    else q.followUp = next;
    write(q);
  };
  const setCreatedFrom = (value: string) => {
    const q: TicketListQuery = { ...query };
    const iso = dateInputToIsoStart(value);
    if (iso === undefined) delete q.createdFrom;
    else q.createdFrom = iso;
    write(q);
  };
  const setCreatedTo = (value: string) => {
    const q: TicketListQuery = { ...query };
    const iso = dateInputToIsoEndExclusive(value);
    if (iso === undefined) delete q.createdTo;
    else q.createdTo = iso;
    write(q);
  };
  /**
   * Both are set by the ticket header's requester link; there is no control for either, only a way out.
   * The header prefers `requesterExternalId` — an opaque id keeps the client's address out of the URL,
   * browser history and Cloud Run's access log — and falls back to the address when the ticket
   * carries no person pointer.
   */
  const clearRequesterEmail = () => {
    const q: TicketListQuery = { ...query };
    delete q.requesterEmail;
    write(q);
  };
  const clearRequesterExternalId = () => {
    const q: TicketListQuery = { ...query };
    delete q.requesterExternalId;
    write(q);
  };
  const setSort = (value: string) => {
    if (!(TICKET_SORTS as readonly string[]).includes(value)) return;
    write({ ...query, sort: value as TicketSort });
  };
  const flipDir = () => write({ ...query, dir: query.dir === "asc" ? "desc" : "asc" });
  const clearAll = () => {
    setSearch("");
    pendingWrites.current = [];
    const q: TicketListQuery = { sort: DEFAULT_SORT, dir: DEFAULT_DIR, page: 1, pageSize: query.pageSize };
    if (!showQueue && query.queueKey !== undefined) q.queueKey = query.queueKey;
    write(q);
  };

  // --- Active-filter chips (phone). Search is not a chip — its box is visible. Each removal is one write().
  // The set is built by the pure `buildTicketFilterChips`, which is unit-tested to cover every predicate
  // `ticketQueryToParams` serializes: a filter with no chip here would also show no count on the Filters
  // trigger and would suppress "Clear all" inside the sheet, leaving no way to remove it on a phone.
  const chips: ActiveFilterChip[] = buildTicketFilterChips(query, { showQueue, assignees, requesterName }).map((spec) => ({
    key: spec.key,
    label: spec.label,
    onRemove: () => write(spec.next),
  }));
  const activeCount = chips.length;

  const sheetFooterLabel = pending
    ? "Updating…"
    : total !== undefined
      ? `Show ${total} ${total === 1 ? "ticket" : "tickets"}`
      : "Done";

  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg border bg-card p-2 text-sm"
      role="search"
      aria-label="Ticket filters"
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
    >
      {/* Row A — search (all widths) · Filters trigger (phone) · inline controls (md+) */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-0 flex-1 md:min-w-56">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground md:left-2 md:size-3.5"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject, requester, or HD-1042"
            aria-label="Search tickets"
            // 16px on phones (iOS focus-zoom guard); desktop density returns at md
            className="pl-8 md:h-7 md:pl-7 md:text-sm"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
          />
        </div>

        <FilterSheetTrigger activeCount={activeCount} expanded={sheetOpen} onClick={() => setSheetOpen(true)} />

        {/* md+: `contents` keeps these as direct flex children of Row A so the existing bar layout is unchanged. */}
        <div className="hidden md:contents">
          {showQueue ? <QueueSelect value={query.queueKey} queues={queues} onChange={setQueue} layout="bar" /> : null}
          <AssigneeFilterSelect value={query.assigneeId} assignees={assignees} onChange={setAssignee} layout="bar" />
          <div className="ml-auto flex items-center gap-1">
            <SortControls sort={query.sort} dir={query.dir} onSort={setSort} onFlip={flipDir} layout="bar" />
            {active ? (
              <Button type="button" variant="ghost" size="sm" onClick={clearAll} aria-label="Clear all filters">
                <X aria-hidden />
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Row B — phone: removable chips for the applied filters. SNAP_ROW_CLASSES bleeds -mx-4 for the 1rem page
          gutter; this row sits inside the card's p-2, so bleed to the card border instead (twMerge collapses). */}
      <ActiveFilterChips chips={chips} onClearAll={clearAll} className="-mx-2 px-2 scroll-px-2" />

      {/* Row B — md+: the inline chip groups */}
      <div className="hidden md:flex md:flex-wrap md:items-center md:gap-1.5">
        <ToggleChips label="Status" options={TICKET_STATUSES} labels={STATUS_LABELS} selected={statuses} onChange={setStatuses} layout="bar" />
        <ToggleChips label="Priority" options={TICKET_PRIORITIES} labels={PRIORITY_LABELS} selected={priorities} onChange={setPriorities} layout="bar" />
        <ToggleChips label="SLA" options={SLA_STATUSES} labels={SLA_LABELS} selected={slaStatuses} onChange={setSla} layout="bar" chipClass={slaChipClass} />
        <ToggleChips label="Brand" options={TICKET_BRANDS} labels={BRAND_LABELS} selected={brands} onChange={setBrands} layout="bar" />
      </div>

      {/* Row C — md+: the Wave A filters (complaint log, follow-up cadence, category, source, created range) */}
      <div className="hidden md:flex md:flex-wrap md:items-center md:gap-1.5">
        <ComplaintChips value={query.isComplaint} onChange={setComplaint} layout="bar" />
        <FollowUpChips value={query.followUp} onChange={setFollowUp} layout="bar" />
        <CheckboxListFilter
          label="Category"
          icon={<Tags aria-hidden />}
          options={CATEGORY_OPTIONS}
          values={TICKET_CATEGORIES}
          selected={categories}
          onChange={setCategories}
          layout="bar"
          open={categoryOpen}
          onOpenChange={setCategoryOpen}
        />
        <CheckboxListFilter
          label="Source"
          icon={<Inbox aria-hidden />}
          options={SOURCE_OPTIONS}
          values={TICKET_SOURCES}
          selected={sources}
          onChange={setSources}
          layout="bar"
          open={sourceOpen}
          onOpenChange={setSourceOpen}
          columns={2}
        />
        <CreatedRangeFilter
          fromIso={query.createdFrom}
          toIso={query.createdTo}
          onFromChange={setCreatedFrom}
          onToChange={setCreatedTo}
          layout="bar"
          open={createdOpen}
          onOpenChange={setCreatedOpen}
        />
        {query.requesterEmail !== undefined && query.requesterEmail.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={clearRequesterEmail}
            aria-label={`Remove filter: requester ${query.requesterEmail}`}
            className="max-w-64 font-normal"
          >
            <span className="truncate">Requester: {query.requesterEmail}</span>
            <X aria-hidden />
          </Button>
        ) : null}
        {query.requesterExternalId !== undefined && query.requesterExternalId.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={clearRequesterExternalId}
            aria-label={`Remove filter: requester ${requesterFilterLabel(requesterName)}`}
            className="max-w-64 font-normal"
          >
            <span className="truncate">Requester: {requesterFilterLabel(requesterName)}</span>
            <X aria-hidden />
          </Button>
        ) : null}
      </div>

      {/* Phone filter sheet — content mounts only while open; every change writes the URL immediately and
          the sheet stays open because `sheetOpen` is local state on this same component. */}
      <FilterSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        activeCount={activeCount}
        onClearAll={clearAll}
        footer={
          <Button type="button" className="flex-1" aria-busy={pending || undefined} onClick={() => setSheetOpen(false)}>
            {sheetFooterLabel}
          </Button>
        }
      >
        <ToggleChips label="Status" options={TICKET_STATUSES} labels={STATUS_LABELS} selected={statuses} onChange={setStatuses} layout="sheet" />
        <ToggleChips label="Priority" options={TICKET_PRIORITIES} labels={PRIORITY_LABELS} selected={priorities} onChange={setPriorities} layout="sheet" />
        <ToggleChips label="SLA" options={SLA_STATUSES} labels={SLA_LABELS} selected={slaStatuses} onChange={setSla} layout="sheet" chipClass={slaChipClass} />
        <ToggleChips label="Brand" options={TICKET_BRANDS} labels={BRAND_LABELS} selected={brands} onChange={setBrands} layout="sheet" />
        {showQueue ? (
          <FilterSection label="Queue">
            <QueueSelect value={query.queueKey} queues={queues} onChange={setQueue} layout="sheet" />
          </FilterSection>
        ) : null}
        <FilterSection label="Assignee">
          <AssigneeFilterSelect value={query.assigneeId} assignees={assignees} onChange={setAssignee} layout="sheet" />
        </FilterSection>
        <ComplaintChips value={query.isComplaint} onChange={setComplaint} layout="sheet" />
        <FollowUpChips value={query.followUp} onChange={setFollowUp} layout="sheet" />
        <CheckboxListFilter
          label="Category"
          icon={<Tags aria-hidden />}
          options={CATEGORY_OPTIONS}
          values={TICKET_CATEGORIES}
          selected={categories}
          onChange={setCategories}
          layout="sheet"
          open={categoryOpen}
          onOpenChange={setCategoryOpen}
        />
        <CheckboxListFilter
          label="Source"
          icon={<Inbox aria-hidden />}
          options={SOURCE_OPTIONS}
          values={TICKET_SOURCES}
          selected={sources}
          onChange={setSources}
          layout="sheet"
          open={sourceOpen}
          onOpenChange={setSourceOpen}
        />
        <CreatedRangeFilter
          fromIso={query.createdFrom}
          toIso={query.createdTo}
          onFromChange={setCreatedFrom}
          onToChange={setCreatedTo}
          layout="sheet"
          open={createdOpen}
          onOpenChange={setCreatedOpen}
        />
        <FilterSection label="Sort">
          <SortControls sort={query.sort} dir={query.dir} onSort={setSort} onFlip={flipDir} layout="sheet" />
        </FilterSection>
      </FilterSheet>
    </div>
  );
}
