/**
 * GET /api/integrations/outbox — the sender's work queue.
 *
 * Machine surface: outside the session middleware (the matcher excludes `/api/integrations`), behind
 * the constant-time integration bearer. One call leases up to `limit` QUEUED deliveries, marks each
 * LEASED with an expiry so two pollers cannot double-send the same message, and writes one
 * `MESSAGE_LEASED` row per delivery in the same transaction as the lease.
 *
 * With no token configured for the `outbox` scope — `OUTBOX_API_TOKEN`, falling back to
 * `INTEGRATION_API_TOKEN` — this route answers 401 to everyone: the fail-closed default that makes
 * "built, not sending" true by construction.
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
import {
  OUTBOX_DEFAULT_LIMIT,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_LIMIT,
  clampOutboxLimit,
  leaseQueuedDeliveries,
} from "@/server/outbox";

export const dynamic = "force-dynamic";

const ROUTE = "/api/integrations/outbox";
/**
 * This route is the outbound-mail surface. With `OUTBOX_API_TOKEN` set it accepts ONLY that key;
 * unset, it falls back to the shared `INTEGRATION_API_TOKEN` (src/lib/integration-scope.ts).
 */
const SCOPE: IntegrationScope = "outbox";
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: Request): Promise<Response> {
  const rc = getRequestContextFromRequest(req);

  // A `ClientApiToken` carrying this surface's scope, else the legacy env bearer, in that
  // order. Database-first is deliberate: a consumer that has been issued a
  // real credential should be attributed to it even while INTEGRATION_API_TOKEN is still set.
  const machineAuth = await authorizeMachineRequest(req.headers, SCOPE);
  if (machineAuth === null) {
    // Machine denials are never coalesced (§3 rule 4): one row each, awaited before the answer.
    await recordIntegrationDenied(rc, ROUTE, "integration:unauthenticated");
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  // Per credential (per surface for the legacy bearer). The refusal is audited at most once per
  // key per window — Decision #71's coalescing, arriving through a different door.
  const refused = await enforceMachineRateLimit(rc, ROUTE, machineAuth, SCOPE);
  if (refused !== null) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(refused.retryAfterSeconds) } },
    );
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (status !== null && status !== "QUEUED") {
    return NextResponse.json(
      { error: "validation", fieldErrors: { status: ["Only status=QUEUED can be leased"] } },
      { status: 422, headers: NO_STORE },
    );
  }

  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null && !/^\d{1,4}$/.test(rawLimit)) {
    return NextResponse.json(
      { error: "validation", fieldErrors: { limit: [`limit must be an integer 1..${OUTBOX_MAX_LIMIT}`] } },
      { status: 422, headers: NO_STORE },
    );
  }
  const limit = clampOutboxLimit(rawLimit === null ? OUTBOX_DEFAULT_LIMIT : Number(rawLimit));

  const actor = await integrationActor();
  // WHICH poller took this work, on every `MESSAGE_LEASED` row. The ACTOR stays the seeded
  // `svc_integration` identity: the credential's creator was not present for this sweep.
  const deliveries = await leaseQueuedDeliveries(actor, rc, limit, machineAuthTokenId(machineAuth));

  return NextResponse.json(
    { deliveries, count: deliveries.length, leaseMs: OUTBOX_LEASE_MS },
    { status: 200, headers: NO_STORE },
  );
}
