/**
 * SLA status as SQL predicates — node, layer L4 (docs/ARCHITECTURE.md §d, I10, Decision 14;
 * Wave B Decisions #96 and #99).
 *
 * These predicates MUST classify a ticket exactly as the pure `computeSlaStatus` does, so the
 * `slaStatus` list filter can run in the database (before pagination) and queue counters agree with
 * the badges. Column-to-column comparisons (resolvedAt vs its due dates) use Prisma field references
 * (`prisma.ticket.fields`). The DB-gated `sla-where.test.ts` asserts the agreement over a fixture matrix.
 *
 * With `F = prisma.ticket.fields`, `now`, and `W` the priority's warning band (`now + warningMinutes`):
 *   ON_TRACK  unresolved, live clock due at/after W
 *   WARNING   unresolved, live clock due in [now, W)
 *   BREACHED  unresolved and live clock past due; or resolved with a late resolution or a late (or
 *             missing-and-late) first response
 *   MET       resolved on time with the first response (or, absent one, the resolution) on time
 *
 * TWO WAVE B CHANGES, both of which the contract makes binding:
 *
 * 1. **VOIDED never counts.** `METRICS_EXCLUDED_STATUSES` is applied as a sibling of the OR, so every
 *    surface built on these predicates — the list filter, both queue counters, the sweep — drops a
 *    ticket that was entered in error. The dev seed carries a VOIDED ticket that is BREACHED on its
 *    raw timers precisely so a surface that forgets shows it immediately.
 * 2. **The warning band is per priority.** `warningMinutes` is read LIVE from the `SLA` table rather
 *    than snapshotted on the ticket, so `W` is a function of the ticket's priority. When every
 *    priority shares one band — which is the shipped default, and what `loadWarningMinutes()` returns
 *    on an un-edited policy table — the predicate collapses back to the single un-partitioned form
 *    Wave A emitted, so the common case costs no extra SQL and the old shape is still what a reader
 *    sees in a query plan.
 */
import type { Prisma } from "@prisma/client";
import type { SlaStatus, TicketPriority } from "@/types/domain";
import { METRICS_EXCLUDED_STATUSES, OPEN_STATUSES, TICKET_PRIORITIES } from "@/types/domain";
import { prisma } from "@/lib/db";
import { DEFAULT_WARNING_MINUTES } from "@/lib/sla";

/**
 * Warning bands by priority, as `/admin/sla` stores them. Partial on purpose: a priority the caller
 * did not load reads as the 30-minute default rather than as "no warning", so a failed or narrowed
 * read degrades to the historical behaviour instead of blanking the amber band.
 */
export type WarningMinutesByPriority = Readonly<Partial<Record<TicketPriority, number>>>;

const MS_PER_MINUTE = 60_000;

/** Minutes for one priority, clamped to a sane non-negative integer. */
export function warningMinutesFor(
  priority: TicketPriority,
  warnings: WarningMinutesByPriority | undefined,
): number {
  const raw = warnings?.[priority];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return DEFAULT_WARNING_MINUTES;
  return Math.floor(raw);
}

/**
 * The live policy table as a map. ONE query, no caching: the whole point of Decision #99 is that an
 * edit re-colours open work on the next render, and a process-lifetime cache would make "live" mean
 * "until the next deploy". The table has one row per priority — four rows — so the read is trivial.
 *
 * A missing row is simply absent from the map, which `warningMinutesFor` reads as the default.
 */
export async function loadWarningMinutes(): Promise<WarningMinutesByPriority> {
  const rows = await prisma.sLA.findMany({ select: { priority: true, warningMinutes: true } });
  const out: Partial<Record<TicketPriority, number>> = {};
  for (const row of rows) out[row.priority] = row.warningMinutes;
  return out;
}

