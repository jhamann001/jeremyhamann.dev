"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { CommentVisibility } from "@/types/domain";
import { QUEUE_LABELS } from "@/types/domain";
import type { MacroAdminRow } from "@/server/macros";
import { DISCLAIMERS } from "@/lib/disclaimers";
import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MacroActionsSheet } from "@/components/admin/macros/macro-actions-sheet";
import { MacroActiveDialog } from "@/components/admin/macros/macro-active-dialog";
import { MacroEditSheet } from "@/components/admin/macros/macro-edit-sheet";
import { CHANNEL_LABELS, describeMacroActions } from "@/components/admin/macros/macro-form-support";
import { cn } from "@/lib/utils";

/**
 * `/admin/macros` (docs/MOBILE_FIRST.md R1–R12).
 *
 * Mobile-first with one layout flip at `md`: below it each macro is a stacked card whose controls are
 * full width; from `md` the same card lays out in a row. Same data, same component, same list in both
 * — there is no phone-only view to keep in step with a desktop table.
 *
 * Filtering is client-side rather than URL state, which is the one place this page departs from
 * `/admin/users`. The whole macro library is roughly twenty rows and it is all loaded already; a
 * round trip per keystroke would buy nothing, and there is no "link me every retired macro" workflow
 * the way there is for staff accounts. Recorded in the integration notes.
 */

const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "retired", label: "Retired" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["key"];

function matchesStatus(macro: MacroAdminRow, filter: StatusFilter): boolean {
  if (filter === "active") return macro.isActive;
  if (filter === "retired") return !macro.isActive;
  return true;
}

function matchesSearch(macro: MacroAdminRow, needle: string): boolean {
  if (needle.length === 0) return true;
  const haystack = `${macro.title}\n${macro.key}\n${macro.body}`.toLowerCase();
  return haystack.includes(needle);
}

