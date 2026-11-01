/**
 * SLA semantics — pure, layer L1 (Wave B Decision #99).
 * Status is computed, never stored; clocks are calendar 24x7.
 *
 * WAVE B WIDENING — the warning band is a POLICY reading, not a constant.
 * `SLA.warningMinutes` (per priority, editable at /admin/sla) replaces the fixed
 * `SLA_WARNING_THRESHOLD_MS`. The parameter is OPTIONAL and defaults to that constant, so every
 * pre-Wave-B call site still compiles and still classifies exactly as it did.
 *
 * A ticket does NOT snapshot `warningMinutes`, unlike `slaFirstResponseMinutes` /
 * `slaResolutionMinutes`, and the asymmetry is the decision rather than an oversight. The two due
 * STAMPS are commitments made when the ticket was raised: changing the policy afterwards must not
 * rewrite what the desk promised, which is why they are columns. WARNING is not a commitment — it is
 * "how much notice do we want before that promise comes due", a working preference of the desk
 * reading the board today. Editing it therefore re-colours open work on the next render and rewrites
 * no history, and `0` means "no warning band for this priority": the clock goes from ON_TRACK
 * straight to BREACHED.
 */
import { DEFAULT_SLA_POLICIES, SLA_WARNING_THRESHOLD_MS } from "@/types/domain";
import type { SlaEvaluation, SlaPolicyInput, SlaStatus, SlaTimerFields, TicketPriority } from "@/types/domain";

const MS_PER_MINUTE = 60_000;

/**
 * The warning half of an SLA policy. Deliberately its own tiny type rather than `SlaPolicyDTO`: the
 * live classification needs exactly one number, and a caller holding a Prisma `SLA` row, a DTO or a
 * literal can all satisfy it without importing the others.
 */
export type SlaWarningPolicy = {
  warningMinutes: number;
  /**
   * The `SLA` row's display name, when the caller loaded the row. Purely for display: it rides onto
   * `SlaEvaluation.policyName` so B2's `SlaDetailPopover` — whose props are fixed at
   * `{ sla, ticketNumber }` by CONTRACT §9 — can name the policy that produced the verdict without a
   * second prop and without a second read.
   */
  policyName?: string | null;
};

/** A whole policy as the live path reads it: the two due-date minutes plus the warning band. */
export type SlaPolicyWithWarning = SlaPolicyInput & SlaWarningPolicy;

/**
 * The warning band every priority had before Decision #99, and the value `prisma/schema.prisma`
 * defaults the column to. Stated here as minutes so the admin form, the migration default and the
 * classification cannot drift apart silently.
 */
export const DEFAULT_WARNING_MINUTES = SLA_WARNING_THRESHOLD_MS / MS_PER_MINUTE;

export function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/** Due dates stamped at creation and re-stamped from the original `createdAt` on priority change. */
export function computeDueDates(
  createdAt: Date,
  policy: SlaPolicyInput,
): { firstResponseDueAt: Date; resolutionDueAt: Date } {
  const base = createdAt.getTime();
  return {
    firstResponseDueAt: new Date(base + policy.firstResponseMinutes * MS_PER_MINUTE),
    resolutionDueAt: new Date(base + policy.resolutionMinutes * MS_PER_MINUTE),
  };
}

/**
 * The warning band in milliseconds for one policy. Unset, non-finite or negative minutes fall back to
 * the historical 30-minute constant rather than to zero: a malformed row must not silently delete the
 * warning band on the screen an operator watches, and `0` has to keep meaning the deliberate choice
 * somebody made at /admin/sla.
 */
export function slaWarningMs(policy: Partial<SlaWarningPolicy> | null | undefined): number {
  const minutes = policy?.warningMinutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return SLA_WARNING_THRESHOLD_MS;
  return Math.floor(minutes) * MS_PER_MINUTE;
}

function liveStatus(remainingMs: number, warningMs: number): SlaStatus {
  if (remainingMs < 0) return "BREACHED";
  if (remainingMs < warningMs) return "WARNING";
  return "ON_TRACK";
}

/**
 * §d pseudo-code, verbatim semantics:
 * - resolved → COMPLETE: MET only when both first response and resolution were on time, else BREACHED;
 * - no first response yet → FIRST_RESPONSE clock against firstResponseDueAt;
 * - otherwise → RESOLUTION clock against resolutionDueAt (with the first-response verdict in the tooltip).
 * Boundaries, with `W` the policy's warning band (30 min when no policy is passed): exactly `W`
 * remaining → ON_TRACK; remaining 0 → WARNING; strictly past due → BREACHED. `W = 0` collapses the
 * warning band, so the clock reads ON_TRACK until the instant it is overdue.
 *
 * Every returned evaluation carries the band it was computed with (`warningMinutes`) and, when the
 * caller passed one, the policy's name. Both are REPORTED, never re-read: a reader of the verdict can
 * say WHY the chip is amber without loading the policy table a second time and risking an answer that
 * disagrees with the colour it is explaining. `warningMinutes` is the EFFECTIVE band — 30 when the
 * policy was absent or malformed — so it always describes this verdict rather than the caller's input.
 */
