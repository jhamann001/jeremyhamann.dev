"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Lock, PhoneCall, UserPlus } from "lucide-react";
import { toast } from "sonner";
import {
  BRAND_LABELS,
  CATEGORY_LABELS,
  ESCALATION_TARGETS,
  ESCALATION_TARGET_LABELS,
  OPERATOR_RESOLUTIONS,
  QUEUE_LABELS,
  RESOLUTION_BEARING_STATUSES,
  RESOLUTION_LABELS,
  SOURCE_LABELS,
  TICKET_PRIORITIES,
  isOperatorResolution,
  type ActionError,
  type AssigneeOption,
  type EscalationTarget,
  type QueueKey,
  type TicketDetailDTO,
  type TicketPriority,
  type TicketResolution,
  type TicketStatus,
  type UpdateTicketFieldsInput,
} from "@/types/domain";
import { PRIORITY_LABELS, STATUS_LABELS, formatDateTime, formatDuration } from "@/lib/format";
// The two instants the compliance BADGES also print (complaint filed, follow-up) are rendered on the
// firm clock so the panel and the badge above it never name two different times for one field.
import { FIRM_TIME_ZONE_LABEL, formatFirmDateTime } from "@/lib/firm-time";
import { cn } from "@/lib/utils";
import {
  assignToMe,
  changeTicketPriority,
  changeTicketStatus,
  moveTicketQueue,
  updateTicketFields,
} from "@/server/tickets.actions";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { AssigneeSelect } from "@/components/tickets/assignee-select";
import { FlagBadges } from "@/components/tickets/flag-badges";
import { dateTimeLocalToIso, isoToDateTimeLocal } from "@/components/tickets/flag-state";
import { PriorityBadge } from "@/components/tickets/priority-badge";
import { QueueBadge } from "@/components/tickets/queue-badge";
import { StatusBadge } from "@/components/tickets/status-badge";
import { UserAvatar } from "@/components/tickets/user-avatar";
import { EditTicketSheet } from "@/components/ticket/edit-ticket-sheet";
import { RecordContactSheet } from "@/components/ticket/record-contact-sheet";

/**
 * The "no outcome" option's value. A sentinel rather than `""` because a Radix `SelectItem` may not
 * carry an empty value — Radix reserves it for "nothing selected" and throws on it — and it is not a
 * `TicketResolution`, so `isOperatorResolution` rejects it and the field is omitted from the action.
 */
const NOT_RECORDED = "__not_recorded__";

/**
 * Ticket properties + mutations.
 *
 * Every action carries `ticket.version`; a CONFLICT toasts and refreshes. On CLOSED the controls are
 * replaced by a "Closed — read only" notice (only internal notes remain, in the Composer). Success →
 * `router.refresh()` (a new audited view) + queue-summary invalidation for the dashboard counters.
 *
 * Mobile-first pass: `variant="card"` (default) is the inline md+ panel with
 * its own border; `variant="plain"` is the same panel inside the dock's Details sheet (the sheet supplies
 * the chrome). Both can be mounted at once on a phone, so the SLA heading id comes from `useId()`.
 *
 * Wave A adds the compliance block — complaint, escalation
 * target, follow-up date, external reference. They are typed columns, not a custom-field engine, so each
 * one is an ordinary `updateTicketFields` call that diffs into a `TICKET_FIELD_CHANGED` row.
 * `complaintFiledAt` is displayed and never submitted: the server stamps it (never an input).
 *
 * Two of this module's blocks are exported for the phone action dock, which must offer the same actions
 * from the bottom bar without a second implementation of either one: `TicketQuickActions` and
 * `TicketMoveQueueControl`.
 */

function isStatus(v: string): v is TicketStatus {
  return v in STATUS_LABELS;
}

function isPriority(v: string): v is TicketPriority {
  return (TICKET_PRIORITIES as readonly string[]).includes(v);
}

function isQueueKey(v: string): v is QueueKey {
  return v in QUEUE_LABELS;
}

function isEscalationTarget(v: string): v is EscalationTarget {
  return (ESCALATION_TARGETS as readonly string[]).includes(v);
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  );
}

