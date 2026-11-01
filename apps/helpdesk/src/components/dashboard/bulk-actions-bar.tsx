"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { CheckCheck, LoaderCircle, X } from "lucide-react";
import { toast } from "sonner";
import type {
  BulkActionInput,
  BulkActionResult,
  QueueKey,
  TicketListRow,
  TicketPriority,
  TicketStatus,
  Viewer,
} from "@/types/domain";
import {
  METRICS_EXCLUDED_STATUSES,
  OPERATOR_RESOLUTIONS,
  QUEUE_KEYS,
  QUEUE_LABELS,
  RESOLUTION_BEARING_STATUSES,
  RESOLUTION_LABELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  WAVE_B_LIMITS,
} from "@/types/domain";
import { isOperatorResolution } from "@/types/domain";
import { canApplyBulk, canMoveTicket } from "@/lib/rbac";
import { PRIORITY_LABELS, STATUS_LABELS, formatTicketNumber } from "@/lib/format";
import { canTransition } from "@/lib/ticket-policy";
import { applyBulkAction } from "@/server/bulk.actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { statusHelpText } from "@/components/tickets/status-help";

/** See the identical sentinel in `properties-panel.tsx`: a Radix `SelectItem` may not carry `""`. */
const NOT_RECORDED = "__not_recorded__";

/**
 * Bulk action bar (§3 rule 4).
 *
 * **A bulk action is N ORDINARY actions.** The server re-checks RBAC per ticket, guards each one on its
 * own version, writes each one's ordinary audit row plus a `BULK_ACTION_APPLIED` summary, and reports
 * every skip with a code and a sentence. This bar's job is to make that honest on screen: it never says
 * "done", it says how many were applied and lists what was not, by ticket number and reason.
 *
 * **Selection lives in a store, not in the props.** The contract's props give the bar
 * `selectedIds` from the dashboard, but the dashboard never fills them — `TicketTable` owns the
 * checkbox column and the dashboard (foundation-owned) passes the selection to the BAR
 * and not to the TABLE. `useBulkSelection` is the bridge: the table writes it, the bar reads it, and
 * the bar still honours the prop by taking the UNION, so the day the dashboard wires the table up
 * nothing here changes. See the build record.
 */
export type BulkActionsBarProps = {
  rows: TicketListRow[];
  viewer: Viewer;
  /** Ids the operator has checked. Owned by the table; the bar renders and acts on them. */
  selectedIds: string[];
  onClearSelection: () => void;
};

// ---------------------------------------------------------------------------
// The shared selection
// ---------------------------------------------------------------------------

export type BulkSelectionState = {
  /** Ids, in the order they were checked. */
  ids: string[];
  /** True while the phone list is in "select" mode (entered by long-press). */
  selectMode: boolean;
  toggle(id: string): void;
  set(ids: string[]): void;
  clear(): void;
  setSelectMode(on: boolean): void;
};

/**
 * UI state only — never record content (the same rule `dashboard-store.ts` states).
 *
 * A selection is about the page currently on screen: change a filter and the rows underneath it change
 * meaning, so nothing here is persisted and `clear()` runs whenever the rendered page changes.
 */
export const useBulkSelection: UseBoundStore<StoreApi<BulkSelectionState>> = create<BulkSelectionState>()((set) => ({
  ids: [],
  selectMode: false,
  toggle: (id) =>
    set((s) => ({ ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id] })),
  set: (ids) => set({ ids: [...new Set(ids)] }),
  clear: () => set({ ids: [], selectMode: false }),
  setSelectMode: (on) => set((s) => ({ selectMode: on, ids: on ? s.ids : [] })),
}));

// ---------------------------------------------------------------------------
// Pure helpers (exported for the test)
// ---------------------------------------------------------------------------

