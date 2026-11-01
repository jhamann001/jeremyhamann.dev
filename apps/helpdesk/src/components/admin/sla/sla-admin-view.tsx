"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Timer, TriangleAlert, UserCheck } from "lucide-react";
import type { QueueKey } from "@/types/domain";
import { QUEUE_LABELS } from "@/types/domain";
import { PRIORITY_LABELS, formatDateTime } from "@/lib/format";
import type { QueueAutoAssignRow, SlaPolicyBoardRow } from "@/server/sla-policies";
import { saveSlaPolicy, setQueueAutoAssign } from "@/server/sla-policies.actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  SLA_FIELDS,
  SLA_FIELD_BOUNDS,
  SLA_FIELD_HINTS,
  SLA_FIELD_LABELS,
  draftFrom,
  draftNotes,
  humanMinutes,
  isDirty,
  validateDraft,
  type SlaDraft,
  type SlaField,
} from "@/components/admin/sla/sla-form-support";
import { cn } from "@/lib/utils";

/**
 * `/admin/sla` (docs/MOBILE_FIRST.md R1–R12).
 *
 * TWO SECTIONS, because this screen edits two different kinds of thing and conflating them is how an
 * administrator flips a rota while meaning to move a clock: the per-priority SLA policy, then the
 * per-queue auto-assignment switch.
 *
 * WHAT THE PAGE SAYS OUT LOUD, at the top, before any control. This is the question every person who
 * opens this screen has, and the honest answer is not obvious from the form:
 *   - the two due-date minutes are stamped on a ticket when it is raised, so editing them moves
 *     nothing that already exists — no due stamp is rewritten and no breach is un-breached;
 *   - `warningMinutes` is read live, so editing it re-colours open work on the next render.
 * Both are rendered as text rather than as a tooltip — a phone has no hover, and this is
 * exactly the kind of thing that must not be hover-only.
 *
 * One layout flip at `md`: below it each policy is a stacked card with a full-width Save; from `md`
 * the three fields sit in a row. Same data, same component, same URL at both widths.
 *
 * Every card holds its own draft and its own pending state, so saving URGENT does not reset what
 * somebody is typing into HIGH. `router.refresh()` after a save re-reads the server's numbers, which
 * is what makes "saved" mean "stored" rather than "accepted by the form".
 */

export type SlaAdminViewProps = {
  policies: SlaPolicyBoardRow[];
  queues: QueueAutoAssignRow[];
};

