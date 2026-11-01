"use client";

/**
 * The /reports control bar: which report, over what dates, at what granularity, narrowed to which
 * queues, priorities and categories.
 *
 * Two commit styles, deliberately different:
 *  - **The report picker and the date presets navigate immediately.** They are a choice of screen, like
 *    a tab; making an operator press Apply to move from Volume to Backlog is friction with no purpose.
 *    (The audit log commits everything explicitly because every render there writes an
 *    `AUDIT_LOG_VIEWED` row. A report page writes none — CONTRACT §3.3 rule 5 — so the cost of an extra
 *    navigation is a query, not a ledger entry.)
 *  - **Everything else commits on Apply**, so a half-typed date range never runs a report.
 *
 * Phones get a `FilterSheet` holding the same fields with Reset / Apply in its footer, plus removable
 * chips built from the APPLIED query; md+ gets the inline grid form. One component, one draft, one URL
 * writer (`reportQueryToParams`) — the export link is built from the same function, so the file can
 * never describe a different set than the screen (convention 12).
 *
 * The preset DATES are computed on the server and passed in. Deriving "last 30 days" here would put the
 * browser's clock and the firm clock on the same page and hydrate to two different ranges.
 */
import { useId, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, Search, X } from "lucide-react";
import type { TicketCategory, TicketPriority } from "@/types/domain";
import { CATEGORY_LABELS, TICKET_CATEGORIES, TICKET_PRIORITIES } from "@/types/domain";
import { PRIORITY_LABELS } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ActiveFilterChips,
  FilterSection,
  FilterSheet,
  FilterSheetTrigger,
  SNAP_ROW_CLASSES,
  type ActiveFilterChip,
} from "@/components/shell/filter-sheet";
import { reportHref, type ReportQueryLike } from "@/components/reports/report-query-params";

export type ReportOption = { key: string; label: string };
export type PresetOption = { key: string; label: string; from: string; to: string; granularity: string };

export type ReportFiltersProps = {
  /** The query the page actually ran. */
  query: ReportQueryLike;
  reports: readonly ReportOption[];
  queues: readonly ReportOption[];
  granularities: readonly ReportOption[];
  presets: readonly PresetOption[];
  /** Which preset the applied dates match, for the pressed state. */
  activePreset: string | null;
  /** False for the ranked reports, where a period has no meaning. */
  supportsGranularity: boolean;
};

type Draft = {
  from: string;
  to: string;
  granularity: string;
  queueKey: string[];
  priority: TicketPriority[];
  category: TicketCategory[];
};

function draftFromQuery(q: ReportQueryLike): Draft {
  return {
    from: q.from,
    to: q.to,
    granularity: q.granularity,
    queueKey: [...(q.queueKey ?? [])],
    priority: [...(q.priority ?? [])] as TicketPriority[],
    category: [...(q.category ?? [])] as TicketCategory[],
  };
}

function queryFromDraft(key: string, draft: Draft): ReportQueryLike {
  const next: ReportQueryLike = {
    key,
    from: draft.from,
    to: draft.to,
    granularity: draft.granularity,
  };
  if (draft.queueKey.length > 0) next.queueKey = [...draft.queueKey];
  if (draft.priority.length > 0) next.priority = [...draft.priority];
  if (draft.category.length > 0) next.category = [...draft.category];
  return next;
}

type FieldsProps = {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  idPrefix: string;
  layout: "bar" | "sheet";
  queues: readonly ReportOption[];
  granularities: readonly ReportOption[];
  supportsGranularity: boolean;
};

