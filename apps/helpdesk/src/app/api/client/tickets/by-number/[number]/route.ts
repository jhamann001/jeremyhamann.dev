/**
 * GET /api/client/tickets/by-number/[number] — the WM number a client quotes off an email, resolved
 * for that client only.
 *
 * Why it exists: `HD-1042` is the reference on every outbound reply and the string a client reads
 * back over the phone. Until now the only client-facing lookup took the ticket's cuid, which no
 * client has ever seen, so a client app had to keep its own map from number to id — or fetch the
 * whole list to find one ticket.
 *
 * Auth is the Wave B pair: a `ClientApiToken` carrying `CLIENT_READ`, **or** the legacy
 * `CLIENT_API_TOKEN` bearer, plus an `X-Requester-Email` that must match the ticket's requester.
 * Outside the session middleware, like every `/api/client` path.
 *
 * A number is far easier to enumerate than a cuid, which shapes two decisions here:
 *  - **the requester check is the same check, not a weaker one.** A ticket that is not this
 *    requester's is a 404 with an audited `AUTHZ_DENIED` row, exactly as an unknown number is, so the
 *    caller cannot tell "not yours" from "does not exist";
 *  - **the per-token rate limit applies** (`enforceMachineRateLimit`), so walking `1..N` costs the
 *    caller its whole minute's budget after 120 attempts, and the throttle itself is recorded once.
 *
 * Unauthenticated denials coalesce per route and IP under this route's own label, so
 * a probe here cannot suppress the first denial row on `/api/client/tickets/[id]`.
 *
 * this route answers the SAME `ClientTicketView` as the by-id route, opening entry
 * included, because both go through `toClientTicketView`. `client-view.integration.test.ts` asserts the
 * two payloads are equal rather than merely similar — a client quoting a WM number off an email must
 * not get a different thread from one deep-linking by id.
 */
import { NextResponse } from "next/server";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { enforceMachineRateLimit } from "@/lib/integration-auth";
import {
  CLIENT_TICKET_BY_NUMBER_ROUTE,
  authorizeClientApiRequest,
  getClientTicketByNumber,
  recordClientDeniedOn,
  requesterEmailFromHeaders,
} from "@/server/client-view";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Bounds the path segment before it is parsed: a number is at most this many digits, always. */
const MAX_NUMBER_DIGITS = 12;

function parseTicketNumber(raw: string): number | null {
  if (raw.length === 0 || raw.length > MAX_NUMBER_DIGITS) return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export async function GET(req: Request, ctx: { params: Promise<{ number: string }> }): Promise<Response> {
  const { number } = await ctx.params;
  const rc = getRequestContextFromRequest(req);
  const email = requesterEmailFromHeaders(req.headers);
  const auth = email === null ? null : await authorizeClientApiRequest(req.headers, email);

  if (auth === null || email === null) {
    await recordClientDeniedOn(rc, CLIENT_TICKET_BY_NUMBER_ROUTE, "id:invalid", email, "client:unauthenticated", false);
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const refused = await enforceMachineRateLimit(
    rc,
    CLIENT_TICKET_BY_NUMBER_ROUTE,
    auth.kind === "token" ? { kind: "token", tokenId: auth.tokenId, scopes: ["CLIENT_READ"] } : { kind: "legacy" },
    "client",
  );
  if (refused !== null) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(refused.retryAfterSeconds) } },
    );
  }

  const parsed = parseTicketNumber(number);
  if (parsed === null) {
    // A malformed segment is treated exactly like an unknown ticket: same status, same audited shape,
    // and the caller-controlled string never reaches the ledger.
    await recordClientDeniedOn(
      rc,
      CLIENT_TICKET_BY_NUMBER_ROUTE,
      "id:invalid",
      email,
      "client:requester-mismatch",
      false,
    );
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  const view = await getClientTicketByNumber(parsed, email, rc);
  if (view === null) {
    // The denial row was written inside getClientTicketByNumber.
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  return NextResponse.json(view, { status: 200, headers: NO_STORE });
}
