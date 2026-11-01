/**
 * GET /api/client/tickets/[id] — the ONLY client-facing surface.
 *
 * Outside the session middleware. Auth is a `ClientApiToken` carrying CLIENT_READ, else the legacy
 * server-to-server bearer (CLIENT_API_TOKEN) — `authorizeClientApiRequest`, the same pair the list and
 * by-number routes use (it was legacy-only) — plus an X-Requester-Email that must match
 * the ticket's requester. A per-client credential is therefore honoured here too, and its budget is
 * spent here too, so the per-consumer ceiling cannot be walked around by reading tickets one id at a
 * time. Imports are limited to @/server/client-view, @/lib/request-context and next/server (guardrail
 * G7), which is why the rate limiter is reached through `enforceClientApiRateLimit` rather than
 * @/lib/integration-auth directly. Every 401 and 404 writes an AUTHZ_DENIED row before responding; a
 * failed denial insert surfaces as a 500 rather than an unaudited answer.
 *
 * on a ticket the client raised by email or in the app, `messages[0]` of the answer is
 * the request THEY sent — synthesised at read time from `Ticket.description` inside
 * `getClientTicketView`, never a field of the payload. This file is unchanged by that: the whole rule,
 * including the source gate that keeps an operator's account of a call off this surface, lives in
 * `@/server/client-view`, which is what G7's three-module import pin is for.
 */
import { NextResponse } from "next/server";
import { getRequestContextFromRequest } from "@/lib/request-context";
import {
  CLIENT_TICKET_READ_ROUTE,
  authorizeClientApiRequest,
  enforceClientApiRateLimit,
  getClientTicketView,
  recordClientDenied,
  requesterEmailFromHeaders,
} from "@/server/client-view";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const rc = getRequestContextFromRequest(req);
  const email = requesterEmailFromHeaders(req.headers);

  const auth = email === null ? null : await authorizeClientApiRequest(req.headers, email);

  if (auth === null || email === null) {
    await recordClientDenied(rc, id, email, "client:unauthenticated", false);
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const refused = await enforceClientApiRateLimit(rc, CLIENT_TICKET_READ_ROUTE, auth, "CLIENT_READ");
  if (refused !== null) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(refused.retryAfterSeconds) } },
    );
  }

  const view = await getClientTicketView(id, email, rc);
  if (view === null) {
    // The requester-mismatch / missing-ticket denial row was written inside getClientTicketView.
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json(view, { status: 200, headers: NO_STORE });
}
