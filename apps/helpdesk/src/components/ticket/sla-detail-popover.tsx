"use client";

import { useState } from "react";
import { Clock } from "lucide-react";
import type { SlaEvaluation, SlaPhase, SlaStatus } from "@/types/domain";
import { SLA_WARNING_THRESHOLD_MS } from "@/types/domain";
import { formatDateTime, formatDuration, formatTicketNumber, SLA_LABELS } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ResponsivePopover } from "@/components/shell/responsive-sheet";

/**
 * SLA detail, on tap (MOBILE_FIRST R10).
 *
 * `SlaBadge` keeps its facts in a `title` tooltip. A phone has no hover, so R10 says a `title` is not a
 * visible explanation — this popover is the visible form. `ResponsivePopover` gives it a bottom sheet
 * on phones and a popover from md, with the same content in both.
 *
 * Every instant is rendered by `formatDateTime`, which is pinned to the firm clock with an explicit
 * `ET` suffix. "Due 14:30" on a screen in Denver is the kind of number a desk acts on
 * and then has to explain.
 *
 * `warningMinutes` is a LIVE reading of the policy, not a verdict a ticket snapshots, so
 * the popover says which band it is quoting. The prop is OPTIONAL: the foundation's mount passes only
 * `sla` and `ticketNumber` (the props are the contract), and without a policy the popover quotes
 * the code default rather than inventing a number. See the integration note.
 */
export type SlaDetailPopoverProps = {
  sla: SlaEvaluation;
  ticketNumber: number;
  /** B4's live policy row, when the mount can supply it. Optional by contract — see the module note. */
  policy?: { name?: string | null; warningMinutes?: number | null } | null;
};

const PHASE_TITLE: Readonly<Record<SlaPhase, string>> = {
  FIRST_RESPONSE: "First-response clock",
  RESOLUTION: "Resolution clock",
  COMPLETE: "Resolved — final verdict",
};

/**
 * What actually stops each clock. This is the paragraph the crosswalk argument is about, so
 * it says the unwelcome half out loud: the clocks are 24×7 and Pending does not pause them.
 */
const PHASE_STOPS: Readonly<Record<SlaPhase, string>> = {
  FIRST_RESPONSE:
    "Stopped by the first public reply, or by recording a call, voicemail or in-person contact. An internal note, an assignment or a status change does not stop it.",
  RESOLUTION: "Stopped by moving the ticket to Resolved. Nothing else stops it.",
  COMPLETE: "Both clocks have stopped. Reopening the ticket restarts the resolution clock against the same due date.",
};

const STATUS_TONE: Readonly<Record<SlaStatus, string>> = {
  ON_TRACK: "text-foreground",
  WARNING: "text-amber-700 dark:text-amber-300",
  BREACHED: "text-destructive",
  MET: "text-emerald-700 dark:text-emerald-300",
};

function remainingLine(sla: SlaEvaluation): string {
  if (sla.remainingMs === null) return "No clock running.";
  if (sla.phase === "COMPLETE") {
    return sla.remainingMs >= 0
      ? `Resolved ${formatDuration(sla.remainingMs)} before it was due.`
      : `Resolved ${formatDuration(Math.abs(sla.remainingMs))} after it was due.`;
  }
  return sla.remainingMs >= 0
    ? `${formatDuration(sla.remainingMs)} left.`
    : `${formatDuration(Math.abs(sla.remainingMs))} over.`;
}

function verdict(met: boolean | null): string {
  if (met === null) return "not yet decided";
  return met ? "met" : "missed";
}

/** The first of its arguments that is a real, non-negative minute count. `0` is a value, not absence. */
function firstFiniteNonNegative(...values: Array<number | null | undefined>): number | null {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  }
  return null;
}

export function SlaDetailPopover({ sla, ticketNumber, policy }: SlaDetailPopoverProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);

  // Integration round 1: `SlaEvaluation` now REPORTS the band that produced this verdict
  //, so the evaluation wins over the optional prop. That ordering is
  // the point rather than a preference: the prop is whatever the mount happened to load, while
  // `sla.warningMinutes` is the number that actually decided the colour this popover is explaining.
  // A popover that quoted a band the chip did not use would be worse than one that quoted none.
  // The prop remains as the fallback for a mount that renders an evaluation from before this landed.
  const band = firstFiniteNonNegative(sla.warningMinutes, policy?.warningMinutes);
  const warningMinutes =
    band ??
    // The historical constant, from the foundation-owned table rather than from B4's module: this
    // popover must not depend on an export the SLA contract does not name.
    SLA_WARNING_THRESHOLD_MS / 60_000;
  const policyName = (sla.policyName ?? policy?.name ?? "").trim();

  return (
    <ResponsivePopover
      open={open}
      onOpenChange={setOpen}
      title={`SLA for ${formatTicketNumber(ticketNumber)}`}
      className="w-80 p-0"
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 md:min-h-8"
          data-slice="B2-sla-detail"
          data-sla-status={sla.status}
        >
          <Clock aria-hidden />
          SLA detail
        </Button>
      }
    >
      <div className="flex flex-col gap-3 px-4 pb-2 md:p-3">
        <div>
          <p className="text-xs text-muted-foreground">{PHASE_TITLE[sla.phase]}</p>
          <p className={`text-sm font-semibold ${STATUS_TONE[sla.status]}`}>
            {SLA_LABELS[sla.status]} — {remainingLine(sla)}
          </p>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Due</dt>
          <dd className="tabular-nums" suppressHydrationWarning>
            {sla.dueAt === null ? "—" : formatDateTime(sla.dueAt)}
          </dd>
          <dt className="text-muted-foreground">First response</dt>
          <dd>{verdict(sla.firstResponseMet)}</dd>
          <dt className="text-muted-foreground">Resolution</dt>
          <dd>{verdict(sla.resolutionMet)}</dd>
          <dt className="text-muted-foreground">Warning band</dt>
          <dd>
            {warningMinutes === 0
              ? "none for this priority"
              : `${warningMinutes} minutes before it is due`}
            {policyName.length > 0 ? ` · ${policyName}` : null}
          </dd>
        </dl>

        <p className="text-xs text-muted-foreground">{PHASE_STOPS[sla.phase]}</p>
        <p className="text-xs text-muted-foreground">
          Clocks run 24×7 in firm time (ET). Pending client and Pending internal do not pause them.
        </p>
      </div>
    </ResponsivePopover>
  );
}