/** The contract prop and the store's own selection, deduplicated and limited to rows on this page. */
export function effectiveSelection(propIds: readonly string[], storeIds: readonly string[], rows: readonly TicketListRow[]): string[] {
  const onPage = new Set(rows.map((r) => r.id));
  return [...new Set([...propIds, ...storeIds])].filter((id) => onPage.has(id));
}

/**
 * Statuses every selected ticket could legally move to. An option nobody can use is not offered.
 *
 * Three filters, and the first is a rule rather than an ergonomic:
 *  - **VOIDED is never a target**. It is not a transition, `voidTicket` writes that one
 *    edge itself behind ops_team + a recorded reason, and a status dropdown that could reach it would
 *    be the one-click way to make a ticket leave every counter — which is precisely what the decision
 *    exists to prevent. Without this line a selection containing a voided ticket offers "Voided" back,
 *    because a ticket trivially satisfies "already at that status".
 *  - Every selected ticket must be able to take it, so the bar never invites a click the server will
 *    refuse ticket by ticket.
 *  - At least one must actually change, so the list holds no no-ops.
 */
export function commonStatusTargets(rows: readonly TicketListRow[]): TicketStatus[] {
  if (rows.length === 0) return [];
  return TICKET_STATUSES.filter(
    (target) =>
      !(METRICS_EXCLUDED_STATUSES as readonly TicketStatus[]).includes(target) &&
      rows.every((r) => r.status === target || canTransition(r.status, target)) &&
      rows.some((r) => r.status !== target),
  );
}

/** Queues every selected ticket could be moved to by THIS viewer. */
export function commonQueueTargets(rows: readonly TicketListRow[], viewer: Viewer): QueueKey[] {
  if (rows.length === 0) return [];
  return QUEUE_KEYS.filter((to) =>
    rows.every((r) => r.queueKey === to || canMoveTicket(viewer.groups, r.queueKey, to)),
  );
}