function Verdict({ met, pendingLabel }: { met: boolean | null; pendingLabel: string }): React.JSX.Element {
  if (met === null) return <span className="text-muted-foreground">{pendingLabel}</span>;
  return met ? (
    <span className="font-medium text-emerald-700 dark:text-emerald-300">met</span>
  ) : (
    <span className="font-medium text-destructive">missed</span>
  );
}

/**
 * The shared mutation plumbing: one transition, one refresh, one counter invalidation, and the same
 * error mapping for every control on the panel. Repeated verbatim in three components otherwise.
 */
function useTicketMutation(): {
  pending: boolean;
  run: (fn: () => Promise<void>) => void;
  afterSuccess: (message: string) => void;
  handleError: (result: ActionError, failedWhat: string) => void;
} {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();

  function afterSuccess(message: string): void {
    toast.success(message);
    router.refresh();
    void queryClient.invalidateQueries({ queryKey: ["queue-summary"] });
  }

  function handleError(result: ActionError, failedWhat: string): void {
    switch (result.code) {
      case "CONFLICT":
        toast.warning("Ticket changed elsewhere — refreshing");
        router.refresh();
        return;
      case "FORBIDDEN":
      case "VALIDATION":
        toast.error(result.message);
        return;
      case "UNAUTHORIZED":
        toast.error("Your session has ended. Sign in again.");
        router.refresh();
        return;
      case "NOT_FOUND":
        toast.error("Ticket not found");
        router.refresh();
        return;
      case "INTERNAL":
        toast.error(`${failedWhat} failed. Nothing was changed.`);
        return;
    }
  }

  return {
    pending,
    run: (fn) => startTransition(fn),
    afterSuccess,
    handleError,
  };
}

/**
 * Free-text / date value with an explicit commit. A blur-commit is wrong here: on a phone the
 * datetime-local picker blurs the field every time the native sheet opens, and an accidental commit of a
 * half-entered follow-up date writes a `TICKET_FIELD_CHANGED` row that a colleague has to interpret
 * later. Save and Discard appear only while the draft differs from what is stored.
 */