/**
 * The same read, plus each policy's display NAME — what the ticket DTOs need.
 *
 * Integration round 1: `SlaEvaluation` now reports the band that produced its verdict
 * (`warningMinutes`) and the policy's name (`policyName`), so B2's `SlaDetailPopover` can explain an
 * amber chip without a second read that might disagree with the colour it is explaining. The SQL
 * predicates only ever need the minutes, so `loadWarningMinutes` stays exactly as it was and the two
 * counters and the sweep keep using it; this is the wider read for the render path.
 */
export type SlaBand = { warningMinutes: number; policyName: string };
export type SlaBandsByPriority = Readonly<Partial<Record<TicketPriority, SlaBand>>>;

export async function loadSlaBands(): Promise<SlaBandsByPriority> {
  const rows = await prisma.sLA.findMany({ select: { priority: true, warningMinutes: true, name: true } });
  const out: Partial<Record<TicketPriority, SlaBand>> = {};
  for (const row of rows) out[row.priority] = { warningMinutes: row.warningMinutes, policyName: row.name };
  return out;
}

/**
 * One priority's band, in the shape `computeSlaStatus` takes. A missing or malformed row degrades to
 * the 30-minute default with a null name — never to "no warning band", for the reason
 * `warningMinutesFor` states.
 */
export function slaBandFor(
  priority: TicketPriority,
  bands: SlaBandsByPriority | undefined,
): { warningMinutes: number; policyName: string | null } {
  const row = bands?.[priority];
  return {
    warningMinutes: warningMinutesFor(priority, row === undefined ? undefined : { [priority]: row.warningMinutes }),
    policyName: row?.policyName ?? null,
  };
}

/**
 * The minutes half of a band map, in the shape the SQL predicates take.
 *
 * A surface that RENDERS chips reads `loadSlaBands()` once; the predicate that decides which rows it
 * renders has to be built from that SAME read, or the "SLA: Warning" filter and the amber chip can
 * disagree the moment `/admin/sla` moves a priority off the 30-minute default. Deriving
 * the map here — through `slaBandFor`, the same accessor the chip goes through — is what keeps the two
 * exactly in step, instead of issuing a second read that could catch a different policy row.
 *
 * Every priority is present in the result, because a missing one is the 30-minute default anyway and
 * `warningMinutesFor` would read it that way regardless.
 */
export function warningMinutesFromBands(bands: SlaBandsByPriority | undefined): WarningMinutesByPriority {
  const out: Partial<Record<TicketPriority, number>> = {};
  for (const p of TICKET_PRIORITIES) out[p] = slaBandFor(p, bands).warningMinutes;
  return out;
}

/** The live-clock window for one warning band: `[now, now + minutes)` is WARNING, `>= W` is ON_TRACK. */
function windowFor(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * MS_PER_MINUTE);
}

/** ON_TRACK / WARNING for ONE warning band, unpartitioned by priority (the Wave A shape). */
function livePredicate(status: "ON_TRACK" | "WARNING", now: Date, W: Date): Prisma.TicketWhereInput {
  if (status === "ON_TRACK") {
    return {
      resolvedAt: null,
      OR: [
        { firstRespondedAt: null, firstResponseDueAt: { gte: W } },
        { firstRespondedAt: { not: null }, resolutionDueAt: { gte: W } },
      ],
    };
  }
  return {
    resolvedAt: null,
    OR: [
      { firstRespondedAt: null, firstResponseDueAt: { gte: now, lt: W } },
      { firstRespondedAt: { not: null }, resolutionDueAt: { gte: now, lt: W } },
    ],
  };
}

/**
 * ON_TRACK / WARNING across every priority. One branch per DISTINCT warning band, each carrying the
 * priorities that share it, so four identical bands stay one predicate and two distinct bands cost
 * two — never four branches for four priorities that all read 30.
 */
