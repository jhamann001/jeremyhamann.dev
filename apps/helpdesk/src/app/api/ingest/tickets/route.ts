/**
 * POST /api/ingest/tickets — the authenticated machine write path for a NEW ticket
 *.
 *
 * Outside the session middleware (`src/middleware.ts` excludes `/api/ingest`), because the caller is
 * a server — an n8n workflow, a telephony webhook, an internal service — and a redirect to /sign-in is
 * something no machine can follow. The whole authentication story is the `INTEGRATION_API_TOKEN`
 * bearer, compared in constant time; when that key is unset the route answers 401 to everyone.
 *
 * Order is the control: bearer (401, audited) → body under the 1 MiB cap (400) → zod (422 with
 * fieldErrors) → the Decision #117 source refusal (422) → `createTicketCore`, which writes the Ticket,
 * its `IngestReceipt` and its
 * `TICKET_INGESTED` row in ONE transaction. A retry with the same `(source, externalId)` returns the
 * same ticket id with 200 and creates nothing.
 */
import { NextResponse } from "next/server";
import { getRequestContextFromRequest } from "@/lib/request-context";
import {
  authorizeMachineRequest,
  enforceMachineRateLimit,
  integrationActor,
  machineAuthTokenId,
  recordIntegrationDenied,
} from "@/lib/integration-auth";
import type { IntegrationScope } from "@/lib/integration-scope";
import { AUDIT_VIA } from "@/lib/audit";
import {
  assertMachineDeclaredSourceAllowed,
  badBodyResponse,
  createTicketCore,
  ingestTicketSchema,
  readJsonBody,
  toMachineErrorResponse,
} from "@/server/ingest";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const ROUTE = "/api/ingest/tickets";
/**
 * This route is the machine WRITE surface. With `INGEST_API_TOKEN` set it accepts ONLY that key;
 * unset, it falls back to the shared `INTEGRATION_API_TOKEN` (src/lib/integration-scope.ts).
 */
const SCOPE: IntegrationScope = "ingest";

export async function POST(req: Request): Promise<Response> {
  const ctx = getRequestContextFromRequest(req);

  // A `ClientApiToken` carrying this surface's scope, else the legacy env bearer, in that
  // order. Database-first is deliberate: a consumer that has been issued a
  // real credential should be attributed to it even while INTEGRATION_API_TOKEN is still set.
  const machineAuth = await authorizeMachineRequest(req.headers, SCOPE);
  if (machineAuth === null) {
    // I5: the denial is evidence. If the row cannot be written the request fails (500) rather than
    // answering with an unrecorded 401.
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
    const input = ingestTicketSchema.parse(body.value);
    // Decision #117. `source` is now a CLIENT-VISIBILITY control, not just routing metadata: a ticket
    // whose source is requester-authored has its `description` rendered back to the named requester as
    // their own opening message. This surface takes `source` from the body on one shared credential,
    // so it may not declare one. Inbound mail and the client app have their own authenticated paths.
    assertMachineDeclaredSourceAllowed(input.source);
    // `tokenId` is WHICH consumer wrote this ticket, on every row the core writes. The ACTOR stays
    // the seeded `svc_integration` identity: the credential's creator was not present for this call.
    const result = await createTicketCore(input, {
      actor,
      ctx,
      via: AUDIT_VIA.api,
      tokenId: machineAuthTokenId(machineAuth),
    });
    return NextResponse.json(
      {
        id: result.ticketId,
        number: result.ticketNumber,
        reference: `HD-${result.ticketNumber}`,
        created: result.created,
        piiRedacted: result.piiRedacted,
        piiRedactionCount: result.piiRedactionCount,
      },
      // 201 for a real creation, 200 for an idempotent replay — the caller can tell them apart
      // without parsing the body, which is what makes a retry loop safe.
      { status: result.created ? 201 : 200, headers: NO_STORE },
    );
  } catch (e) {
    const mapped = toMachineErrorResponse("ingest.tickets", e);
    if (mapped.status === 404) {
      await recordIntegrationDenied(ctx, ROUTE, "integration:not-found", { auth: machineAuth });
    }
    return NextResponse.json(mapped.body, { status: mapped.status, headers: NO_STORE });
  }
}
