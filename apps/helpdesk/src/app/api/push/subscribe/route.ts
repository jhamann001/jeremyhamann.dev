/**
 * POST / DELETE `/api/push/subscribe` — the browser's own registration surface
 *.
 *
 * SESSION auth (`requireViewerOrThrow`). It sits INSIDE the middleware matcher like every other
 * staff surface, so an expired session is redirected before it ever reaches this file;
 * the check here is the one that matters for a `fetch` from the service worker, where a 307 to
 * `/sign-in` is meaningless and a 401 is the only useful answer.
 *
 * WHY A ROUTE AND NOT JUST THE ACTION. `pushsubscriptionchange` fires in the SERVICE WORKER, with no
 * page and therefore no React server-action endpoint to call. The worker needs a plain HTTP surface.
 * The route is a thin adapter over the two actions and holds no logic of its own: one place
 * validates, one place writes the audit rows, and the worker and the UI cannot drift apart.
 *
 * **404 when push is unconfigured**, before authentication is even considered, exactly as CONTRACT §4
 * says: with the three `VAPID_*` keys unset — every environment on this branch — the feature does not
 * exist, and a deployment that cannot send must not collect subscriptions it will never use.
 *
 * Nothing here transmits anything.
 */
import type { ActionResult, Viewer } from "@/types/domain";
import { env, isWebPushEnabled } from "@/lib/env";
import { UnauthorizedError } from "@/lib/errors";
import { readBodyWithCap } from "@/lib/http-body";
import { requireViewerOrThrow } from "@/lib/session";
import { subscribePush, unsubscribePush } from "@/server/push.actions";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** A subscription is an endpoint and two short keys. 8 KiB is generous and bounds the read. */
const BODY_CAP_BYTES = 8 * 1024;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** The feature gate and the session gate, in that order. `null` means a response was produced. */
async function authorize(): Promise<Viewer | Response> {
  if (!isWebPushEnabled(env)) return json({ error: "not_found" }, 404);
  try {
    return await requireViewerOrThrow();
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: "unauthenticated" }, 401);
    throw e;
  }
}

/** Reads a bounded JSON object, or `null` for anything that is not one. */
async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const bytes = await readBodyWithCap(req.body, BODY_CAP_BYTES);
  if (bytes === null || bytes.byteLength === 0) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Maps an `ActionResult` to HTTP.
 *
 * The action's own message is returned for a validation failure, because it describes the SHAPE of a
 * push subscription and nothing about a person or a ticket. `NOT_FOUND` becomes 404 with no body:
 * whose device an endpoint belongs to is not something a holder of the URL may probe.
 */
function fromActionResult<T>(result: ActionResult<T>): Response {
  if (result.ok) return json(result.data, 200);
  switch (result.code) {
    case "UNAUTHORIZED":
      return json({ error: "unauthenticated" }, 401);
    case "FORBIDDEN":
      return json({ error: "forbidden" }, 403);
    case "NOT_FOUND":
      return json({ error: "not_found" }, 404);
    case "VALIDATION":
      return json({ error: "invalid", message: result.message }, 400);
    case "CONFLICT":
      return json({ error: "conflict" }, 409);
    default:
      return json({ error: "internal" }, 500);
  }
}

export async function POST(req: Request): Promise<Response> {
  const gate = await authorize();
  if (gate instanceof Response) return gate;

  const body = await readJson(req);
  if (body === null) return json({ error: "invalid", message: "Expected a JSON object" }, 400);

  // The shape the browser's `PushSubscription.toJSON()` produces, passed through untouched; every
  // field is validated inside the action, which is the only validator.
  const keys = typeof body.keys === "object" && body.keys !== null ? (body.keys as Record<string, unknown>) : {};
  return fromActionResult(
    await subscribePush({
      endpoint: String(body.endpoint ?? ""),
      keys: { p256dh: String(keys.p256dh ?? ""), auth: String(keys.auth ?? "") },
      replaces: typeof body.replaces === "string" ? body.replaces : undefined,
    }),
  );
}

export async function DELETE(req: Request): Promise<Response> {
  const gate = await authorize();
  if (gate instanceof Response) return gate;

  const body = await readJson(req);
  if (body === null || typeof body.endpoint !== "string") {
    return json({ error: "invalid", message: "Expected { endpoint }" }, 400);
  }
  return fromActionResult(await unsubscribePush({ endpoint: body.endpoint }));
}
