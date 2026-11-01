"use client";

import { useId, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, Search, X } from "lucide-react";
import type { AuditAction, AuditEntityType, AuditQuery } from "@/types/domain";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/types/domain";
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
  type ActiveFilterChip,
} from "@/components/shell/filter-sheet";
import { auditQueryToParams } from "@/components/audit/audit-query-params";
import { ACTION_LABELS, formatDateTime, formatTicketNumber, labelize } from "@/lib/format";

/** Radix Select forbids an empty-string item value, so "any entity" travels under a sentinel. */
const ANY_ENTITY = "__any__";

/**
 * ISO instant → `datetime-local` value expressed in UTC ("YYYY-MM-DDTHH:mm"). Rendered in UTC on both
 * server and client so the markup hydrates identically and the bound matches the ledger's canonical
 * timestamp format (the hash payload formats `occurredAt` as UTC).
 */
function isoToUtcLocalInput(iso: string | undefined): string {
  if (iso === undefined) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toISOString().slice(0, 16);
}

/** `datetime-local` value (interpreted as UTC) → ISO instant; `endOfMinute` makes an upper bound inclusive. */
function utcLocalInputToIso(value: string, endOfMinute: boolean): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const ms = Date.parse(`${trimmed}${trimmed.length === 16 ? ":00" : ""}Z`);
  if (Number.isNaN(ms)) return undefined;
  return new Date(endOfMinute ? ms + 59_999 : ms).toISOString();
}

type Draft = {
  from: string;
  to: string;
  actorEmail: string;
  action: AuditAction[];
  entityType: AuditEntityType | "";
  ticketNumber: string;
};

const EMPTY_DRAFT: Draft = { from: "", to: "", actorEmail: "", action: [], entityType: "", ticketNumber: "" };

function draftFromQuery(query: AuditQuery): Draft {
  return {
    from: isoToUtcLocalInput(query.from),
    to: isoToUtcLocalInput(query.to),
    actorEmail: query.actorEmail ?? "",
    action: query.action ? [...query.action] : [],
    entityType: query.entityType ?? "",
    ticketNumber: query.ticketNumber !== undefined ? String(query.ticketNumber) : "",
  };
}

function queryFromDraft(draft: Draft, limit: number): AuditQuery {
  const next: AuditQuery = { limit };
  const from = utcLocalInputToIso(draft.from, false);
  if (from !== undefined) next.from = from;
  const to = utcLocalInputToIso(draft.to, true);
  if (to !== undefined) next.to = to;
  const actorEmail = draft.actorEmail.trim();
  if (actorEmail !== "") next.actorEmail = actorEmail;
  if (draft.action.length > 0) next.action = [...draft.action];
  if (draft.entityType !== "") next.entityType = draft.entityType;
  const m = /^(?:HD-?)?(\d{1,9})$/i.exec(draft.ticketNumber.trim());
  if (m) {
    const n = Number.parseInt(m[1], 10);
    if (n >= 1) next.ticketNumber = n;
  }
  // `cursor` is deliberately never carried: a filter change starts from the top of the ledger.
  return next;
}

/** The applied-query keys a chip can remove; `limit` is never a filter and `cursor` is always dropped. */
type RemovableKey = "from" | "to" | "actorEmail" | "action" | "entityType" | "ticketNumber";

type FieldsProps = {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  /** `useId()` of the render site — the phone sheet and the md+ form coexist in the DOM. */
  idPrefix: string;
  /** "bar" = the md+ grid form (flat fields); "sheet" = grouped FilterSections inside the phone sheet. */
  layout: "bar" | "sheet";
};

/**
 * The six filter controls, defined ONCE and arranged per layout. Every control is a shadcn `data-slot`
 * element, so the phone tap rule (44 px) and the 16 px text-control rule apply without local classes.
 */