export function computeSlaStatus(
  t: SlaTimerFields,
  now: Date = new Date(),
  policy?: Partial<SlaWarningPolicy> | null,
): SlaEvaluation {
  const warningMs = slaWarningMs(policy);
  // What actually governed this verdict, reported alongside it.
  const band = { warningMinutes: warningMs / MS_PER_MINUTE, policyName: policy?.policyName ?? null };
  const firstResponseDueAt = toDate(t.firstResponseDueAt);
  const resolutionDueAt = toDate(t.resolutionDueAt);
  const firstRespondedAt = t.firstRespondedAt == null ? null : toDate(t.firstRespondedAt);
  const resolvedAt = t.resolvedAt == null ? null : toDate(t.resolvedAt);

  if (resolvedAt !== null) {
    const firstResponseMet = (firstRespondedAt ?? resolvedAt).getTime() <= firstResponseDueAt.getTime();
    const resolutionMet = resolvedAt.getTime() <= resolutionDueAt.getTime();
    return {
      phase: "COMPLETE",
      status: firstResponseMet && resolutionMet ? "MET" : "BREACHED",
      dueAt: resolutionDueAt.toISOString(),
      remainingMs: resolutionDueAt.getTime() - resolvedAt.getTime(),
      firstResponseMet,
      resolutionMet,
      ...band,
    };
  }

  if (firstRespondedAt === null) {
    const remainingMs = firstResponseDueAt.getTime() - now.getTime();
    return {
      phase: "FIRST_RESPONSE",
      status: liveStatus(remainingMs, warningMs),
      dueAt: firstResponseDueAt.toISOString(),
      remainingMs,
      firstResponseMet: null,
      resolutionMet: null,
      ...band,
    };
  }

  const remainingMs = resolutionDueAt.getTime() - now.getTime();
  return {
    phase: "RESOLUTION",
    status: liveStatus(remainingMs, warningMs),
    dueAt: resolutionDueAt.toISOString(),
    remainingMs,
    firstResponseMet: firstRespondedAt.getTime() <= firstResponseDueAt.getTime(),
    resolutionMet: null,
    ...band,
  };
}

/** The policy row when present, else the code fallback `DEFAULT_SLA_POLICIES[priority]`. */
export function slaPolicyFor(priority: TicketPriority, row: SlaPolicyInput | null | undefined): SlaPolicyInput {
  const source = row ?? DEFAULT_SLA_POLICIES[priority];
  return { firstResponseMinutes: source.firstResponseMinutes, resolutionMinutes: source.resolutionMinutes };
}

/**
 * {@link slaPolicyFor} widened with the warning band. A row missing `warningMinutes` — the
 * shape every pre-Wave-B fixture and `DEFAULT_SLA_POLICIES` still has — reads as the 30-minute
 * default, so a database that has not been migrated classifies exactly as it did before.
 */
export function slaPolicyWithWarningFor(
  priority: TicketPriority,
  row: (SlaPolicyInput & Partial<SlaWarningPolicy>) | null | undefined,
): SlaPolicyWithWarning {
  const base = slaPolicyFor(priority, row);
  return { ...base, warningMinutes: slaWarningMs(row ?? null) / MS_PER_MINUTE };
}

/**
 * How a person reads a policy: "First response 30m · Resolve 2h · Warn 30m before due".
 *
 * Exported for the SLA popover and the policy admin table, which are owned by two different slices
 * and must not describe the same row two different ways. Minutes only — no instants, so it is safe on
 * both sides of the server/client boundary and needs no clock.
 */
export function describeSlaPolicy(policy: SlaPolicyWithWarning): string {
  const warning =
    policy.warningMinutes <= 0 ? "no warning band" : `warn ${formatSlaMinutes(policy.warningMinutes)} before due`;
  return `first response ${formatSlaMinutes(policy.firstResponseMinutes)} · resolve ${formatSlaMinutes(
    policy.resolutionMinutes,
  )} · ${warning}`;
}

/** `45m`, `2h`, `2h 30m`, `3d`, `1d 12h`. Whole minutes in, the shortest exact reading out. */
export function formatSlaMinutes(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes));
  if (total === 0) return "0m";
  const days = Math.floor(total / (60 * 24));
  const hours = Math.floor((total % (60 * 24)) / 60);
  const mins = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  return parts.join(" ");
}