export function SlaAdminView({ policies, queues }: SlaAdminViewProps): React.JSX.Element {
  return (
    <section className="flex flex-col gap-6" data-slice="B4-sla-admin">
      <header className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">SLA policy</h2>
        <p className="text-sm text-muted-foreground">
          One policy per priority. Clocks are calendar minutes, 24×7 — they do not pause overnight, at
          weekends or while a ticket is waiting on a client.
        </p>
        <ul className="flex flex-col gap-1 rounded-lg border bg-card p-3 text-xs text-card-foreground">
          <li>
            <strong className="font-medium">Editing first response or resolution changes nothing that already exists.</strong>{" "}
            Those minutes are stamped on a ticket when it is raised. Due dates already on the board stay
            where they are, and a breach stays a breach.
          </li>
          <li>
            <strong className="font-medium">Editing the warning band re-colours open work immediately.</strong>{" "}
            It is read live rather than stamped, so the amber badges move on the next page load. No
            history is rewritten either way.
          </li>
        </ul>
      </header>

      <ul className="flex flex-col gap-3">
        {policies.map((p) => (
          <SlaPolicyCard key={p.priority} policy={p} />
        ))}
      </ul>

      <Separator />

      <div className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Auto-assignment</h2>
          <p className="text-sm text-muted-foreground">
            Off on every queue until somebody turns it on. When it is on, a ticket arriving in that queue
            is handed to the person with the fewest open tickets who holds write access, is active and is
            not out of office — least recently assigned first when they are level. It never overrides an
            assignee somebody has already set, and turning it off leaves existing assignments alone.
          </p>
        </header>
        <ul className="flex flex-col gap-2">
          {queues.map((q) => (
            <QueueAutoAssignCard key={q.key} queue={q} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function fieldBoundsHint(field: SlaField): string {
  const { min, max } = SLA_FIELD_BOUNDS[field];
  return `${min}–${max} minutes`;
}

function SlaPolicyCard({ policy }: { policy: SlaPolicyBoardRow }): React.JSX.Element {
  const router = useRouter();
  const uid = useId();
  const [pending, startTransition] = useTransition();

  const saved: Record<SlaField, number> = {
    firstResponseMinutes: policy.firstResponseMinutes,
    resolutionMinutes: policy.resolutionMinutes,
    warningMinutes: policy.warningMinutes,
  };
  const [draft, setDraft] = useState<SlaDraft>(() => draftFrom(saved));
  const [errors, setErrors] = useState<Partial<Record<SlaField, string>>>({});

  // Re-seed when the server's numbers change underneath the card (another administrator, a refresh).
  // Keyed on the stored values, so it cannot wipe what somebody is typing on an unrelated re-render.
  const lastSaved = useRef(`${saved.firstResponseMinutes}|${saved.resolutionMinutes}|${saved.warningMinutes}`);
  useEffect(() => {
    const key = `${policy.firstResponseMinutes}|${policy.resolutionMinutes}|${policy.warningMinutes}`;
    if (key === lastSaved.current) return;
    lastSaved.current = key;
    setDraft(
      draftFrom({
        firstResponseMinutes: policy.firstResponseMinutes,
        resolutionMinutes: policy.resolutionMinutes,
        warningMinutes: policy.warningMinutes,
      }),
    );
    setErrors({});
  }, [policy.firstResponseMinutes, policy.resolutionMinutes, policy.warningMinutes]);

  const verdict = validateDraft(draft);
  const dirty = isDirty(draft, saved) || !policy.configured;
  const notes = verdict.values === null ? [] : draftNotes(verdict.values);

  function onSave(): void {
    const checked = validateDraft(draft);
    const values = checked.values;
    if (values === null) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    startTransition(async () => {
      const result = await saveSlaPolicy({ priority: policy.priority, ...values });
      if (result.ok) {
        toast.success(`${PRIORITY_LABELS[policy.priority]} policy saved`);
        router.refresh();
        return;
      }
      switch (result.code) {
        case "FORBIDDEN":
          toast.error("You do not have permission to change SLA policy.");
          return;
        case "VALIDATION":
          setErrors(
            Object.fromEntries(
              Object.entries(result.fieldErrors ?? {}).map(([k, v]) => [k, (v ?? []).join(" ")]),
            ) as Partial<Record<SlaField, string>>,
          );
          toast.error(result.message);
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        case "NOT_FOUND":
        case "CONFLICT":
          toast.warning("That policy changed elsewhere — refreshing.");
          router.refresh();
          return;
        case "INTERNAL":
          toast.error("The change failed. Nothing was recorded.");
          return;
      }
    });
  }

  return (
    <li
      data-priority={policy.priority}
      data-configured={policy.configured ? "true" : "false"}
      className="flex flex-col gap-3 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Timer aria-hidden className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{PRIORITY_LABELS[policy.priority]}</h3>
        <Badge variant="outline" className="font-normal">
          {policy.name}
        </Badge>
        {policy.configured ? null : (
          <Badge variant="secondary" className="font-normal">
            Code default — not yet saved
          </Badge>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {SLA_FIELDS.map((field) => {
          const id = `${uid}-${field}`;
          const error = errors[field];
          return (
            <div key={field} className="flex flex-col gap-1.5">
              <Label htmlFor={id}>{SLA_FIELD_LABELS[field]} (minutes)</Label>
              <Input
                id={id}
                name={field}
                type="number"
                inputMode="numeric"
                min={SLA_FIELD_BOUNDS[field].min}
                max={SLA_FIELD_BOUNDS[field].max}
                step={1}
                value={draft[field]}
                disabled={pending}
                aria-invalid={error !== undefined || undefined}
                aria-describedby={`${id}-hint`}
                onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
              />
              <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                {SLA_FIELD_HINTS[field]} {fieldBoundsHint(field)}.
                {draft[field].trim() !== "" && error === undefined
                  ? ` That is ${humanMinutes(Number(draft[field]))}.`
                  : ""}
              </p>
              {error === undefined ? null : (
                <p className="text-xs text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {notes.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {notes.map((note) => (
            <li key={note} className="flex items-start gap-2 text-xs text-muted-foreground">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <p className="text-xs text-muted-foreground">
          {policy.updatedAt === null
            ? "Never saved on this desk — these are the code defaults."
            : `Last changed ${formatDateTime(policy.updatedAt)}.`}
        </p>
        <Button
          type="button"
          size="sm"
          className="w-full md:w-auto"
          disabled={pending || !dirty || verdict.values === null}
          aria-busy={pending || undefined}
          onClick={onSave}
        >
          {pending ? "Saving…" : policy.configured ? "Save policy" : "Save and pin this policy"}
        </Button>
      </div>
    </li>
  );
}

function QueueAutoAssignCard({ queue }: { queue: QueueAutoAssignRow }): React.JSX.Element {
  const router = useRouter();
  const uid = useId();
  const [pending, startTransition] = useTransition();
  const id = `${uid}-${queue.key}`;

  function onToggle(next: boolean): void {
    startTransition(async () => {
      const result = await setQueueAutoAssign({ queueKey: queue.key as QueueKey, autoAssign: next });
      if (result.ok) {
        toast.success(
          next
            ? `Auto-assignment on for ${QUEUE_LABELS[queue.key]}`
            : `Auto-assignment off for ${QUEUE_LABELS[queue.key]}`,
        );
        router.refresh();
        return;
      }
      switch (result.code) {
        case "FORBIDDEN":
          toast.error("You do not have permission to change auto-assignment.");
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        case "NOT_FOUND":
          toast.error("That queue no longer exists — refreshing.");
          router.refresh();
          return;
        default:
          toast.error("The change failed. Nothing was recorded.");
      }
    });
  }

  const empty = queue.eligibleAssignees === 0;

  return (
    <li
      data-queue={queue.key}
      data-auto-assign={queue.autoAssign ? "true" : "false"}
      className={cn(
        "flex flex-col gap-2 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-foreground/10",
        "md:flex-row md:items-center md:justify-between md:gap-4",
      )}
    >
      {/*
        R3, fix round 1. A `Switch` is 32x18 and is NOT in globals.css's phone tap rule — that rule
        lists ten `data-slot` values and `switch` is not among them, and widening the track there would
        break the thumb's `translate-x` geometry. The previous shape claimed "the tap target is the
        label row plus this wrapper" and then made the wrapper a plain `<div>` with no `onClick` and no
        `htmlFor`, so tapping anywhere in that 44 px row except the 32x18 switch did nothing; the only
        other target was the queue name, an ~18 px text node. These are the controls for Decision #98,
        so they are the primary interactive elements on the page.

        The whole row IS the control now: ONE `Label` (never two nested ones) whose `htmlFor` names the
        switch, at least 44 px tall. A click on the switch itself is not re-dispatched by the label —
        the labeled control is interactive content — so it cannot double-toggle.
      */}
      <Label
        htmlFor={id}
        className="flex min-h-11 w-full cursor-pointer flex-col gap-2 font-normal md:flex-row md:items-center md:justify-between md:gap-4"
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2">
            <UserCheck aria-hidden className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{QUEUE_LABELS[queue.key]}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            {empty
              ? "Nobody currently holds write access to this queue and is available, so turning this on would assign nothing."
              : `${queue.eligibleAssignees} ${queue.eligibleAssignees === 1 ? "person is" : "people are"} on the rota right now.`}
          </span>
        </span>

        <span className="flex min-h-11 items-center gap-3 md:shrink-0">
          <span className="text-xs text-muted-foreground" aria-hidden>
            {queue.autoAssign ? "On" : "Off"}
          </span>
          <Switch
            id={id}
            checked={queue.autoAssign}
            disabled={pending}
            aria-busy={pending || undefined}
            aria-label={`Auto-assignment for ${QUEUE_LABELS[queue.key]}`}
            onCheckedChange={onToggle}
          />
        </span>
      </Label>
    </li>
  );
}