function CommittedValue({
  id,
  type,
  value,
  onCommit,
  disabled,
  placeholder,
  maxLength,
  ariaLabel,
  clearLabel,
}: {
  id: string;
  type: "text" | "datetime-local";
  /** The stored value, already in the control's own format. */
  value: string;
  /** Called with the draft; "" means clear. */
  onCommit: (draft: string) => void;
  disabled: boolean;
  placeholder?: string;
  maxLength?: number;
  ariaLabel: string;
  clearLabel: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  // Follow the server: a refresh, a conflict resolution or another operator's change re-seeds the draft.
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const dirty = draft !== value;

  return (
    <div className="flex flex-col gap-1.5">
      <Input
        id={id}
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        aria-label={ariaLabel}
      />
      {dirty ? (
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="sm" onClick={() => onCommit(draft)} disabled={disabled}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(value)} disabled={disabled}>
            Discard
          </Button>
        </div>
      ) : value.length > 0 ? (
        <div className="flex">
          <Button type="button" size="sm" variant="ghost" onClick={() => onCommit("")} disabled={disabled}>
            {clearLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Queue move — the Select plus its confirmation. Exported because the phone action dock offers "Move to
 * queue" from the bottom bar and must not carry a second copy of this dialog's wording.
 *
 * Decision #67 widened `canMoveTicket`, so Client Service can now hand a ticket to Operations. Nothing
 * here encodes that rule: the options are `permissions.movableTo`, which the server derived.
 */
export function TicketMoveQueueControl({
  ticket,
  disabled = false,
}: {
  ticket: TicketDetailDTO;
  disabled?: boolean;
}): React.JSX.Element {
  const { pending, run, afterSuccess, handleError } = useTicketMutation();
  const [pendingMove, setPendingMove] = useState<QueueKey | null>(null);
  const closed = ticket.status === "CLOSED";

  if (closed || !ticket.permissions.canMove) return <QueueBadge queueKey={ticket.queueKey} />;

  function confirmMove(): void {
    const to = pendingMove;
    setPendingMove(null);
    if (!to || to === ticket.queueKey) return;
    run(async () => {
      const result = await moveTicketQueue({ ticketId: ticket.id, version: ticket.version, queueKey: to });
      if (result.ok) afterSuccess(`Moved to ${QUEUE_LABELS[result.data.queueKey]}`);
      else handleError(result, "Queue move");
    });
  }

  return (
    <>
      <Select
        value={ticket.queueKey}
        onValueChange={(v) => {
          if (isQueueKey(v) && v !== ticket.queueKey) setPendingMove(v);
        }}
        disabled={pending || disabled}
      >
        <SelectTrigger size="sm" className="w-full" aria-label="Queue" aria-busy={pending || undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={ticket.queueKey} disabled>
            {QUEUE_LABELS[ticket.queueKey]}
          </SelectItem>
          <SelectSeparator />
          {ticket.permissions.movableTo.map((q) => (
            <SelectItem key={q} value={q}>
              {QUEUE_LABELS[q]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <AlertDialog
        open={pendingMove !== null}
        onOpenChange={(o) => {
          if (!o) setPendingMove(null);
        }}
      >
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Move this ticket to another queue?</AlertDialogTitle>
            <AlertDialogDescription>
              {/* The arrow is decorative, so the direction needs a text equivalent or the sentence reads
                  "Client Service Operations" to a screen reader — the same `sr-only` the timeline's status
                  event uses (activity-row.tsx). */}
              <span className="inline-flex items-center gap-1.5">
                {QUEUE_LABELS[ticket.queueKey]} <ArrowRight aria-hidden className="size-3.5" />
                <span className="sr-only">to</span>{" "}
                {pendingMove ? QUEUE_LABELS[pendingMove] : "—"}
              </span>
              <br />
              The category stays as is. An assignee who cannot work the destination queue is cleared. The
              move is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                confirmMove();
              }}
            >
              Move ticket
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * "Assign to me" and "Record client contact" — the two actions an operator reaches for while the client
 * is still on the line. Exported so the phone dock's Actions sheet renders the same components.
 *
 * "Assign to me" is hidden (not merely disabled) when the ticket is already the viewer's: a button that
 * does nothing is worse than no button, and the panel is short on room.
 */
export function TicketQuickActions({
  ticket,
  viewerId,
  layout = "inline",
  onRecordContact,
  onDone,
}: {
  ticket: TicketDetailDTO;
  /** When omitted the button always shows: the server still refuses a no-op assignment. */
  viewerId?: string;
  /** "inline" = side by side in the panel; "stacked" = full-width rows in the dock's Actions sheet. */
  layout?: "inline" | "stacked";
  /**
   * When given, "Record client contact" delegates instead of owning `RecordContactSheet` itself. The
   * phone dock passes it so the contact sheet opens at the TOP level rather than nested inside the
   * Actions sheet — two stacked bottom sheets over a 360 px screen is not a usable dialog.
   */
  onRecordContact?: () => void;
  /** Called after a successful assignment, so a host sheet can close itself. */
  onDone?: () => void;
}): React.JSX.Element | null {
  const { pending, run, afterSuccess, handleError } = useTicketMutation();
  const [contactOpen, setContactOpen] = useState(false);

  const closed = ticket.status === "CLOSED";
  const writable = ticket.permissions.canWrite && !closed;
  const alreadyMine = viewerId !== undefined && ticket.assignee?.id === viewerId;
  const showAssign = writable && !alreadyMine;

  function claim(): void {
    run(async () => {
      const result = await assignToMe({ ticketId: ticket.id, version: ticket.version });
      if (result.ok) {
        afterSuccess("Assigned to you");
        onDone?.();
      } else handleError(result, "Assignment");
    });
  }

  if (!writable) return null;

  const full = layout === "stacked";
  return (
    <>
      <div className={cn("flex gap-2", full ? "flex-col" : "flex-wrap")}>
        {showAssign ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={claim}
            disabled={pending}
            className={full ? "w-full justify-start" : undefined}
            // `a` from KeyboardShortcuts. The shortcut ACTIVATES this control rather than calling
            // the action, so the confirmation, the version token and the audited path all stay here —
            // a keyboard user takes exactly the path a mouse user takes. Hidden when the ticket is
            // already the viewer's, and the shortcut then reports that it is not available.
            data-shortcut="assign-to-me"
          >
            <UserPlus aria-hidden />
            Assign to me
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => (onRecordContact ? onRecordContact() : setContactOpen(true))}
          disabled={pending}
          aria-haspopup="dialog"
          aria-expanded={onRecordContact ? undefined : contactOpen}
          className={full ? "w-full justify-start" : undefined}
        >
          <PhoneCall aria-hidden />
          Record client contact
        </Button>
      </div>

      {onRecordContact ? null : (
        <RecordContactSheet ticket={ticket} open={contactOpen} onOpenChange={setContactOpen} />
      )}
    </>
  );
}

export function PropertiesPanel({
  ticket,
  assignees,
  viewerId,
  variant = "card",
  requesterEmailChangedAt = null,
}: {
  ticket: TicketDetailDTO;
  assignees: AssigneeOption[];
  /**
   * The signed-in user's id, so "Assign to me" can hide itself when the ticket is already theirs.
   * Optional: the ticket page passes it, and without it the button simply always shows.
   */
  viewerId?: string;
  /** "card" = inline md+ panel with border; "plain" = inside the phone Details sheet (no chrome). */
  variant?: "card" | "plain";
  /**
   * Forwarded to `EditTicketSheet` so the md+ edit control agrees with the header's pencil about
   * whether the requester address is privileged. See that component's prop docs.
   */
  requesterEmailChangedAt?: string | null;
}): React.JSX.Element {
  const { pending, run, afterSuccess, handleError } = useTicketMutation();
  const slaHeadingId = useId();
  const complianceHeadingId = useId();
  const uid = useId();
  /** The ending status awaiting an outcome, and the outcome chosen for it ("" = not recorded yet). */
  const [pendingEnd, setPendingEnd] = useState<TicketStatus | null>(null);
  const [outcome, setOutcome] = useState<string>("");

  const { permissions } = ticket;
  const closed = ticket.status === "CLOSED";
  const readOnly = !permissions.canWrite;

  /**
   * The status change itself. `resolution` is passed only when the operator chose one — omitting the
   * field leaves the column alone, which is what "Not recorded yet" has to mean.
   */
  function applyStatus(next: TicketStatus, resolution?: TicketResolution): void {
    run(async () => {
      const result = await changeTicketStatus({
        ticketId: ticket.id,
        version: ticket.version,
        status: next,
        ...(resolution === undefined ? {} : { resolution }),
      });
      if (result.ok) {
        afterSuccess(
          resolution === undefined
            ? `Status changed to ${STATUS_LABELS[result.data.status]}`
            : `Status changed to ${STATUS_LABELS[result.data.status]} — ${RESOLUTION_LABELS[resolution]}`,
        );
      } else handleError(result, "Status change");
    });
  }

  /**
   * Fix round 2. A move into RESOLVED or CLOSED asks how the ticket ENDED before it applies, because
   * that is the only moment anyone knows. Before this the outcome had a column, an index and a report
   * (`resolution-mix`) and no way at all to write one, so the report could only ever say "Not recorded".
   *
   * The question is asked in a dialog rather than inline: the status control is a plain Select, and a
   * Select cannot collect a second value. The dialog is deliberately SKIPPABLE — "Not recorded yet"
   * is a first-class answer, and a required field here would be answered with whatever is nearest
   * rather than with the truth, which is the one thing a books-and-records column must not contain.
   * No outcome is ever inferred (an ANSWERED guessed from "a public reply exists" would fill the
   * report with distinctions nobody drew).
   *
   * Skipped entirely when the ticket already carries an outcome — a RESOLVED → CLOSED move after the
   * outcome was recorded has nothing left to ask, and `assertResolutionAllowed` refuses a second,
   * different value anyway.
   */
  function onStatusChange(next: string): void {
    if (!isStatus(next) || next === ticket.status) return;
    const ends = (RESOLUTION_BEARING_STATUSES as readonly TicketStatus[]).includes(next);
    if (ends && ticket.resolution === "NONE") {
      setOutcome("");
      setPendingEnd(next);
      return;
    }
    applyStatus(next);
  }

  function confirmEnd(): void {
    const next = pendingEnd;
    const chosen = outcome;
    setPendingEnd(null);
    if (next === null) return;
    applyStatus(next, isOperatorResolution(chosen) ? chosen : undefined);
  }

  function onPriorityChange(next: string): void {
    if (!isPriority(next) || next === ticket.priority) return;
    run(async () => {
      const result = await changeTicketPriority({ ticketId: ticket.id, version: ticket.version, priority: next });
      if (result.ok) afterSuccess(`Priority changed to ${PRIORITY_LABELS[result.data.priority]} — SLA clocks re-stamped`);
      else handleError(result, "Priority change");
    });
  }

  /** One `updateTicketFields` call per compliance field, so each lands as its own audited diff. */
  function patchFields(
    patch: Omit<UpdateTicketFieldsInput, "ticketId" | "version">,
    successMessage: string,
    failedWhat: string,
  ): void {
    run(async () => {
      const result = await updateTicketFields({
        ticketId: ticket.id,
        version: ticket.version,
        ...patch,
      });
      if (result.ok) {
        if (result.data.piiRedacted) {
          const n = result.data.piiRedactionCount;
          toast.warning(`Sensitive numbers were redacted before saving (${n} ${n === 1 ? "item" : "items"})`);
        }
        afterSuccess(successMessage);
      } else handleError(result, failedWhat);
    });
  }

  function onComplaintChange(next: boolean): void {
    patchFields(
      { isComplaint: next },
      next ? "Flagged as a complaint" : "Complaint flag removed",
      "Complaint flag",
    );
  }

  function onEscalationChange(next: string): void {
    if (!isEscalationTarget(next) || next === ticket.escalationTarget) return;
    patchFields(
      { escalationTarget: next },
      next === "NONE" ? "Escalation cleared" : `Escalated to ${ESCALATION_TARGET_LABELS[next]}`,
      "Escalation",
    );
  }

  function onFollowUpCommit(draft: string): void {
    if (draft.length === 0) {
      if (ticket.followUpAt === null) return;
      patchFields({ followUpAt: null }, "Follow-up cleared", "Follow-up date");
      return;
    }
    const iso = dateTimeLocalToIso(draft);
    if (iso === null) {
      toast.error("That is not a valid date and time.");
      return;
    }
    if (iso === ticket.followUpAt) return;
    patchFields({ followUpAt: iso }, `Follow-up set for ${formatFirmDateTime(iso)}`, "Follow-up date");
  }

  function onExternalRefCommit(draft: string): void {
    const next = draft.trim().length === 0 ? null : draft.trim();
    if (next === ticket.externalRef) return;
    patchFields(
      { externalRef: next },
      next === null ? "External reference cleared" : "External reference saved",
      "External reference",
    );
  }

  const controlsDisabled = pending || readOnly || closed;
  const ids = {
    followUp: `${uid}-follow-up`,
    externalRef: `${uid}-external-ref`,
    escalation: `${uid}-escalation`,
    complaint: `${uid}-complaint`,
    outcome: `${uid}-outcome`,
  };

  return (
    <aside
      aria-label="Ticket properties"
      className={cn("flex flex-col gap-4 text-sm", variant === "card" && "rounded-lg border bg-card p-4 text-card-foreground")}
      data-version={ticket.version}
      data-variant={variant}
    >
      {closed ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-muted-foreground" role="status">
          <Lock aria-hidden className="size-4 shrink-0" />
          <span>Closed — read only. Internal notes can still be added.</span>
        </div>
      ) : readOnly ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-muted-foreground" role="status">
          <Lock aria-hidden className="size-4 shrink-0" />
          <span>Read only — you do not have write access to this queue.</span>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- Quick actions
          md+ only, for the same reason as the Edit button below: `variant="plain"` IS the phone Details
          sheet, and "Record client contact" opens a sheet of its own. The phone reaches both from the
          dock's Actions sheet, which renders these very components. */}
      {variant === "card" ? <TicketQuickActions ticket={ticket} viewerId={viewerId} /> : null}

      {/* ---------------------------------------------------------------- Status */}
      <Field label="Status">
        {closed ? (
          <StatusBadge status={ticket.status} describe />
        ) : (
          <Select value={ticket.status} onValueChange={onStatusChange} disabled={pending || readOnly || permissions.allowedStatuses.length === 0}>
            <SelectTrigger size="sm" className="w-full" aria-label="Status" aria-busy={pending || undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value={ticket.status} disabled>
                {STATUS_LABELS[ticket.status]}
              </SelectItem>
              {permissions.allowedStatuses.length > 0 ? <SelectSeparator /> : null}
              {permissions.allowedStatuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      {/* ---------------------------------------------------------------- Outcome
          Rendered only once there is something to render. A row reading "Outcome —" on every live
          ticket would put a permanent blank on the panel for a field that is meaningless until the
          ticket ends; `resolution-mix` already reports the not-recorded ones as a group. */}
      {ticket.resolution === "NONE" ? null : (
        <Field label="Outcome">
          <Badge variant="outline" className="font-normal">
            {RESOLUTION_LABELS[ticket.resolution]}
          </Badge>
        </Field>
      )}

      <AlertDialog
        open={pendingEnd !== null}
        onOpenChange={(o) => {
          if (!o) setPendingEnd(null);
        }}
      >
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingEnd === "CLOSED" ? "Close this ticket?" : "Resolve this ticket?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              How did it end? This is recorded once, in the same audited write as the status change, and
              reported by Reports → Resolution mix. You can leave it unanswered — reopening the ticket is
              the only way to change it afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Outside AlertDialogDescription: that renders a <p>, and a Select inside a paragraph is
              invalid markup that React will warn about at runtime. */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor={ids.outcome}>
              Outcome
            </label>
            <Select value={outcome === "" ? NOT_RECORDED : outcome} onValueChange={(v) => setOutcome(v === NOT_RECORDED ? "" : v)}>
              <SelectTrigger id={ids.outcome} size="sm" className="w-full" aria-label="Outcome">
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
                confirmEnd();
              }}
            >
              {pendingEnd === "CLOSED" ? "Close ticket" : "Resolve ticket"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---------------------------------------------------------------- Priority */}
      <Field label="Priority">
        {closed ? (
          <PriorityBadge priority={ticket.priority} />
        ) : (
          <Select value={ticket.priority} onValueChange={onPriorityChange} disabled={pending || readOnly}>
            <SelectTrigger size="sm" className="w-full" aria-label="Priority" aria-busy={pending || undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {TICKET_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>

      {/* ---------------------------------------------------------------- Assignee */}
      <Field label="Assignee">
        {closed ? (
          <UserAvatar user={ticket.assignee} size="sm" />
        ) : (
          <AssigneeSelect
            ticketId={ticket.id}
            version={ticket.version}
            value={ticket.assignee}
            options={assignees}
            disabled={pending || readOnly}
          />
        )}
      </Field>

      {/* ---------------------------------------------------------------- Queue */}
      <Field label="Queue">
        <TicketMoveQueueControl ticket={ticket} disabled={pending} />
      </Field>

      <Separator />

      {/* ---------------------------------------------------------------- Compliance flags */}
      <section aria-labelledby={complianceHeadingId} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={complianceHeadingId} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Compliance
          </h2>
          {/* md+ only: `variant="plain"` is the phone Details SHEET, and a sheet inside a sheet stacks
              two overlays over a 360 px screen. The header's pencil is the phone's edit affordance. */}
          {variant === "card" ? (
            <EditTicketSheet
              ticket={ticket}
              trigger="button"
              requesterEmailChangedAt={requesterEmailChangedAt}
            />
          ) : null}
        </div>

        <FlagBadges ticket={ticket} includeScheduledFollowUp />

        <label
          htmlFor={ids.complaint}
          className="flex min-h-11 items-center gap-2 rounded-md md:min-h-9"
        >
          <Checkbox
            id={ids.complaint}
            checked={ticket.isComplaint}
            onCheckedChange={(next) => onComplaintChange(next === true)}
            disabled={controlsDisabled}
          />
          <span>Complaint</span>
        </label>
        {ticket.isComplaint ? (
          <p className="-mt-1 text-xs text-muted-foreground">
            {ticket.complaintFiledAt
              ? `Filed ${formatFirmDateTime(ticket.complaintFiledAt)} — stamped by the server, not editable.`
              : "Filed date is stamped by the server on the next save."}
          </p>
        ) : null}

        <Field label="Escalation">
          <Select value={ticket.escalationTarget} onValueChange={onEscalationChange} disabled={controlsDisabled}>
            <SelectTrigger id={ids.escalation} size="sm" className="w-full" aria-label="Escalation target" aria-busy={pending || undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {ESCALATION_TARGETS.map((t) => (
                <SelectItem key={t} value={t}>
                  {ESCALATION_TARGET_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* The control speaks the firm clock (src/lib/firm-time.ts), which is what the badge above prints, so the zone is named in the label rather than left for an operator in another state to guess. */}
        <Field label={`Follow-up (${FIRM_TIME_ZONE_LABEL})`}>
          <CommittedValue
            id={ids.followUp}
            type="datetime-local"
            value={isoToDateTimeLocal(ticket.followUpAt)}
            onCommit={onFollowUpCommit}
            disabled={controlsDisabled}
            ariaLabel={`Follow-up date and time (${FIRM_TIME_ZONE_LABEL})`}
            clearLabel="Clear follow-up"
          />
        </Field>

        <Field label="External reference">
          <CommittedValue
            id={ids.externalRef}
            type="text"
            value={ticket.externalRef ?? ""}
            onCommit={onExternalRefCommit}
            disabled={controlsDisabled}
            placeholder="E-signature envelope, ACAT control number…"
            maxLength={200}
            ariaLabel="External reference"
            clearLabel="Clear reference"
          />
        </Field>
      </section>

      <Separator />

      {/* ---------------------------------------------------------------- Details */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Category</dt>
        <dd>{CATEGORY_LABELS[ticket.category]}</dd>
        <dt className="text-muted-foreground">Brand</dt>
        <dd>{BRAND_LABELS[ticket.brand]}</dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd>{SOURCE_LABELS[ticket.source]}</dd>
        <dt className="text-muted-foreground">Client ref</dt>
        <dd className="break-all font-mono md:truncate" title={ticket.clientReference ?? undefined}>
          {ticket.clientReference ?? "—"}
        </dd>
        <dt className="text-muted-foreground">Queue</dt>
        <dd>{ticket.queueName}</dd>
        <dt className="text-muted-foreground">Updated</dt>
        <dd className="tabular-nums">{formatDateTime(ticket.updatedAt)}</dd>
      </dl>

      <Separator />

      {/* ---------------------------------------------------------------- SLA */}
      <section aria-labelledby={slaHeadingId} className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 id={slaHeadingId} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            SLA
          </h2>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            24x7 calendar clocks
          </Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Policy</dt>
          <dd className="tabular-nums">
            first response {formatDuration(ticket.slaFirstResponseMinutes * 60_000)} · resolution{" "}
            {formatDuration(ticket.slaResolutionMinutes * 60_000)}
          </dd>
          <dt className="text-muted-foreground">First response due</dt>
          <dd className="tabular-nums">{formatDateTime(ticket.firstResponseDueAt)}</dd>
          <dt className="text-muted-foreground">First responded</dt>
          <dd className="tabular-nums">
            {ticket.firstRespondedAt ? formatDateTime(ticket.firstRespondedAt) : "—"}
            <span className="ml-1">
              (<Verdict met={ticket.sla.firstResponseMet} pendingLabel="pending" />)
            </span>
          </dd>
          <dt className="text-muted-foreground">Resolution due</dt>
          <dd className="tabular-nums">{formatDateTime(ticket.resolutionDueAt)}</dd>
          <dt className="text-muted-foreground">Resolved</dt>
          <dd className="tabular-nums">
            {ticket.resolvedAt ? formatDateTime(ticket.resolvedAt) : "—"}
            <span className="ml-1">
              (<Verdict met={ticket.sla.resolutionMet} pendingLabel="open" />)
            </span>
          </dd>
          {ticket.closedAt ? (
            <>
              <dt className="text-muted-foreground">Closed</dt>
              <dd className="tabular-nums">{formatDateTime(ticket.closedAt)}</dd>
            </>
          ) : null}
        </dl>
      </section>
    </aside>
  );
}
