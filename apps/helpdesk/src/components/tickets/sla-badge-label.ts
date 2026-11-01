/**
 * Pure label and tooltip wording for `SlaBadge` (docs/ARCHITECTURE.md §d badge mapping).
 *
 * Live phases (FIRST_RESPONSE / RESOLUTION) show the status with the remaining time: "On track · 1h 12m",
 * "Warning · 18m", "Breached · -23m". The COMPLETE phase is a verdict, not a clock: it shows "Met" or
 * "Breached" WITHOUT a duration — "Breached · 9h" (a positive remaining time next to Breached) read as a
 * contradiction — and the deltas move into the tooltip ("resolved 9h before the resolution deadline";
 * "first response missed by 4h"). JSX-free so the wording is unit-testable under vitest's `*.test.ts` include.
 */
import type { SlaEvaluation, SlaTimerFields } from "@/types/domain";
import { SLA_LABELS, formatDuration } from "@/lib/format";
import { toDate } from "@/lib/sla";

/** Badge text. `compact` drops the status word on live phases ("1h 12m"); COMPLETE is always just the verdict. */
export function slaBadgeLabel(evaluation: SlaEvaluation, compact = false): string {
  const label = SLA_LABELS[evaluation.status];
  if (evaluation.phase === "COMPLETE" || evaluation.remainingMs === null) return label;
  const duration = formatDuration(evaluation.remainingMs);
  return compact ? duration : `${label} · ${duration}`;
}

/** Accessible name: the live remaining time is appended for live phases only. */
export function slaBadgeAriaLabel(evaluation: SlaEvaluation): string {
  const label = SLA_LABELS[evaluation.status];
  if (evaluation.phase === "COMPLETE" || evaluation.remainingMs === null) return `SLA ${label}`;
  return `SLA ${label}, ${formatDuration(evaluation.remainingMs)}`;
}

export type SlaCompleteDetail = {
  /** "resolved 9h before the resolution deadline" | "resolution missed by 23m" */
  resolution: string;
  /** "first response 1h 5m before its deadline" | "first response missed by 4h" (+ a note when counted at resolution) */
  firstResponse: string;
};

/**
 * Tooltip lines for a COMPLETE ticket, derived from the timer fields with the §d semantics (a ticket
 * resolved without a public reply counts its resolution time as the first response). Null for live phases.
 */
export function slaCompleteDetail(timers: SlaTimerFields, evaluation: SlaEvaluation): SlaCompleteDetail | null {
  if (evaluation.phase !== "COMPLETE" || timers.resolvedAt == null) return null;
  const resolvedAt = toDate(timers.resolvedAt).getTime();
  const resolutionDelta = toDate(timers.resolutionDueAt).getTime() - resolvedAt;
  const countedAtResolution = timers.firstRespondedAt == null;
  const respondedAt = countedAtResolution ? resolvedAt : toDate(timers.firstRespondedAt as Date | string).getTime();
  const firstResponseDelta = toDate(timers.firstResponseDueAt).getTime() - respondedAt;
  const note = countedAtResolution ? " (no public reply — counted at resolution)" : "";
  return {
    resolution:
      resolutionDelta >= 0
        ? `resolved ${formatDuration(resolutionDelta)} before the resolution deadline`
        : `resolution missed by ${formatDuration(-resolutionDelta)}`,
    firstResponse:
      firstResponseDelta >= 0
        ? `first response ${formatDuration(firstResponseDelta)} before its deadline${note}`
        : `first response missed by ${formatDuration(-firstResponseDelta)}${note}`,
  };
}

/** "resolved 9h …" → "Resolved 9h …" for display. */
export function sentenceCase(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}
