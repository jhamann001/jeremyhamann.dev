"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Wand2 } from "lucide-react";
import { toast } from "sonner";
import type {
  ActionError,
  EscalationTarget,
  MacroActions,
  QueueKey,
  TicketPriority,
  TicketResolution,
  TicketStatus,
} from "@/types/domain";
import {
  ESCALATION_TARGETS,
  ESCALATION_TARGET_LABELS,
  OPERATOR_RESOLUTIONS,
  QUEUE_KEYS,
  QUEUE_LABELS,
  RESOLUTION_LABELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "@/types/domain";
import type { MacroAdminRow } from "@/server/macros";
import { setMacroActions } from "@/server/macros.actions";
import { PRIORITY_LABELS, STATUS_LABELS } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
} from "@/components/shell/responsive-sheet";
import {
  MACRO_ASSIGNEE_LABELS,
  assigneeChoiceOf,
  describeMacroActions,
  macroOutcomeProblem,
  type MacroAssigneeChoice,
} from "@/components/admin/macros/macro-form-support";

/**
 * Macro ACTIONS editor (docs/MOBILE_FIRST.md R1–R12).
 *
 * Separate from the wording sheet on purpose, because they are different acts with different blast
 * radii: editing a macro's body changes a sentence a client reads, editing its actions silently
 * starts moving tickets between statuses and queues for everyone who picks it. Two sheets, two
 * confirmations, two audit rows.
 *
 * Every field defaults to **"Leave alone"** and a macro with nothing set stores SQL NULL — the Wave A
 * behaviour, byte for byte. Turning a field on is a deliberate act per field.
 *
 * The preview at the bottom is the point of the screen, exactly as the wording sheet's rendered body
 * is the point of that one: an administrator should read the sentences a ticket will experience
 * before they save, not infer them from six dropdowns. It is built from the same
 * `describeMacroActions` the macro's row in the list uses, so the two cannot disagree.
 *
 * What this screen does NOT check, and says so: whether the status is reachable from the status a
 * given ticket happens to be in. `OPEN → CLOSED` is a legal thing to configure and an illegal
 * transition from `NEW`; guessing at every ticket the macro might ever meet is not possible here, so
 * `applyMacroActions` checks against the real ticket at submit time, names this macro in the refusal,
 * and rolls the comment back with it.
 *
 * "Assign to one named person" is shown but not OFFERED: the schema and the applier support a user
 * id, and a macro that routes every ticket to one individual is a rota hazard that `Queue.autoAssign`
 * answers better. A macro that already carries an id keeps it and can be cleared. Recommended
 * default, pending confirmation.
 */

const UNCHANGED = "__UNCHANGED__";

/** `VOIDED` is deliberately absent: Decision #96 keeps voiding off the state machine entirely. */
const SELECTABLE_STATUSES: readonly TicketStatus[] = TICKET_STATUSES.filter((s) => s !== "VOIDED");

