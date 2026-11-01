/**
 * `/api/client/tickets` — the client app's collection endpoint.
 *
 * **GET** lists the tickets belonging to the
 * address in `X-Requester-Email`, newest activity first, paginated. It is the surface a client app's
 * "My requests" screen reads, and it is what stops that screen having to remember a cuid per ticket.
 *
 * **POST** is unchanged and is documented below.
 *
 * Same contract as the existing client GET: a `ClientApiToken` carrying the scope this surface needs —
 * `CLIENT_WRITE` for the POST, `CLIENT_READ` for the GET — **or** the legacy `CLIENT_API_TOKEN` bearer
 * (the app's BACKEND holds it, never the phone), plus an `X-Requester-Email` header naming the
 * signed-in client. Outside the session middleware, like every `/api/client` path.
 *
 * The POST asks for `CLIENT_WRITE` rather than accepting the shared env bearer alone.
 * Until it did, `CLIENT_WRITE` was a grant no route ever verified: the per-consumer credential
 * migration B8 exists to perform could never complete on the one client-facing write surface, the
 * `metadata ? 'tokenId'` progress predicate would have read "still on the shared bearer" forever, and
 * the admin sheet promised a per-client narrowing that writes never saw. A `CLIENT_READ` token cannot
 * post; a `CLIENT_WRITE` token cannot list; the legacy bearer still answers for both.
 *
 * Three things this route refuses to take from the caller, each deliberate:
 *  - **the requester's email** — it comes from the header the app's backend sets after authenticating
 *    its user, never from the body. A body-supplied address would let anyone open a ticket as anyone.
 *  - **priority and queue** — routing is the desk's decision (`ROUTING_TABLE`), not the client's.
 *    Otherwise every message arrives URGENT.
 *  - **`source`** — always `CLIENT_APP`. The channel is a fact about how the row arrived.
 *
 * Unauthenticated denials are COALESCED: this path is reachable from the internet, and
 * one append-only ledger row per probe would let a scanner grow the compliance record at will. The
 * first denial per IP per minute writes one `AUTHZ_DENIED_COALESCED` row carrying the suppressed
 * count; the rest go to the structured log.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { TICKET_CATEGORIES } from "@/types/domain";
import type { IngestTicketInput } from "@/types/domain";
import { AUDIT_VIA, clientApiActor } from "@/lib/audit";
import { recordUnauthenticatedClientDenial } from "@/lib/denial-throttle";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { enforceMachineRateLimit } from "@/lib/integration-auth";
import type { MachineAuthorization } from "@/lib/integration-auth";
import { badBodyResponse, createTicketCore, readJsonBody, toMachineErrorResponse } from "@/server/ingest";
import type { ClientApiAuthorization } from "@/server/client-view";
import {
  CLIENT_TICKET_LIST_ROUTE,
  authorizeClientApiRequest,
  clientListBounds,
  countClientTickets,
  listClientTickets,
  recordClientDeniedOn,
  requesterEmailFromHeaders,
} from "@/server/client-view";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const ROUTE = "/api/client/tickets";

/**
 * What the client app may send. `externalId` is the app's own request id and is what makes a retry on
 * a flaky mobile connection safe: the same id returns the same ticket, 200, and creates nothing.
 */
const clientCreateSchema = z.object({
  externalId: z.string().trim().min(1).max(512),
  subject: z.string().trim().min(1).max(2_000),
  body: z.string().min(1).max(400_000),
  category: z.enum(TICKET_CATEGORIES).optional(),
  requesterName: z.string().trim().min(1).max(120),
});

/**
 * The rate-limit budget a client-API authorization spends from: per credential for a `ClientApiToken`,
 * per surface for the legacy env bearer. `scopes` names the scope the surface just demanded, which is
 * what puts "which surface did this credential spend its budget on" on the throttle's audit row.
 */
function machineAuthFor(auth: ClientApiAuthorization, scope: "CLIENT_READ" | "CLIENT_WRITE"): MachineAuthorization {
  return auth.kind === "token" ? { kind: "token", tokenId: auth.tokenId, scopes: [scope] } : { kind: "legacy" };
}

