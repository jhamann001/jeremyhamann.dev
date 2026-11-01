/**
 * POST /api/client/tickets/[id]/messages — a client replying from the Cedar Ridge app
 *.
 *
 * Bearer + `X-Requester-Email`, exactly as the GET on the same ticket. The header must equal the
 * ticket's `requesterEmail`; anything else answers 404 with an audited `AUTHZ_DENIED` row, so the
 * route leaks nothing about whether the id exists — the same rule the read path already follows.
 *
 * The bearer is a `ClientApiToken` carrying `CLIENT_WRITE`, **or** the legacy `CLIENT_API_TOKEN`
 *. This is the second of the two surfaces the admin sheet's CLIENT_WRITE help text
 * names — "Open tickets and post client messages through /api/client" — and until it asked for the
 * scope, that sentence described a narrowing no write ever applied. A token's id is threaded onto
 * every row this call writes, so a per-consumer credential is attributable from the day it is issued.
 *
 * Two denial classes, two treatments, and the difference is the whole point of Decision #71:
 *  - **Unauthenticated** (no bearer, no usable header): reachable by anything on the internet, so it
 *    COALESCES into one summarised row per IP per minute.
 *  - **Authenticated but wrong requester**: a caller holding the app's bearer asking for someone
 *    else's ticket. That is one row each, every time, forever — it is the enumeration attempt
 *    compliance actually wants to see.
 *
 * The message is written through `addRequesterMessageOrFollowUp`: PUBLIC, `authorKind` REQUESTER,
 * `authorId` null, no disclaimer, no `firstRespondedAt` stamp; `PENDING_CLIENT → OPEN`; a reply on a
 * CLOSED ticket opens a NEW linked ticket instead of reopening the closed record.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { IngestMessageInput } from "@/types/domain";
import { AUDIT_VIA, clientApiActor } from "@/lib/audit";
import { recordUnauthenticatedClientDenial } from "@/lib/denial-throttle";
import { enforceMachineRateLimit } from "@/lib/integration-auth";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { safeEqualEmails } from "@/lib/safe-equal";
import {
  addRequesterMessageOrFollowUp,
  badBodyResponse,
  loadTicketForIngest,
  readJsonBody,
  toMachineErrorResponse,
} from "@/server/ingest";
import { authorizeClientApiRequest, recordClientDenied, requesterEmailFromHeaders } from "@/server/client-view";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const ROUTE = "/api/client/tickets/[id]/messages";

const clientMessageSchema = z.object({
  externalId: z.string().trim().min(1).max(512),
  body: z.string().min(1).max(400_000),
});

export async function POST(req: Request, routeCtx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await routeCtx.params;
  const ctx = getRequestContextFromRequest(req);
  const email = requesterEmailFromHeaders(req.headers);

  const auth = email === null ? null : await authorizeClientApiRequest(req.headers, email, "CLIENT_WRITE");

  if (auth === null || email === null) {
    await recordUnauthenticatedClientDenial(ctx, ROUTE);
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const refused = await enforceMachineRateLimit(
    ctx,
    ROUTE,
    auth.kind === "token" ? { kind: "token", tokenId: auth.tokenId, scopes: ["CLIENT_WRITE"] } : { kind: "legacy" },
    "client",
  );
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
    const parsed = clientMessageSchema.parse(body.value);

    // Requester equality, decided here rather than inside the core: the cores are viewer-agnostic and
    // it is this surface's bearer contract that says who may write to which ticket.
    let ticket;
    try {
      ticket = await loadTicketForIngest(id);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      // Authenticated denial: one row each, never coalesced. `ticketExists: false` keeps the FK clean.
      await recordClientDenied(ctx, id, email, "client:requester-mismatch", false);
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    }
    // a null requesterEmail NEVER matches a header, so a phone-only ticket is simply
    // unreachable here and the attempt is audited like any other mismatch. Fail closed, no special case.
    // CWE-208: this equality decides whether a bearer-holding caller may
    // write to somebody else's ticket, so it is an identity check on a request-derived value.
    // `safeEqualEmails` is constant time and applies the SAME normalisation (trim + toLowerCase) to
    // both sides — the same normalisation `requesterEmailFromHeaders` already applied to `email`, so
    // the comparison's answer is unchanged for every input.
    if (ticket.requesterEmail === null || !safeEqualEmails(ticket.requesterEmail, email)) {
      await recordClientDenied(ctx, id, email, "client:requester-mismatch", true);
      return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    }

    const input: IngestMessageInput = {
      ticketId: ticket.id,
      source: "CLIENT_APP",
      externalId: parsed.externalId,
      authorKind: "REQUESTER",
      body: parsed.body,
    };
    const outcome = await addRequesterMessageOrFollowUp(input, {
      actor: clientApiActor(email),
      ctx,
      via: AUDIT_VIA.clientApp,
      // Absent — never null — for the legacy env bearer (`withVia`), which is what marks a consumer
      // still on the shared credential.
      tokenId: auth.kind === "token" ? auth.tokenId : null,
    });

    return NextResponse.json(
      {
        // The ticket the message landed on — which is a NEW one when the original was CLOSED.
        id: outcome.result.ticketId,
        reference: `HD-${outcome.result.ticketNumber}`,
        created: outcome.result.created,
        reopened: outcome.result.reopened,
        followUpOf: outcome.linkedFromTicketId === null ? null : `HD-${ticket.number}`,
      },
      { status: outcome.result.created ? 201 : 200, headers: NO_STORE },
    );
  } catch (e) {
    const mapped = toMachineErrorResponse("client.tickets.messages", e);
    return NextResponse.json(mapped.body, { status: mapped.status, headers: NO_STORE });
  }
}