function FieldRow({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {label}
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function MacroActionsSheet({
  macro,
  className,
}: {
  macro: MacroAdminRow;
  className?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const uid = useId();

  const [status, setStatus] = useState<TicketStatus | null>(null);
  const [resolution, setResolution] = useState<TicketResolution | null>(null);
  const [priority, setPriority] = useState<TicketPriority | null>(null);
  const [queueKey, setQueueKey] = useState<QueueKey | null>(null);
  const [assignee, setAssignee] = useState<MacroAssigneeChoice>("unchanged");
  const [followUp, setFollowUp] = useState<string>("");
  const [escalation, setEscalation] = useState<EscalationTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ids = {
    status: `${uid}-status`,
    resolution: `${uid}-resolution`,
    priority: `${uid}-priority`,
    queue: `${uid}-queue`,
    assignee: `${uid}-assignee`,
    followUp: `${uid}-follow-up`,
    escalation: `${uid}-escalation`,
  };

  /** Seed on the OPEN transition only, so a list refresh cannot wipe what is being configured. */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const a = macro.actions;
      setStatus(a?.status ?? null);
      setResolution(a?.resolution ?? null);
      setPriority(a?.priority ?? null);
      setQueueKey(a?.queueKey ?? null);
      setAssignee(assigneeChoiceOf(a?.assignee));
      setFollowUp(a?.followUpInDays === undefined ? "" : String(a.followUpInDays));
      setEscalation(a?.escalationTarget ?? null);
      setError(null);
    }
    wasOpen.current = open;
    // The macro's fields are read at the instant of opening, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** The stored user id, when this macro already carries one. Kept rather than silently dropped. */
  const storedUserId =
    macro.actions?.assignee !== undefined && macro.actions?.assignee !== null && macro.actions.assignee !== "me"
      ? macro.actions.assignee
      : null;

  function build(): MacroActions {
    const next: MacroActions = {};
    if (status !== null) next.status = status;
    if (resolution !== null) next.resolution = resolution;
    if (priority !== null) next.priority = priority;
    if (queueKey !== null) next.queueKey = queueKey;
    if (assignee === "me") next.assignee = "me";
    if (assignee === "clear") next.assignee = null;
    if (assignee === "user" && storedUserId !== null) next.assignee = storedUserId;
    if (followUp.trim() !== "") next.followUpInDays = Number(followUp);
    if (escalation !== null) next.escalationTarget = escalation;
    return next;
  }

  const draft = build();
  const sentences = describeMacroActions(Object.keys(draft).length === 0 ? null : draft);

  function localError(): string | null {
    if (followUp.trim() !== "") {
      const n = Number(followUp);
      if (!Number.isInteger(n) || n < 0 || n > 365) return "Follow-up must be a whole number of days from 0 to 365.";
    }
    if (assignee === "user" && storedUserId === null) {
      return "This macro has no stored user to assign to. Choose another option.";
    }
    // The one coherence rule the outcome adds; the same sentence the server's schema refuses with.
    return macroOutcomeProblem(draft);
  }

  function applyError(err: ActionError): void {
    switch (err.code) {
      case "VALIDATION": {
        const detail = err.fieldErrors ? Object.values(err.fieldErrors).flat()[0] : undefined;
        setError(detail ?? err.message);
        toast.error(detail ?? err.message);
        return;
      }
      case "FORBIDDEN":
        toast.error("You do not have permission to change macros.");
        return;
      case "NOT_FOUND":
        toast.error("That macro no longer exists — refreshing.");
        setOpen(false);
        router.refresh();
        return;
      case "UNAUTHORIZED":
        toast.error("Your session has ended. Sign in again.");
        router.refresh();
        return;
      case "CONFLICT":
      case "INTERNAL":
        toast.error("The actions could not be saved. Nothing was changed.");
        return;
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const problem = localError();
    setError(problem);
    if (problem !== null) {
      toast.error(problem);
      return;
    }
    const next = build();
    startTransition(async () => {
      const result = await setMacroActions({
        macroId: macro.id,
        actions: Object.keys(next).length === 0 ? null : next,
      });
      if (!result.ok) {
        applyError(result);
        return;
      }
      toast.success(
        sentences.length === 0 ? `“${macro.title}” now inserts its body only` : `Actions saved for “${macro.title}”`,
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Edit the actions on ${macro.title}`}
      >
        <Wand2 aria-hidden />
        Actions
      </Button>

      <ResponsiveSheet
        open={open}
        onOpenChange={(o) => {
          if (!pending) setOpen(o);
        }}
        title="Macro actions"
        description="What this macro does to the ticket when its body is submitted. Every change is recorded in the audit log."
        size="lg"
        height="full"
      >
        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={pending || undefined}>
          <ResponsiveSheetBody className="flex flex-col gap-4">
            <p className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
              Actions are applied in the <span className="font-medium text-foreground">same transaction</span> as the
              comment: the reply and its side effects land together or not at all. Every field is re-checked against the
              real ticket first — the status state machine, your right to move the ticket, and whether the assignee can
              work the queue. A macro is a shortcut through the screen, never a way around the policy.
            </p>

            <FieldRow
              label={<Label htmlFor={ids.status}>Status</Label>}
              hint="Checked against the state machine at submit time. A ticket cannot be voided from a macro."
            >
              <Select
                value={status ?? UNCHANGED}
                onValueChange={(v) => setStatus(v === UNCHANGED ? null : (v as TicketStatus))}
                disabled={pending}
              >
                <SelectTrigger id={ids.status} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  <SelectItem value={UNCHANGED}>Leave the status alone</SelectItem>
                  {SELECTABLE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>

            <FieldRow
              label={<Label htmlFor={ids.resolution}>Outcome</Label>}
              hint="Recorded only when the status above resolves or closes the ticket, and only if the ticket does not already have an outcome."
            >
              <Select
                value={resolution ?? UNCHANGED}
                onValueChange={(v) => setResolution(v === UNCHANGED ? null : (v as TicketResolution))}
                disabled={pending}
              >
                <SelectTrigger id={ids.resolution} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  <SelectItem value={UNCHANGED}>Leave the outcome alone</SelectItem>
                  {OPERATOR_RESOLUTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {RESOLUTION_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>

            <div className="grid gap-4 sm:grid-cols-2">
              <FieldRow
                label={<Label htmlFor={ids.priority}>Priority</Label>}
                hint="Also re-stamps both SLA due dates from the ticket's original creation time."
              >
                <Select
                  value={priority ?? UNCHANGED}
                  onValueChange={(v) => setPriority(v === UNCHANGED ? null : (v as TicketPriority))}
                  disabled={pending}
                >
                  <SelectTrigger id={ids.priority} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value={UNCHANGED}>Leave the priority alone</SelectItem>
                    {TICKET_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PRIORITY_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>

              <FieldRow
                label={<Label htmlFor={ids.queue}>Queue</Label>}
                hint="Refused at submit time if the person sending the macro cannot hand tickets to that queue."
              >
                <Select
                  value={queueKey ?? UNCHANGED}
                  onValueChange={(v) => setQueueKey(v === UNCHANGED ? null : (v as QueueKey))}
                  disabled={pending}
                >
                  <SelectTrigger id={ids.queue} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value={UNCHANGED}>Leave the queue alone</SelectItem>
                    {QUEUE_KEYS.map((q) => (
                      <SelectItem key={q} value={q}>
                        {QUEUE_LABELS[q]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>

            <FieldRow
              label={<Label htmlFor={ids.assignee}>Assignee</Label>}
              hint={
                storedUserId === null
                  ? "Assigning to one named person is not offered here — use the queue's own auto-assignment instead."
                  : "This macro already names a specific person. Keep it, or choose another option to change it."
              }
            >
              <Select
                value={assignee}
                onValueChange={(v) => setAssignee(v as MacroAssigneeChoice)}
                disabled={pending}
              >
                <SelectTrigger id={ids.assignee} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  <SelectItem value="unchanged">{MACRO_ASSIGNEE_LABELS.unchanged}</SelectItem>
                  <SelectItem value="me">{MACRO_ASSIGNEE_LABELS.me}</SelectItem>
                  <SelectItem value="clear">{MACRO_ASSIGNEE_LABELS.clear}</SelectItem>
                  {storedUserId !== null ? (
                    <SelectItem value="user">{MACRO_ASSIGNEE_LABELS.user}</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </FieldRow>

            <div className="grid gap-4 sm:grid-cols-2">
              <FieldRow
                label={<Label htmlFor={ids.followUp}>Follow-up in days</Label>}
                hint="Blank leaves the follow-up alone. 0 clears it. Counted in firm days (America/New_York)."
              >
                <Input
                  id={ids.followUp}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={365}
                  step={1}
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                  disabled={pending}
                  placeholder="leave alone"
                />
              </FieldRow>

              <FieldRow label={<Label htmlFor={ids.escalation}>Escalation</Label>}>
                <Select
                  value={escalation ?? UNCHANGED}
                  onValueChange={(v) => setEscalation(v === UNCHANGED ? null : (v as EscalationTarget))}
                  disabled={pending}
                >
                  <SelectTrigger id={ids.escalation} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value={UNCHANGED}>Leave the escalation alone</SelectItem>
                    {ESCALATION_TARGETS.map((t) => (
                      <SelectItem key={t} value={t}>
                        {ESCALATION_TARGET_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium">What this will change</p>
              <div className="rounded-md border bg-card p-3 text-sm text-card-foreground" data-macro-actions-preview>
                {sentences.length === 0 ? (
                  <p className="text-muted-foreground">
                    Nothing. This macro inserts its body and changes no field — the behaviour every macro had before
                    actions existed.
                  </p>
                ) : (
                  <ul className="flex list-disc flex-col gap-1 pl-4">
                    {sentences.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
              {error !== null ? (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </ResponsiveSheetBody>

          <ResponsiveSheetFooter>
            <Button type="button" variant="outline" className="flex-1" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={pending} aria-busy={pending || undefined}>
              {pending ? "Saving…" : "Save actions"}
            </Button>
          </ResponsiveSheetFooter>
        </form>
      </ResponsiveSheet>
    </>
  );
}