export async function POST(req: Request): Promise<Response> {
  const ctx = getRequestContextFromRequest(req);
  const email = requesterEmailFromHeaders(req.headers);
  const auth = email === null ? null : await authorizeClientApiRequest(req.headers, email, "CLIENT_WRITE");

  if (auth === null || email === null) {
    await recordUnauthenticatedClientDenial(ctx, ROUTE);
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const refused = await enforceMachineRateLimit(ctx, ROUTE, machineAuthFor(auth, "CLIENT_WRITE"), "client");
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
    const parsed = clientCreateSchema.parse(body.value);
    const input: IngestTicketInput = {
      source: "CLIENT_APP",
      externalId: parsed.externalId,
      subject: parsed.subject,
      description: parsed.body,
      category: parsed.category,
      requesterName: parsed.requesterName,
      // The header, not the body. This is the whole identity story on this surface.
      requesterEmail: email,
    };
    // The audit actor is the CLIENT (`client:<email>`, actorId null), matching the CLIENT_API_READ
    // rows the same caller already writes; `via: "client-app"` says which channel. The Ticket's
    // `createdById` falls back to the integration machine user, because a requester is not a User.
    const result = await createTicketCore(input, {
      actor: clientApiActor(email),
      ctx,
      via: AUDIT_VIA.clientApp,
      // Absent — never null — for the legacy env bearer, so `metadata ? 'tokenId'` keeps partitioning
      // the ledger into attributed and shared-bearer client writes.
      tokenId: auth.kind === "token" ? auth.tokenId : null,
    });

    return NextResponse.json(
      {
        id: result.ticketId,
        reference: `HD-${result.ticketNumber}`,
        created: result.created,
      },
      { status: result.created ? 201 : 200, headers: NO_STORE },
    );
  } catch (e) {
    const mapped = toMachineErrorResponse("client.tickets.create", e);
    return NextResponse.json(mapped.body, { status: mapped.status, headers: NO_STORE });
  }
}

/**
 * The client's own tickets, as full `ClientTicketView`s.
 *
 * Auth is the Wave B pair — a `ClientApiToken` carrying `CLIENT_READ`, or the legacy
 * `CLIENT_API_TOKEN` bearer — plus the `X-Requester-Email` header the app's backend sets after
 * authenticating its own user. The header is the whole identity story here, exactly as it is on POST:
 * an address in a body or a query string would let anyone read anyone.
 *
 * `page` and `pageSize` are clamped rather than validated (`clientListBounds`): `?pageSize=1000000`
 * answers a page of 25, not a 400. A paging parameter is not a security boundary and a client app
 * retrying a bad page is worse than one silently getting fewer rows — the cap is what bounds the work,
 * and it is small because every row on the page writes its own `CLIENT_API_READ` ledger row.
 *
 * Each ticket in the page is a read of client material, so `listClientTickets` awaits those rows
 * BEFORE the body is produced. `total` is a count over the same address and carries no content.
 */
export async function GET(req: Request): Promise<Response> {
  const rc = getRequestContextFromRequest(req);
  const email = requesterEmailFromHeaders(req.headers);
  const auth = email === null ? null : await authorizeClientApiRequest(req.headers, email);

  if (auth === null || email === null) {
    await recordClientDeniedOn(rc, CLIENT_TICKET_LIST_ROUTE, "id:invalid", email, "client:unauthenticated", false);
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const refused = await enforceMachineRateLimit(rc, CLIENT_TICKET_LIST_ROUTE, machineAuthFor(auth, "CLIENT_READ"), "client");
  if (refused !== null) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(refused.retryAfterSeconds) } },
    );
  }

  const url = new URL(req.url);
  const bounds = clientListBounds({
    page: Number(url.searchParams.get("page") ?? "") || undefined,
    pageSize: Number(url.searchParams.get("pageSize") ?? "") || undefined,
  });

  try {
    const [tickets, total] = await Promise.all([
      listClientTickets(email, rc, bounds),
      countClientTickets(email),
    ]);
    return NextResponse.json(
      {
        tickets,
        page: bounds.page,
        pageSize: bounds.pageSize,
        total,
        hasMore: bounds.page * bounds.pageSize < total,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (e) {
    const mapped = toMachineErrorResponse("client.tickets.list", e);
    return NextResponse.json(mapped.body, { status: mapped.status, headers: NO_STORE });
  }
}
