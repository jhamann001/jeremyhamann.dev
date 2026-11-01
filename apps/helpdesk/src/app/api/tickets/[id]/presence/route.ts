/**
 * GET /api/tickets/[id]/presence — "who else is looking at this"
 *.
 *
 * SESSION auth (`requireViewerOrThrow`) plus the ticket's own `queue:read`, checked inside
 * `ticketPresence`. It sits INSIDE the middleware matcher like every other staff surface.
 *
 * **NOT AUDITED, by contract.** The answer is staff names and instants derived from `TICKET_VIEWED`
 * rows that are already in the ledger — no description, no comment body, no requester data. A 30-second
 * poll per open tab would otherwise add two rows a minute per reader to an evidentiary ledger, to
 * record nothing about anybody's records.
 *
 * A ticket that is missing, or in a queue this viewer cannot read, answers 404 with no body — the same
 * answer for both, so presence never reveals that a ticket exists somewhere the caller may not look.
 * A missing ticket is not a refusal at all (`ticketPresence` answers an empty presence), so the only
 * thing recorded here is a real `queue:read` denial on a real ticket.
 *
 * **The refusal is audited, and COALESCED** — the one place in this repository where an AUTHENTICATED
 * denial is. Everywhere else a staff denial is a rare, deliberate act and gets its own row; this route
 * is the single Wave B surface DESIGNED to be polled (`PresenceChip` re-fetches every 30 seconds), so
 * a tab left open on a ticket whose queue the viewer has since lost would append two rows a minute,
 * 2,880 a day, to an append-only ledger with no retention job — each one taking the global
 * `AuditLog.chain` advisory lock every other audited write queues behind. Decision #71's answer,
 * applied to a polled staff surface:
 *
 *  - the FIRST refusal per (viewer, ticket) per window is a full `AUTHZ_DENIED` row, actor and ticket
 *    named, exactly as `recordDenied` would have written it — nothing about the first refusal is lost;
 *  - later refusals inside that window are counted, not written, and the count reaches the ledger on
 *    the NEXT row for that pair (`metadata.count`), so one row states how many refusals it stands for;
 *  - the throttle's per-scope budget still applies, so an authenticated viewer enumerating ticket ids
 *    cannot write more than `DENIAL_MAX_ROWS_PER_ROUTE_WINDOW` presence rows a minute on this instance
 *    however many ids they try — and the ones it refuses are carried into the next row's count.
 *
 * The window is keyed on the VIEWER AND THE TICKET, not on the viewer alone: a second forbidden ticket
 * is a different fact, and enumeration is precisely what this row exists to show. `metadata.count` is a
 * FLOOR and says so (`perInstance`), for the same reason the client-API throttle's is: the counters
 * live in one container's memory.
 */
import type { PresenceDTO, RequestContext, Viewer } from "@/types/domain";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { actorFromViewer, deniedEntityType, writeAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
// `PRESENCE_DENIAL_WINDOW_MS` (one full refusal row per viewer+ticket per quarter hour, with the
// reasoning for the length) is DECLARED IN `@/lib/denial-throttle`, not here: a `route.ts` may export
// nothing but its handlers and the route-segment config, and exporting it from this file broke
// `next build` while passing `tsc` and every test. Guardrail G19 now pins that rule.
import { PRESENCE_DENIAL_WINDOW_MS, denialThrottleKey, recordDenialAttempt } from "@/lib/denial-throttle";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { logWarn } from "@/lib/logger";
import { requireViewerOrThrow } from "@/lib/session";
import { ticketPresence } from "@/server/presence";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The capability the refusal is recorded under, and the throttle SCOPE its keys live in. */
const PRESENCE_CAPABILITY = "presence:read";

/** The route label the refusal's metadata carries. A PATTERN, never a concrete path. */
const PRESENCE_ROUTE = "/api/tickets/[id]/presence";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let viewer: Viewer;
  try {
    viewer = await requireViewerOrThrow();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
    }
    throw e;
  }

  const { id } = await ctx.params;
  const rc = getRequestContextFromRequest(req);

  let presence: PresenceDTO;
  try {
    presence = await ticketPresence(viewer, id);
  } catch (e) {
    if (e instanceof ForbiddenError) {
      await recordPresenceDenied(viewer, rc, e.ticketId);
      return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    }
    throw e;
  }

  return Response.json(presence, { status: 200, headers: NO_STORE });
}

/**
 * The coalesced staff denial. Awaited and its errors propagate, like every other denial path (I3/I5):
 * a refusal that cannot be recorded answers 500, never an unaudited 404.
 *
 * `ticketId` comes from the `ForbiddenError` — the ticket's own id, read from the database — and never
 * from the URL segment, so nothing caller-controlled reaches the ledger or the bounded key map.
 */
async function recordPresenceDenied(
  viewer: Viewer,
  rc: RequestContext,
  ticketId: string | null,
): Promise<void> {
  const decision = recordDenialAttempt(
    denialThrottleKey(PRESENCE_CAPABILITY, `${viewer.id}:${ticketId ?? "none"}`),
    new Date(),
    PRESENCE_DENIAL_WINDOW_MS,
  );

  if (!decision.record) {
    // No record content: a capability, a ticket id the ledger already holds, and a count.
    logWarn(`route:${PRESENCE_ROUTE}`, "staff_denial_suppressed", {
      capability: PRESENCE_CAPABILITY,
      ticketId,
      requestId: rc.requestId,
      suppressedSinceLastRecord: decision.suppressedSinceLastRecord,
      windowStartedAt: decision.windowStartedAt.toISOString(),
    });
    return;
  }

  await writeAudit(prisma, actorFromViewer(viewer), rc, {
    action: "AUTHZ_DENIED",
    entityType: deniedEntityType(PRESENCE_CAPABILITY, ticketId),
    entityId: ticketId,
    ticketId,
    fieldChanged: "capability",
    newValue: PRESENCE_CAPABILITY,
    // Counts and a route, no record content. `count` includes this refusal and every one suppressed
    // since the last row for this pair; `perInstance` says it is a floor, not a total.
    metadata: {
      route: PRESENCE_ROUTE,
      coalesced: true,
      count: decision.suppressedSinceLastRecord + 1,
      windowStartedAt: decision.windowStartedAt.toISOString(),
      windowMs: PRESENCE_DENIAL_WINDOW_MS,
      perInstance: true,
    },
  });
}
