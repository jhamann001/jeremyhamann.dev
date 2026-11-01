/**
 * POST /api/ingest/email — the inbound mail channel (§10 "S2").
 *
 * An n8n Gmail workflow parses one message per mailbox and POSTs it here. Outside the session
 * middleware (`src/middleware.ts` excludes `/api/ingest`) because the caller is a server; the whole
 * authentication story is the `INTEGRATION_API_TOKEN` bearer, compared in constant time, and an
 * unset key answers 401 to everyone.
 *
 * Order is the control: bearer (401, audited) → body under the 1 MiB cap (400) → zod (422 with
 * `fieldErrors`) → `ingestInboundEmail`, which decides whether the message becomes a ticket, a
 * requester message or a `SuspendedIntake` row and writes it with its audit rows in one transaction.
 *
 * **202, not 201.** The workflow is handing over a message, not asking for a record to be created:
 * whether it becomes one is this desk's decision, and a held message is a successful hand-over. A
 * 4xx here would drop client mail into an n8n execution log nobody reviews, so the only failures are
 * a bad bearer, a body that is not a message, and infrastructure.
 *
 * Nothing on this path transmits anything.
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
import { badBodyResponse, readJsonBody, toMachineErrorResponse } from "@/server/ingest";
import { ingestInboundEmail, inboundEmailSchema } from "@/server/email-intake";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const ROUTE = "/api/ingest/email";
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
    // I5: the denial is evidence. A failed audit insert fails the request rather than answering with
    // an unrecorded 401.
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
    const input = inboundEmailSchema.parse(body.value);
    // `tokenId` is WHICH consumer handed this message over, on every row the intake writes —
    // including the `INTAKE_SUSPENDED` row a held message gets. The ACTOR stays `svc_integration`.
    const result = await ingestInboundEmail(input, {
      actor,
      ctx,
      via: AUDIT_VIA.email,
      tokenId: machineAuthTokenId(machineAuth),
    });

    // The response never carries subject or body text: ids, the outcome and the reason only.
    return NextResponse.json(result, { status: 202, headers: NO_STORE });
  } catch (e) {
    const mapped = toMachineErrorResponse("ingest.email", e);
    if (mapped.status === 404) {
      await recordIntegrationDenied(ctx, ROUTE, "integration:not-found", { auth: machineAuth });
    }
    return NextResponse.json(mapped.body, { status: mapped.status, headers: NO_STORE });
  }
}