export function MacrosAdminView({ macros }: { macros: MacroAdminRow[] }): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const needle = search.trim().toLowerCase();
  const visible = useMemo(
    () => macros.filter((m) => matchesStatus(m, status) && matchesSearch(m, needle)),
    [macros, status, needle],
  );
  const activeCount = macros.filter((m) => m.isActive).length;

  return (
    <section className="flex flex-col gap-4" data-slice="S9-macros-admin">
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Macros</h2>
          <p className="text-sm text-muted-foreground">
            Firm-approved reply templates. A change here reaches the composer on the next page load — no deployment —
            and every change is recorded in the audit log with the wording it replaced.
          </p>
        </div>
        <MacroEditSheet mode="create" className="w-full md:w-auto md:shrink-0" />
      </header>

      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, key or wording"
            aria-label="Search macros"
            maxLength={200}
            // `pr-12` clears the clear-search button: globals.css gives an icon Button a 44 px minimum
            // on phones, so it owns the rightmost 48 px of the field and typed text ran underneath it.
            className="pl-9 pr-12"
          />
          {search.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Clear search"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onClick={() => setSearch("")}
            >
              <X aria-hidden />
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by macro status">
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.key}
              type="button"
              variant={f.key === status ? "secondary" : "outline"}
              size="sm"
              // R3 / G2: the global phone rule sets a 44 px minimum HEIGHT but no minimum width, so a
              // short label ("All") measured 38 px. The fix is the size, never an opt-out.
              className="min-w-11"
              aria-pressed={f.key === status}
              onClick={() => setStatus(f.key)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {visible.length === 0
          ? "No macros match."
          : `${visible.length} of ${macros.length} ${macros.length === 1 ? "macro" : "macros"}, ${activeCount} active.`}
      </p>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {macros.length === 0
            ? "There are no macros yet. Create one, or run the reference seed to load the starting set."
            : "Nothing matches that search."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((m) => (
            <MacroRowCard key={m.id} macro={m} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ChannelBadge({ channel }: { channel: CommentVisibility }): React.JSX.Element {
  return (
    <Badge
      variant={channel === "PUBLIC" ? "default" : "outline"}
      data-channel={channel}
      className={cn("font-normal", channel === "INTERNAL" && "border-dashed")}
    >
      {CHANNEL_LABELS[channel]}
    </Badge>
  );
}

/**
 * The macro's side effects, in words, or nothing at all when it has none. Rendered from the same
 * `describeMacroActions` the editor previews with, so the list and the sheet cannot disagree.
 *
 * Fix round 2 (R2/G1). These lines are whole SENTENCES — "Set the status to Pending client, when the
 * state machine allows it" — and they used to be one `Badge` each. The shadcn Badge primitive is
 * `inline-flex h-5 w-fit shrink-0 … whitespace-nowrap`, so a sentence in one can neither wrap nor
 * shrink: `/admin/macros` measured `documentElement.scrollWidth` 404 against `innerWidth` 390, and
 * failed the same way at 360. `[data-slot=badge]` is deliberately outside the phone rules in
 * `globals.css`, so nothing global was ever going to catch it.
 *
 * They are now the same plain wrapping list items the composer's `MacroEffects` uses for the identical
 * strings — the two screens described one macro with two layout behaviours, and the one that wrapped
 * was the correct one. `admin-surface-probe.test.ts` keeps a sentence out of a Badge here.
 */
function MacroActionsSummary({ actions }: { actions: MacroAdminRow["actions"] }): React.JSX.Element | null {
  const lines = describeMacroActions(actions);
  if (lines.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-macro-actions={lines.length}>
      <span className="text-xs font-medium text-muted-foreground">Also:</span>
      <ul className="list-disc pl-4 text-xs text-muted-foreground">
        {lines.map((line) => (
          <li key={line} className="break-words">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MacroRowCard({ macro }: { macro: MacroAdminRow }): React.JSX.Element {
  const editor = macro.updatedBy;
  return (
    <li
      data-macro-id={macro.id}
      data-active={macro.isActive ? "true" : "false"}
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-foreground/10",
        "md:flex-row md:items-start md:justify-between md:gap-4",
        !macro.isActive && "bg-muted/40",
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold">{macro.title}</h3>
          {macro.isActive ? null : (
            <Badge variant="destructive" className="shrink-0 font-normal">
              Retired
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <ChannelBadge channel={macro.channel} />
          <Badge variant="outline" className="font-normal">
            {macro.queueKey ? QUEUE_LABELS[macro.queueKey] : "All queues"}
          </Badge>
          {macro.disclaimerKey === "NONE" ? null : (
            <Badge variant="outline" className="font-normal" data-disclaimer={macro.disclaimerKey}>
              {DISCLAIMERS[macro.disclaimerKey].label}
            </Badge>
          )}
        </div>

        {/* Three lines is enough to recognise a macro; the whole body is in the edit sheet. */}
        <p className="line-clamp-3 text-sm whitespace-pre-wrap text-muted-foreground">{macro.body}</p>

        {/*
          Wave B (Decision #100). The side effects are listed on the row, not hidden behind the
          Actions sheet: "what does this macro do to a ticket" is the question an administrator
          scanning this list is actually asking, and a macro that silently moves a ticket between
          queues is exactly the one they need to see without clicking.
        */}
        <MacroActionsSummary actions={macro.actions} />

        <p className="text-xs text-muted-foreground">
          <code className="font-mono">{macro.key}</code> · order {macro.sortOrder} · last changed{" "}
          {formatDateTime(macro.updatedAt)}
          {editor ? ` by ${editor.name?.trim() || editor.email}` : " (as seeded — never edited here)"}
        </p>
      </div>

      <div className="flex flex-col gap-2 md:shrink-0 md:flex-row">
        <MacroEditSheet mode="edit" macro={macro} className="w-full md:w-auto" />
        <MacroActionsSheet macro={macro} className="w-full md:w-auto" />
        <MacroActiveDialog macroId={macro.id} title={macro.title} isActive={macro.isActive} />
      </div>
    </li>
  );
}