function livePredicateByPriority(
  status: "ON_TRACK" | "WARNING",
  now: Date,
  warnings: WarningMinutesByPriority | undefined,
): Prisma.TicketWhereInput {
  const byMinutes = new Map<number, TicketPriority[]>();
  for (const p of TICKET_PRIORITIES) {
    const minutes = warningMinutesFor(p, warnings);
    const bucket = byMinutes.get(minutes);
    if (bucket === undefined) byMinutes.set(minutes, [p]);
    else bucket.push(p);
  }

  const [only] = [...byMinutes.keys()];
  if (byMinutes.size === 1 && only !== undefined) {
    // Every priority shares one band: emit exactly the predicate Wave A emitted.
    return livePredicate(status, now, windowFor(now, only));
  }

  return {
    OR: [...byMinutes.entries()].map(([minutes, priorities]) => ({
      priority: priorities.length === 1 ? priorities[0] : { in: priorities },
      ...livePredicate(status, now, windowFor(now, minutes)),
    })),
  };
}

function predicate(
  status: SlaStatus,
  now: Date,
  warnings: WarningMinutesByPriority | undefined,
): Prisma.TicketWhereInput {
  const F = prisma.ticket.fields;
  switch (status) {
    case "ON_TRACK":
    case "WARNING":
      return livePredicateByPriority(status, now, warnings);
    case "BREACHED":
      return {
        OR: [
          { resolvedAt: null, firstRespondedAt: null, firstResponseDueAt: { lt: now } },
          { resolvedAt: null, firstRespondedAt: { not: null }, resolutionDueAt: { lt: now } },
          {
            resolvedAt: { not: null },
            OR: [
              { resolvedAt: { gt: F.resolutionDueAt } },
              { firstRespondedAt: null, resolvedAt: { gt: F.firstResponseDueAt } },
              { firstRespondedAt: { gt: F.firstResponseDueAt } },
            ],
          },
        ],
      };
    case "MET":
      return {
        resolvedAt: { not: null, lte: F.resolutionDueAt },
        OR: [
          { firstRespondedAt: null, resolvedAt: { lte: F.firstResponseDueAt } },
          { firstRespondedAt: { lte: F.firstResponseDueAt } },
        ],
      };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Tickets that are nobody's number. Applied by every export in this module. */
export const NOT_EXCLUDED_FROM_METRICS: Prisma.TicketWhereInput = {
  status: { notIn: [...METRICS_EXCLUDED_STATUSES] },
};

/**
 * OR of the §d predicates for the requested statuses (deduplicated), AND the metrics exclusion.
 * `[]` constrains status only — a list with no SLA filter still must not show a voided ticket.
 *
 * `warnings` is optional and OMITTING it is not a bug: a caller that has no reason to hit the policy
 * table (a unit test, a surface that only asks for BREACHED or MET) gets the 30-minute default, which
 * is what the column defaults to anyway. A caller that renders the amber band passes
 * `await loadWarningMinutes()`.
 */
export function slaStatusWhere(
  statuses: readonly SlaStatus[],
  now: Date,
  warnings?: WarningMinutesByPriority,
): Prisma.TicketWhereInput {
  const unique = [...new Set(statuses)];
  if (unique.length === 0) return { ...NOT_EXCLUDED_FROM_METRICS };
  return { ...NOT_EXCLUDED_FROM_METRICS, OR: unique.map((s) => predicate(s, now, warnings)) };
}

/** Open-ticket (status ∈ OPEN_STATUSES) BREACHED predicate for queue counters. */
export function breachedOpenWhere(now: Date, warnings?: WarningMinutesByPriority): Prisma.TicketWhereInput {
  return { AND: [{ status: { in: [...OPEN_STATUSES] } }, predicate("BREACHED", now, warnings)] };
}

/** Open-ticket (status ∈ OPEN_STATUSES) WARNING predicate for queue counters. */
export function warningOpenWhere(now: Date, warnings?: WarningMinutesByPriority): Prisma.TicketWhereInput {
  return { AND: [{ status: { in: [...OPEN_STATUSES] } }, predicate("WARNING", now, warnings)] };
}
