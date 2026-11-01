/**
 * POST /api/integrations/outbox/[id] — the sender reports what happened.
 *
 * Machine surface: outside the session middleware, behind the constant-time integration bearer.
 * `{ outcome: "SENT" | "FAILED", providerMessageId?, error? }` transitions the delivery and writes
 * `MESSAGE_SENT` or `MESSAGE_FAILED` in the same transaction. A FAILED report below
 * `MESSAGE_MAX_ATTEMPTS` returns the row to QUEUED for the next poll; at the cap it stays FAILED and
 * shows as Failed on the comment chip.
 *
 * Replaying a terminal outcome is idempotent (200, no second ledger row); contradicting one is a 409.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAppError } from "@/lib/errors";
import { logError } from "@/lib/logger";
import { getRequestContextFromRequest } from "@/lib/request-context";
import {
  authorizeMachineRequest,
  enforceMachineRateLimit,
  integrationActor,
  machineAuthTokenId,
  recordIntegrationDenied,
} from "@/lib/integration-auth";
import type { IntegrationScope } from "@/lib/integration-scope";
import { readJsonBody } from "@/server/ingest";
import { reportDeliveryOutcome } from "@/server/outbox";

export const dynamic = "force-dynamic";

const ROUTE = "/api/integrations/outbox/[id]";
/**
 * This route is the outbound-mail surface. With `OUTBOX_API_TOKEN` set it accepts ONLY that key;
 * unset, it falls back to the shared `INTEGRATION_API_TOKEN` (src/lib/integration-scope.ts).
 */
const SCOPE: IntegrationScope = "outbox";
const NO_STORE = { "Cache-Control": "no-store" } as const;

const deliveryIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid delivery id");

const outcomeSchema = z.object({
  outcome: z.enum(["SENT", "FAILED"]),
  /** The provider's own id, for reconciliation against the mail archive. */
  providerMessageId: z.string().trim().min(1).max(200).optional(),
  /** A reason, never a full provider payload. Sanitized and truncated before it is stored. */
  error: z.string().trim().min(1).max(4000).optional(),
});

function fieldErrorsOf(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const rc = getRequestContextFromRequest(req);

  // A `ClientApiToken` carrying this surface's scope, else the legacy env bearer, in that
  // order. Database-first is deliberate: a consumer that has been issued a
  // real credential should be attributed to it even while INTEGRATION_API_TOKEN is still set.
  const machineAuth = await authorizeMachineRequest(req.headers, SCOPE);
  if (machineAuth === null) {
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

  const { id } = await ctx.params;
  const parsedId = deliveryIdSchema.safeParse(id);
  if (!parsedId.success) {
    // A malformed id is never looked up: it would put an attacker-shaped string in front of the DB.
    await recordIntegrationDenied(rc, ROUTE, "integration:invalid-delivery-id", { auth: machineAuth });
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }

  // `readJsonBody` enforces the 1 MiB cap ON THE STREAM: `await req.json()` would materialise the
  // whole body first, and a declared `content-length` — absent on a chunked request, attacker-
  // controlled when present — can only ever be the early refusal, never the enforcement.
  const body = await readJsonBody(req);
  if (!body.ok) {
    const error = body.reason === "oversize" ? "payload_too_large" : "malformed_json";
    return NextResponse.json({ error }, { status: 400, headers: NO_STORE });
  }

  const parsed = outcomeSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", fieldErrors: fieldErrorsOf(parsed.error) },
      { status: 422, headers: NO_STORE },
    );
  }

  const actor = await integrationActor();
  try {
    const result = await reportDeliveryOutcome(actor, rc, {
      deliveryId: parsedId.data,
      outcome: parsed.data.outcome,
      // WHICH sender reported this outcome, on the MESSAGE_SENT / MESSAGE_FAILED row.
      tokenId: machineAuthTokenId(machineAuth),
      ...(parsed.data.providerMessageId === undefined ? {} : { providerMessageId: parsed.data.providerMessageId }),
      ...(parsed.data.error === undefined ? {} : { error: parsed.data.error }),
    });
    return NextResponse.json(
      { id: parsedId.data, status: result.status, attempts: result.attempts },
      { status: 200, headers: NO_STORE },
    );
  } catch (e) {
    if (isAppError(e)) {
      // The message of an AppError is ours (never an unknown error's), so it is safe to return.
      return NextResponse.json({ error: e.code.toLowerCase(), message: e.message }, { status: e.status, headers: NO_STORE });
    }
    // CWE-209: hand the caught value to the logger, which records only `errorLabel(e)`. The old
    // `e instanceof Error ? e.name` ternary was itself the tainted read of the caught error.
    logError(`route:${ROUTE}`, e);
    return NextResponse.json({ error: "internal" }, { status: 500, headers: NO_STORE });
  }
}