function AuditFilterFields({ draft, setDraft, idPrefix, layout }: FieldsProps): React.JSX.Element {
  const id = (name: string): string => `${idPrefix}-${name}`;

  function toggleAction(action: AuditAction, checked: boolean): void {
    setDraft((d) => ({
      ...d,
      action: checked ? AUDIT_ACTIONS.filter((a) => a === action || d.action.includes(a)) : d.action.filter((a) => a !== action),
    }));
  }

  const fieldClass = layout === "sheet" ? "flex w-full flex-col gap-1.5" : "flex flex-col gap-1.5";

  const from = (
    <div className={fieldClass}>
      <Label htmlFor={id("from")}>From (UTC)</Label>
      <Input
        id={id("from")}
        type="datetime-local"
        step={60}
        value={draft.from}
        onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
      />
    </div>
  );

  const to = (
    <div className={fieldClass}>
      <Label htmlFor={id("to")}>To (UTC)</Label>
      <Input
        id={id("to")}
        type="datetime-local"
        step={60}
        value={draft.to}
        onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
      />
    </div>
  );

  const actor = (
    <div className={fieldClass}>
      <Label htmlFor={id("actor")}>Actor email</Label>
      <Input
        id={id("actor")}
        type="text"
        inputMode="email"
        autoComplete="off"
        placeholder="contains…"
        maxLength={200}
        value={draft.actorEmail}
        onChange={(e) => setDraft((d) => ({ ...d, actorEmail: e.target.value }))}
      />
    </div>
  );

  const actions = (
    <div className={fieldClass}>
      <Label htmlFor={id("actions")}>Actions</Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            id={id("actions")}
            type="button"
            variant="outline"
            className="w-full justify-between font-normal"
            aria-label={draft.action.length === 0 ? "Actions: any" : `Actions: ${draft.action.length} selected`}
          >
            <span className="truncate">
              {draft.action.length === 0
                ? "Any action"
                : draft.action.length === 1
                  ? ACTION_LABELS[draft.action[0]]
                  : `${draft.action.length} actions`}
            </span>
            <ChevronDown aria-hidden className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[min(20rem,60svh)] w-(--radix-dropdown-menu-trigger-width) min-w-64 overflow-y-auto"
        >
          <DropdownMenuLabel>Include actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {AUDIT_ACTIONS.map((action) => (
            <DropdownMenuCheckboxItem
              key={action}
              checked={draft.action.includes(action)}
              onCheckedChange={(checked) => toggleAction(action, checked === true)}
              onSelect={(e) => e.preventDefault()}
            >
              {ACTION_LABELS[action]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const entity = (
    <div className={fieldClass}>
      <Label htmlFor={id("entity")}>Entity type</Label>
      <Select
        value={draft.entityType === "" ? ANY_ENTITY : draft.entityType}
        onValueChange={(v) => setDraft((d) => ({ ...d, entityType: v === ANY_ENTITY ? "" : (v as AuditEntityType) }))}
      >
        <SelectTrigger id={id("entity")} className="w-full">
          <SelectValue placeholder="Any entity" />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={ANY_ENTITY}>Any entity</SelectItem>
          {AUDIT_ENTITY_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {labelize(t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const ticket = (
    <div className={fieldClass}>
      <Label htmlFor={id("ticket")}>Ticket</Label>
      <Input
        id={id("ticket")}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="HD-1042"
        maxLength={12}
        value={draft.ticketNumber}
        onChange={(e) => setDraft((d) => ({ ...d, ticketNumber: e.target.value }))}
      />
    </div>
  );

  if (layout === "bar") {
    return (
      <>
        {from}
        {to}
        {actor}
        {actions}
        {entity}
        {ticket}
      </>
    );
  }

  return (
    <>
      <FilterSection label="When (UTC)">
        {from}
        {to}
      </FilterSection>
      <FilterSection label="Who">{actor}</FilterSection>
      <FilterSection label="What">
        {actions}
        {entity}
        {ticket}
      </FilterSection>
    </>
  );
}

/**
 * Filter surface for the audit ledger. Edits are local until "Apply": every URL change re-renders the RSC
 * page and writes an AUDIT_LOG_VIEWED row, so filters are committed explicitly rather than per keystroke.
 * The URL is the only state that matters — `action` is written as repeated bare `action=` keys by the
 * shared serializer (convention 12) and the cursor is dropped on every change.
 *
 * Phones (< md): a "Filters (n)" trigger opens a `FilterSheet` holding the same fields, with Reset /
 * Apply in its footer; removable `ActiveFilterChips` are built from the APPLIED query (decision D6) and a
 * chip removal is one explicit commit. md+: the inline grid form as before. One component, one `draft`,
 * one URL writer (`auditQueryToParams`).
 */
export function AuditFilters({ query }: { query: AuditQuery }): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = useState<Draft>(() => draftFromQuery(query));
  const [open, setOpen] = useState(false);
  const barId = useId();
  const sheetId = useId();

  function navigate(next: AuditQuery): void {
    const params = auditQueryToParams(next, { includeCursor: false });
    const qs = params.toString();
    router.replace(qs === "" ? pathname : `${pathname}?${qs}`);
  }

  function apply(): void {
    navigate(queryFromDraft(draft, query.limit));
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    apply();
  }

  function onReset(): void {
    setDraft(EMPTY_DRAFT);
    navigate({ limit: query.limit });
  }

  /** Chip removal: the applied query minus one key (cursor dropped), mirrored into the draft. */
  function removeKey(key: RemovableKey): void {
    const next: AuditQuery = { ...query };
    delete next[key];
    delete next.cursor;
    setDraft(draftFromQuery(next));
    navigate(next);
  }

  const chips: ActiveFilterChip[] = [];
  if (query.from !== undefined) {
    chips.push({ key: "from", label: `From ${formatDateTime(query.from)}`, onRemove: () => removeKey("from") });
  }
  if (query.to !== undefined) {
    chips.push({ key: "to", label: `To ${formatDateTime(query.to)}`, onRemove: () => removeKey("to") });
  }
  if (query.actorEmail !== undefined) {
    chips.push({ key: "actorEmail", label: `Actor: ${query.actorEmail}`, onRemove: () => removeKey("actorEmail") });
  }
  if (query.action !== undefined && query.action.length > 0) {
    chips.push({
      key: "action",
      label: query.action.length === 1 ? ACTION_LABELS[query.action[0]] : `${query.action.length} actions`,
      onRemove: () => removeKey("action"),
    });
  }
  if (query.entityType !== undefined) {
    chips.push({ key: "entityType", label: labelize(query.entityType), onRemove: () => removeKey("entityType") });
  }
  if (query.ticketNumber !== undefined) {
    chips.push({
      key: "ticketNumber",
      label: formatTicketNumber(query.ticketNumber),
      onRemove: () => removeKey("ticketNumber"),
    });
  }
  const activeCount = chips.length;

  return (
    <>
      {/* Phone: trigger + sheet + applied-filter chips */}
      <div className="flex flex-col gap-2 md:hidden" data-audit-filters-phone>
        <FilterSheetTrigger
          activeCount={activeCount}
          expanded={open}
          onClick={() => setOpen(true)}
          label="Filters"
          className="w-full sm:w-auto sm:self-start"
        />
        <FilterSheet
          open={open}
          onOpenChange={setOpen}
          title="Audit filters"
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
                Apply filters
              </Button>
            </>
          }
        >
          <AuditFilterFields draft={draft} setDraft={setDraft} idPrefix={sheetId} layout="sheet" />
        </FilterSheet>
        <ActiveFilterChips chips={chips} onClearAll={onReset} />
      </div>

      {/* md+: the inline form */}
      <form
        onSubmit={onSubmit}
        className="hidden gap-3 rounded-lg border bg-card p-3 text-card-foreground md:grid md:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]"
        aria-label="Audit log filters"
        data-audit-filters
      >
        <AuditFilterFields draft={draft} setDraft={setDraft} idPrefix={barId} layout="bar" />

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
            Apply filters
          </Button>
        </div>
      </form>
    </>
  );
}