/** "12 applied, 3 skipped" plus the per-ticket reasons — never "done". */
export function summarizeOutcome(result: BulkActionResult, numberById: ReadonlyMap<string, number>): string {
  const head = `${result.applied} applied`;
  if (result.skipped.length === 0) return head;
  const detail = result.skipped
    .slice(0, 3)
    .map((s) => {
      const n = numberById.get(s.ticketId);
      return `${n === undefined ? s.ticketId : formatTicketNumber(n)}: ${s.message}`;
    })
    .join("; ");
  const more = result.skipped.length > 3 ? ` (+${result.skipped.length - 3} more)` : "";
  return `${head}, ${result.skipped.length} skipped — ${detail}${more}`;
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

export function BulkActionsBar({ rows, viewer, selectedIds, onClearSelection }: BulkActionsBarProps): React.JSX.Element | null {
  const router = useRouter();
  const storeIds = useBulkSelection((s) => s.ids);
  const clearStore = useBulkSelection((s) => s.clear);
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<BulkActionResult | null>(null);

  const ids = useMemo(() => effectiveSelection(selectedIds, storeIds, rows), [selectedIds, storeIds, rows]);
  const selectedRows = useMemo(() => rows.filter((r) => ids.includes(r.id)), [rows, ids]);
  const numberById = useMemo(() => new Map(rows.map((r) => [r.id, r.number])), [rows]);

  const clear = useCallback(() => {
    clearStore();
    onClearSelection();
    setOutcome(null);
  }, [clearStore, onClearSelection]);

  /**
   * The ending status awaiting an outcome for the whole batch, and the outcome chosen ("" = none).
   * Fix round 2: before this, a batch resolve was the one resolve path that could not record how the
   * tickets ended, so a desk that worked from the board filled `resolution-mix` with "Not recorded"
   * no matter how carefully it used the ticket page.
   */
  const [pendingEnd, setPendingEnd] = useState<TicketStatus | null>(null);
  const [endOutcome, setEndOutcome] = useState<string>("");

  const statusTargets = useMemo(() => commonStatusTargets(selectedRows), [selectedRows]);
  const queueTargets = useMemo(() => commonQueueTargets(selectedRows, viewer), [selectedRows, viewer]);
  // The same predicate the server re-applies per ticket, so a control is never offered where every
  // selected ticket would be refused. It gates the four kinds that CHANGE the ticket; `follow` is
  // gated on queue READ instead (see the Follow button below), which every selected row satisfies by
  // definition — an unreadable ticket is not on this list.
  const canWriteAny = selectedRows.some((r) => canApplyBulk(viewer.groups, r.queueKey));
  const overLimit = ids.length > WAVE_B_LIMITS.bulkMaxTickets;

  const run = useCallback(
    (action: BulkActionInput["action"]) => {
      startTransition(async () => {
        const result = await applyBulkAction({ ticketIds: ids, action });
        if (!result.ok) {
          toast.error(result.fieldErrors?.ticketIds?.join(" ") ?? result.message);
          return;
        }
        setOutcome(result.data);
        if (result.data.skipped.length === 0) toast.success(`${result.data.applied} tickets updated`);
        else toast.warning(summarizeOutcome(result.data, numberById));
        if (result.data.applied > 0) {
          clearStore();
          onClearSelection();
          router.refresh();
        }
      });
    },
    [ids, numberById, clearStore, onClearSelection, router],
  );

  if (ids.length === 0) return null;

  return (
    /* `sticky top-0` put this bar at the same y = 0 as the shell's topbar (`sticky top-0 z-40`,
       topbar.tsx) — an ancestor-sibling in the same document scroll — so the moment the board was
       scrolled the count and every action vanished under ~64 px of blurred chrome, which is the one
       thing being sticky was for. Offset by `--wm-topbar-h` (globals.css: safe area + env banner +
       identity row, at both breakpoints) and sit at z-30: below the topbar's 40, above the list.
       MOBILE_FIRST §7 probe G14 asserts `rect.top >= topbar.bottom` mid-scroll. */
    <div
      role="region"
      aria-label="Bulk actions"
      data-slice="B2-bulk-bar"
      data-sticky-top-bar
      data-selected-count={ids.length}
      className="sticky top-(--wm-topbar-h) z-30 flex flex-col gap-2 rounded-lg border bg-card/95 p-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/80"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm font-medium tabular-nums" aria-live="polite">
          <CheckCheck aria-hidden className="size-4 text-muted-foreground" />
          {ids.length} selected
        </span>

        {overLimit ? (
          <span role="alert" className="text-xs text-destructive">
            Narrow the filters — a bulk action may touch {WAVE_B_LIMITS.bulkMaxTickets} tickets at a time.
          </span>
        ) : null}

        <div className="ms-auto flex flex-wrap items-center gap-2">
          {canWriteAny ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                disabled={pending || overLimit}
                onClick={() => run({ kind: "assign", assigneeId: viewer.id })}
              >
                Assign to me
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                disabled={pending || overLimit}
                onClick={() => run({ kind: "assign", assigneeId: null })}
              >
                Unassign
              </Button>

              <Select
                value=""
                disabled={pending || overLimit || statusTargets.length === 0}
                onValueChange={(v) => {
                  const next = v as TicketStatus;
                  // An ending status asks for the outcome first; everything else applies straight away.
                  if ((RESOLUTION_BEARING_STATUSES as readonly TicketStatus[]).includes(next)) {
                    setEndOutcome("");
                    setPendingEnd(next);
                    return;
                  }
                  run({ kind: "status", status: next });
                }}
              >
                <SelectTrigger size="sm" aria-label="Set status" className="min-h-11 min-w-32 md:min-h-8">
                  <SelectValue placeholder="Status…" />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {/* The crosswalk sentence is a VISIBLE sub-line, not a `title`. This is the one place a
                      person picks a status for many tickets at once, so "Pending client sends nothing"
                      has to be readable before the tap — and MOBILE_FIRST R10 rules a tooltip out as an
                      explanation a phone can reach at all. */}
                  {statusTargets.map((s) => (
                    <SelectItem key={s} value={s} className="items-start py-1.5">
                      <span className="flex max-w-64 flex-col items-start gap-0.5 text-left">
                        <span className="font-medium">{STATUS_LABELS[s]}</span>
                        <span className="text-xs leading-snug text-wrap text-muted-foreground">
                          {statusHelpText(s)}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value=""
                disabled={pending || overLimit}
                onValueChange={(v) => run({ kind: "priority", priority: v as TicketPriority })}
              >
                <SelectTrigger size="sm" aria-label="Set priority" className="min-h-11 min-w-32 md:min-h-8">
                  <SelectValue placeholder="Priority…" />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {TICKET_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value=""
                disabled={pending || overLimit || queueTargets.length === 0}
                onValueChange={(v) => run({ kind: "queue", queueKey: v as QueueKey })}
              >
                <SelectTrigger size="sm" aria-label="Move to queue" className="min-h-11 min-w-32 md:min-h-8">
                  <SelectValue placeholder="Move to…" />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {queueTargets.map((q) => (
                    <SelectItem key={q} value={q}>
                      {QUEUE_LABELS[q]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : null}

          {/*
            Outside the `canWriteAny` gate ON PURPOSE. Following is watching, not changing: the server
            gates bulk `follow` on queue READ, the same bar `followTicket` applies on the ticket page,
            so a compliance officer — READ everywhere, WRITE nowhere — sees a bar with this one control
            on it and it works. Every other control here changes the ticket and needs WRITE.
          */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            disabled={pending || overLimit}
            onClick={() => run({ kind: "follow", follow: true })}
          >
            Follow
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-8"
            disabled={pending}
            onClick={clear}
          >
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <X aria-hidden />}
            Clear
          </Button>
        </div>
      </div>

      <AlertDialog
        open={pendingEnd !== null}
        onOpenChange={(o) => {
          if (!o) setPendingEnd(null);
        }}
      >
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingEnd === "CLOSED" ? `Close ${ids.length} tickets?` : `Resolve ${ids.length} tickets?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              One outcome is recorded against every ticket in this batch. A ticket that already has an
              outcome keeps the one it has. You can leave this unanswered — reopening a ticket is the
              only way to change its outcome afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Outside the description, which renders a <p>: a Select inside a paragraph is invalid markup. */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">Outcome</span>
            <Select
              value={endOutcome === "" ? NOT_RECORDED : endOutcome}
              onValueChange={(v) => setEndOutcome(v === NOT_RECORDED ? "" : v)}
            >
              <SelectTrigger size="sm" className="min-h-11 w-full md:min-h-8" aria-label="Outcome for the batch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value={NOT_RECORDED}>Not recorded yet</SelectItem>
                <SelectSeparator />
                {OPERATOR_RESOLUTIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {RESOLUTION_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                const next = pendingEnd;
                const chosen = endOutcome;
                setPendingEnd(null);
                if (next === null) return;
                run({
                  kind: "status",
                  status: next,
                  ...(isOperatorResolution(chosen) ? { resolution: chosen } : {}),
                });
              }}
            >
              {pendingEnd === "CLOSED" ? "Close tickets" : "Resolve tickets"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Partial success is the contract, not a failure mode: every skipped ticket is named. */}
      {outcome !== null && outcome.skipped.length > 0 ? (
        <div role="status" className="rounded-md border border-dashed px-2 py-1.5 text-xs">
          <p className="font-medium">
            {outcome.applied} applied, {outcome.skipped.length} skipped. Nothing was changed on the skipped ones.
          </p>
          <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
            {outcome.skipped.map((s) => {
              const n = numberById.get(s.ticketId);
              return (
                <li key={s.ticketId}>
                  <span className="font-mono tabular-nums">
                    {n === undefined ? s.ticketId : formatTicketNumber(n)}
                  </span>{" "}
                  — {s.message}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
