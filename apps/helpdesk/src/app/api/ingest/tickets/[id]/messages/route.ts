/**
 * POST /api/ingest/tickets/[id]/messages — a machine-authored message on an existing ticket
 *.
 *
 * The body's `authorKind` decides which core runs, and the two cores are genuinely different things:
 *
 *  - **REQUESTER** — the client's own words. PUBLIC, `authorId` null, no disclaimer, and it NEVER
 *    stamps `firstRespondedAt`. `PENDING_CLIENT → OPEN`; `RESOLVED → OPEN` with a
 *    `TICKET_REOPENED_BY_REQUESTER` row; a reply to a CLOSED ticket opens a NEW linked ticket rather
 *    than reopening the closed record, and that follow-up is answered with 201.
 *  - **STAFF** — an agent replying through an integration. `authorEmail` must resolve to an ACTIVE
 *    user. INTERNAL by default and allowed on a CLOSED ticket; PUBLIC needs a disclaimer,
 *    refuses on CLOSED, stamps the first response and enqueues its outbound delivery.
 *
 * The ticket id comes from the PATH, never the body: a body that disagrees with the path would make
 * "which ticket did this land on" a question about parsing order.
 */
import { NextResponse } from "next/server";
import { AUDIT_VIA } from "@/lib/audit";
import {
  authorizeMachineRequest,
  enforceMachineRateLimit,
  integrationActor,
  machineAuthTokenId,
  recordIntegrationDenied,
} from "@/lib/integration-auth";
import type { IntegrationScope } from "@/lib/integration-scope";
import { getRequestContextFromRequest } from "@/lib/request-context";
import {
  addRequesterMessageOrFollowUp,
  addStaffMessageCore,
  badBodyResponse,
  ingestMessageSchema,
  readJsonBody,
  toMachineErrorResponse,
} from "@/server/ingest";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const ROUTE = "/api/ingest/tickets/[id]/messages";
/**
 * This route is the machine WRITE surface. With `INGEST_API_TOKEN` set it accepts ONLY that key;
 * unset, it falls back to the shared `INTEGRATION_API_TOKEN` (src/lib/integration-scope.ts).
 */
const SCOPE: IntegrationScope = "ingest";

export async function POST(req: Request, routeCtx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await routeCtx.params;
  const ctx = getRequestContextFromRequest(req);

  // A `ClientApiToken` carrying this surface's scope, else the legacy env bearer, in that
  // order. Database-first is deliberate: a consumer that has been issued a
  // real credential should be attributed to it even while INTEGRATION_API_TOKEN is still set.
  const machineAuth = await authorizeMachineRequest(req.headers, SCOPE);
  if (machineAuth === null) {
    await recordIntegrationDenied(ctx, ROUTE, "integration:unauthenticated");
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  // Per credential (per surface for the legacy bearer). The refusal is audited at most once per
  // key per window — Decision #71's coalescing, arriving through a different door.
  const refused = await enforceMachineRateLimit(ctx, ROUTE, machineAuth, SCOPE);
  if (refused !== null) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(refused.retryAfterSeconds) } },
    );
  }

  const body = await readJsonBody(req);
  if (!body.ok) {
    const bad = badBodyResponse(body.reason);
    return NextResponse.json(bad.body, { status: bad.status, headers: NO_STORE });
  }

  try {
    const actor = await integrationActor();
    // The path id wins: it is what the caller addressed, and the body is only allowed to agree with it.
    const raw = typeof body.value === "object" && body.value !== null ? { ...(body.value as object) } : body.value;
    const input = ingestMessageSchema.parse({ ...(raw as Record<string, unknown>), ticketId: id });
    // `tokenId` is WHICH consumer authored this message, on every row the cores write. The ACTOR
    // stays the seeded `svc_integration` identity — see the call context's docstring.
    const call = { actor, ctx, via: AUDIT_VIA.api, tokenId: machineAuthTokenId(machineAuth) } as const;

    if (input.authorKind === "REQUESTER") {
      const outcome = await addRequesterMessageOrFollowUp(input, call);
      return NextResponse.json(
        {
          ticketId: outcome.result.ticketId,
          number: outcome.result.ticketNumber,
          reference: `HD-${outcome.result.ticketNumber}`,
          commentId: outcome.result.commentId,
          created: outcome.result.created,
          reopened: outcome.result.reopened,
          linkedFromTicketId: outcome.linkedFromTicketId,
          piiRedacted: outcome.result.piiRedacted,
          piiRedactionCount: outcome.result.piiRedactionCount,
        },
        { status: outcome.result.created ? 201 : 200, headers: NO_STORE },
      );
    }

    const result = await addStaffMessageCore(input, call);
    return NextResponse.json(
      {
        ticketId: result.ticketId,
        number: result.ticketNumber,
        reference: `HD-${result.ticketNumber}`,
        commentId: result.commentId,
        created: result.created,
        reopened: false,
        linkedFromTicketId: null,
        piiRedacted: result.piiRedacted,
        piiRedactionCount: result.piiRedactionCount,
      },
      { status: result.created ? 201 : 200, headers: NO_STORE },
    );
  } catch (e) {
    const mapped = toMachineErrorResponse("ingest.messages", e);
    // §3 rule 4: an unknown ticket reached by a valid bearer is a machine-caller denial and gets its
    // own row. A validation failure is not a denial — it is a malformed request, not a refused one.
    if (mapped.status === 404) {
      await recordIntegrationDenied(ctx, ROUTE, "integration:ticket-not-found", {
        ticketId: id,
        ticketExists: false,
        auth: machineAuth,
      });
    }
    return NextResponse.json(mapped.body, { status: mapped.status, headers: NO_STORE });
  }
}