/** The six controls, defined once and arranged per layout (the phone sheet and the md+ form coexist). */
function ReportFilterFields({
  draft,
  setDraft,
  idPrefix,
  layout,
  queues,
  granularities,
  supportsGranularity,
}: FieldsProps): React.JSX.Element {
  const id = (name: string): string => `${idPrefix}-${name}`;
  const fieldClass = layout === "sheet" ? "flex w-full flex-col gap-1.5" : "flex flex-col gap-1.5";

  const from = (
    <div className={fieldClass}>
      <Label htmlFor={id("from")}>From</Label>
      <Input
        id={id("from")}
        type="date"
        value={draft.from}
        onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
      />
    </div>
  );

  const to = (
    <div className={fieldClass}>
      <Label htmlFor={id("to")}>To</Label>
      <Input id={id("to")} type="date" value={draft.to} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
    </div>
  );

  const granularity = (
    <div className={fieldClass}>
      <Label htmlFor={id("granularity")}>Group by</Label>
      <Select
        value={draft.granularity}
        disabled={!supportsGranularity}
        onValueChange={(v) => setDraft((d) => ({ ...d, granularity: v }))}
      >
        <SelectTrigger id={id("granularity")} className="w-full">
          <SelectValue placeholder="Day" />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {granularities.map((g) => (
            <SelectItem key={g.key} value={g.key}>
              {g.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {supportsGranularity ? null : (
        <p className="text-xs text-muted-foreground">This report ranks rows rather than periods.</p>
      )}
    </div>
  );

  const queuePicker = (
    <div className={fieldClass}>
      <Label htmlFor={id("queues")}>Queues</Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            id={id("queues")}
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            aria-label={draft.queueKey.length === 0 ? "Queues: all you can read" : `Queues: ${draft.queueKey.length} selected`}
          >
            <span className="truncate">
              {draft.queueKey.length === 0
                ? "All my queues"
                : draft.queueKey.length === 1
                  ? (queues.find((q) => q.key === draft.queueKey[0])?.label ?? draft.queueKey[0])
                  : `${draft.queueKey.length} queues`}
            </span>
            <ChevronDown aria-hidden className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
          <DropdownMenuLabel>Include queues</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {queues.map((q) => (
            <DropdownMenuCheckboxItem
              key={q.key}
              checked={draft.queueKey.includes(q.key)}
              onCheckedChange={(checked) =>
                setDraft((d) => ({
                  ...d,
                  queueKey:
                    checked === true ? [...d.queueKey, q.key] : d.queueKey.filter((k) => k !== q.key),
                }))
              }
              onSelect={(e) => e.preventDefault()}
            >
              {q.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const priorityPicker = (
    <div className={fieldClass}>
      <Label htmlFor={id("priority")}>Priority</Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            id={id("priority")}
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            aria-label={draft.priority.length === 0 ? "Priority: any" : `Priority: ${draft.priority.length} selected`}
          >
            <span className="truncate">
              {draft.priority.length === 0
                ? "Any priority"
                : draft.priority.length === 1
                  ? PRIORITY_LABELS[draft.priority[0]]
                  : `${draft.priority.length} priorities`}
            </span>
            <ChevronDown aria-hidden className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
          <DropdownMenuLabel>Include priorities</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {TICKET_PRIORITIES.map((p) => (
            <DropdownMenuCheckboxItem
              key={p}
              checked={draft.priority.includes(p)}
              onCheckedChange={(checked) =>
                setDraft((d) => ({
                  ...d,
                  priority: checked === true ? [...d.priority, p] : d.priority.filter((x) => x !== p),
                }))
              }
              onSelect={(e) => e.preventDefault()}
            >
              {PRIORITY_LABELS[p]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const categoryPicker = (
    <div className={fieldClass}>
      <Label htmlFor={id("category")}>Category</Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            id={id("category")}
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            aria-label={draft.category.length === 0 ? "Category: any" : `Category: ${draft.category.length} selected`}
          >
            <span className="truncate">
              {draft.category.length === 0
                ? "Any category"
                : draft.category.length === 1
                  ? CATEGORY_LABELS[draft.category[0]]
                  : `${draft.category.length} categories`}
            </span>
            <ChevronDown aria-hidden className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[min(20rem,60svh)] w-(--radix-dropdown-menu-trigger-width) min-w-56 overflow-y-auto"
        >
          <DropdownMenuLabel>Include categories</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {TICKET_CATEGORIES.map((c) => (
            <DropdownMenuCheckboxItem
              key={c}
              checked={draft.category.includes(c)}
              onCheckedChange={(checked) =>
                setDraft((d) => ({
                  ...d,
                  category: checked === true ? [...d.category, c] : d.category.filter((x) => x !== c),
                }))
              }
              onSelect={(e) => e.preventDefault()}
            >
              {CATEGORY_LABELS[c]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  if (layout === "bar") {
    return (
      <>
        {from}
        {to}
        {granularity}
        {queuePicker}
        {priorityPicker}
        {categoryPicker}
      </>
    );
  }

  return (
    <>
      <FilterSection label="Dates">
        {from}
        {to}
        {granularity}
      </FilterSection>
      <FilterSection label="Narrow to">
        {queuePicker}
        {priorityPicker}
        {categoryPicker}
      </FilterSection>
    </>
  );
}

export function ReportFilters({
  query,
  reports,
  queues,
  granularities,
  presets,
  activePreset,
  supportsGranularity,
}: ReportFiltersProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = useState<Draft>(() => draftFromQuery(query));
  const [open, setOpen] = useState(false);
  const barId = useId();
  const sheetId = useId();
  const reportId = useId();

  function navigate(next: ReportQueryLike): void {
    router.replace(reportHref(pathname, next));
  }

  function apply(): void {
    navigate(queryFromDraft(query.key, draft));
  }

  function onReset(): void {
    const next = draftFromQuery({ ...query, queueKey: [], priority: [], category: [] });
    setDraft(next);
    navigate(queryFromDraft(query.key, next));
  }

  function chooseReport(key: string): void {
    navigate(queryFromDraft(key, draft));
  }

  function choosePreset(preset: PresetOption): void {
    const next: Draft = { ...draft, from: preset.from, to: preset.to, granularity: preset.granularity };
    setDraft(next);
    navigate(queryFromDraft(query.key, next));
  }

  function removeQueue(key: string): void {
    const next: Draft = { ...draft, queueKey: draft.queueKey.filter((k) => k !== key) };
    setDraft(next);
    navigate(queryFromDraft(query.key, next));
  }

  const chips: ActiveFilterChip[] = [
    ...(query.queueKey ?? []).map((k) => ({
      key: `queue-${k}`,
      label: queues.find((q) => q.key === k)?.label ?? k,
      onRemove: () => removeQueue(k),
    })),
    ...(query.priority ?? []).map((p) => ({
      key: `priority-${p}`,
      label: PRIORITY_LABELS[p as TicketPriority] ?? p,
      onRemove: () => {
        const next: Draft = { ...draft, priority: draft.priority.filter((x) => x !== p) };
        setDraft(next);
        navigate(queryFromDraft(query.key, next));
      },
    })),
    ...(query.category ?? []).map((c) => ({
      key: `category-${c}`,
      label: CATEGORY_LABELS[c as TicketCategory] ?? c,
      onRemove: () => {
        const next: Draft = { ...draft, category: draft.category.filter((x) => x !== c) };
        setDraft(next);
        navigate(queryFromDraft(query.key, next));
      },
    })),
  ];
  const activeCount = chips.length;

  return (
    <div className="flex flex-col gap-3">
      {/* Which report. A Select rather than tabs: there are ten, and a tab strip of ten is a scroller. */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={reportId}>Report</Label>
        <Select value={query.key} onValueChange={chooseReport}>
          <SelectTrigger id={reportId} className="w-full md:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {reports.map((r) => (
              <SelectItem key={r.key} value={r.key}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Date presets: a snap row on phones, a plain wrap at md+ (the QA allowlist covers data-snap-row). */}
      <ul data-snap-row aria-label="Date presets" className={`${SNAP_ROW_CLASSES} md:flex-wrap md:overflow-visible`}>
        {presets.map((p) => (
          <li key={p.key} className="snap-start shrink-0">
            <Button
              type="button"
              size="sm"
              // The global phone rule sets a 44 px minimum height and no minimum width, so a short
              // preset label would collapse on the horizontal axis (the `/inbox` "All" chip measured
              // 39x44). Same floor as the admin filter chips.
              className="min-h-11 min-w-11 md:min-h-8"
              variant={activePreset === p.key ? "default" : "outline"}
              aria-pressed={activePreset === p.key}
              onClick={() => choosePreset(p)}
            >
              {p.label}
            </Button>
          </li>
        ))}
      </ul>

      {/* Phone: trigger + sheet + applied chips */}
      <div className="flex flex-col gap-2 md:hidden" data-report-filters-phone>
        <FilterSheetTrigger
          activeCount={activeCount}
          expanded={open}
          onClick={() => setOpen(true)}
          label="Dates and filters"
          className="w-full sm:w-auto sm:self-start"
        />
        <FilterSheet
          open={open}
          onOpenChange={setOpen}
          title="Report filters"
          activeCount={activeCount}
          onClearAll={onReset}
          footer={
            <>
              <Button type="button" variant="ghost" onClick={onReset}>
                <X aria-hidden />
                Reset
              </Button>
              <Button
                type="button"
                className="flex-1"
                onClick={() => {
                  apply();
                  setOpen(false);
                }}
              >
                <Search aria-hidden />
                Apply
              </Button>
            </>
          }
        >
          <ReportFilterFields
            draft={draft}
            setDraft={setDraft}
            idPrefix={sheetId}
            layout="sheet"
            queues={queues}
            granularities={granularities}
            supportsGranularity={supportsGranularity}
          />
        </FilterSheet>
        <ActiveFilterChips chips={chips} onClearAll={onReset} />
      </div>

      {/* md+: the inline form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
        className="hidden gap-3 rounded-lg border bg-card p-3 text-card-foreground md:grid md:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]"
        aria-label="Report filters"
        data-report-filters
      >
        <ReportFilterFields
          draft={draft}
          setDraft={setDraft}
          idPrefix={barId}
          layout="bar"
          queues={queues}
          granularities={granularities}
          supportsGranularity={supportsGranularity}
        />
        <div className="flex items-end gap-2 md:col-span-full md:justify-end">
          {activeCount > 0 ? (
            <span className="mr-auto self-center text-xs text-muted-foreground">
              {activeCount} filter{activeCount === 1 ? "" : "s"} applied
            </span>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={onReset}>
            <X aria-hidden />
            Reset
          </Button>
          <Button type="submit" size="sm">
            <Search aria-hidden />
            Apply
          </Button>
        </div>
      </form>
    </div>
  );
}
