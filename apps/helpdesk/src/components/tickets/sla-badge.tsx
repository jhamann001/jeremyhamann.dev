"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import type { SlaEvaluation, SlaPhase, SlaStatus, SlaTimerFields } from "@/types/domain";
import { computeSlaStatus } from "@/lib/sla";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { sentenceCase, slaBadgeAriaLabel, slaBadgeLabel, slaCompleteDetail } from "@/components/tickets/sla-badge-label";

/** The badge re-evaluates the pure SLA function on this cadence. */
const RECOMPUTE_INTERVAL_MS = 30_000;

const PHASE_LABELS: Readonly<Record<SlaPhase, string>> = {
  FIRST_RESPONSE: "First-response clock",
  RESOLUTION: "Resolution clock",
  COMPLETE: "Resolved — final verdict",
};

/** §d badge mapping. WARNING/MET use explicit classes; ON_TRACK/BREACHED use Badge variants. */
const STATUS_VARIANT: Readonly<Record<SlaStatus, "outline" | "destructive">> = {
  ON_TRACK: "outline",
  WARNING: "outline",
  BREACHED: "destructive",
  MET: "outline",
};

const STATUS_CLASSES: Readonly<Record<SlaStatus, string>> = {
  ON_TRACK: "",
  WARNING:
    "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200 animate-pulse",
  BREACHED: "font-semibold",
  MET: "border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
};

function verdictText(met: boolean | null, pendingLabel: string): string {
  if (met === null) return pendingLabel;
  return met ? "met" : "missed";
}

export function SlaBadge({
  timers,
  initial,
  compact,
}: {
  timers: SlaTimerFields;
  initial?: SlaEvaluation;
  compact?: boolean;
}): React.JSX.Element {
  // `now` is null until mount so the first client paint equals the server's render (`initial`);
  // afterwards the pure function is re-run from the timer fields every 30 s.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), RECOMPUTE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  const evaluation: SlaEvaluation = now
    ? computeSlaStatus(timers, now)
    : (initial ?? computeSlaStatus(timers));

  const { status, phase, dueAt, firstResponseMet } = evaluation;
  // §d / Decision #47: live phases carry the remaining time; COMPLETE is a bare verdict ("Met" / "Breached")
  // and its deltas live in the tooltip.
  const label = slaBadgeLabel(evaluation, compact);
  const complete = slaCompleteDetail(timers, evaluation);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={STATUS_VARIANT[status]}
          className={cn("gap-1 tabular-nums", STATUS_CLASSES[status])}
          data-sla-status={status}
          data-sla-phase={phase}
          aria-label={slaBadgeAriaLabel(evaluation)}
        >
          <Clock aria-hidden />
          <span suppressHydrationWarning>{label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5 text-left">
        <span className="font-medium">{PHASE_LABELS[phase]}</span>
        {complete ? (
          <>
            <span suppressHydrationWarning>Resolution due {dueAt ? formatDateTime(dueAt) : "—"}</span>
            <span>{sentenceCase(complete.resolution)}</span>
            <span>{sentenceCase(complete.firstResponse)}</span>
          </>
        ) : (
          <>
            <span suppressHydrationWarning>Due {dueAt ? formatDateTime(dueAt) : "—"}</span>
            <span>First response: {verdictText(firstResponseMet, "pending")}</span>
          </>
        )}
        <span className="text-background/70">SLA clocks run 24x7</span>
      </TooltipContent>
    </Tooltip>
  );
}
