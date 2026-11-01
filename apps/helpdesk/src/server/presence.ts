/**
 * "Who else is looking at this" — node, layer L4.
 *
 * Presence is DERIVED FROM THE LEDGER: the `TICKET_VIEWED` rows the desk already writes for every
 * audited read. No heartbeat channel, no socket, no extra table, no new write path — and, because
 * it IS the audit trail, the chip can never disagree with it. A colleague the chip shows is a
 * colleague the ledger can prove was there.
 *
 * READING presence is NOT AUDITED. It returns names and instants about STAFF, not record
 * content about a client, and auditing a 30-second poll would add two rows a minute per open tab to an
 * evidentiary ledger in order to record nothing about anybody's data.
 */
import type { AuditAction, PresenceDTO, UserRef, Viewer } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";
import { prisma } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { canReadQueue } from "@/lib/rbac";
import { USER_REF_SELECT, toUserRef } from "@/server/tickets";

/**
 * The actions that mean "a person had this ticket open".
 *
 * `TICKET_PREVIEWED` is deliberately excluded: a slide-over on the dashboard is a glance at a list, not
 * somebody working the ticket, and showing it would tell an operator a colleague is on a ticket they
 * closed a second later.
 */
export const PRESENCE_ACTIONS = ["TICKET_VIEWED"] as const satisfies readonly AuditAction[];

/** Start of the window a view still counts in. Pure. */
export function presenceWindowStart(now: Date, windowMs: number = WAVE_B_LIMITS.presenceWindowMs): Date {
  return new Date(now.getTime() - windowMs);
}

export type PresenceSighting = { actorId: string | null; occurredAt: Date };

/**
 * Most recent sighting per actor, newest first, excluding the viewer themselves. Pure.
 *
 * Deduplicating HERE rather than with a `DISTINCT ON` keeps the query an ordinary index scan over
 * `(ticketId, occurredAt)` and keeps the rule — "one row per person, their latest" — in a function a
 * test can state in one line.
 */
export function latestByActor(rows: readonly PresenceSighting[], excludeActorId: string): Map<string, Date> {
  const latest = new Map<string, Date>();
  for (const row of rows) {
    const id = row.actorId;
    if (id === null || id === excludeActorId) continue;
    const seen = latest.get(id);
    if (seen === undefined || row.occurredAt.getTime() > seen.getTime()) latest.set(id, row.occurredAt);
  }
  return latest;
}

/** Assemble the DTO from the deduplicated sightings and the user rows. Pure. */
export function toPresenceDTO(latest: Map<string, Date>, users: readonly UserRef[], generatedAt: Date): PresenceDTO {
  const byId = new Map(users.map((u) => [u.id, u]));
  const viewers = [...latest.entries()]
    .flatMap(([id, at]) => {
      const user = byId.get(id);
      return user === undefined ? [] : [{ user, at: at.toISOString() }];
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  return { viewers, generatedAt: generatedAt.toISOString() };
}

/**
 * Who, other than the viewer, has read this ticket inside `WAVE_B_LIMITS.presenceWindowMs`.
 *
 * Throws `ForbiddenError` when the viewer cannot read the ticket's queue; the route turns that into a
 * 404 so presence never reveals that a ticket exists somewhere the caller may not look. A missing
 * ticket answers with an EMPTY presence for the same reason.
 *
 * Deactivated users are dropped: an account that has been offboarded is not "currently looking at
 * this", however recently its last view was written.
 */
export async function ticketPresence(viewer: Viewer, ticketId: string, now: Date = new Date()): Promise<PresenceDTO> {
  const empty: PresenceDTO = { viewers: [], generatedAt: now.toISOString() };
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, queue: { select: { key: true } } },
  });
  if (!ticket) return empty;
  if (!canReadQueue(viewer.groups, ticket.queue.key)) {
    throw new ForbiddenError("Forbidden: queue:read", ticket.id);
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      ticketId: ticket.id,
      action: { in: [...PRESENCE_ACTIONS] },
      occurredAt: { gte: presenceWindowStart(now) },
      actorId: { not: null },
    },
    select: { actorId: true, occurredAt: true },
    orderBy: { occurredAt: "desc" },
    // A bounded scan: the window is minutes, and a ticket nobody can stop opening still cannot make
    // this query unbounded.
    take: 200,
  });

  const latest = latestByActor(rows, viewer.id);
  if (latest.size === 0) return empty;

  const users = await prisma.user.findMany({
    where: { id: { in: [...latest.keys()] }, isActive: true },
    select: USER_REF_SELECT,
  });
  return toPresenceDTO(latest, users.map(toUserRef), now);
}
