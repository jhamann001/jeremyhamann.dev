/**
 * Delivering one web-push message (`pwa-push`) — CONTRACT §10 B10.
 *
 * NOTHING ON THIS BRANCH TRANSMITS. The three `VAPID_*` keys are unset in every environment, so
 * `isWebPushEnabled(env)` is false, `sendWebPush` returns `"disabled"` and no request is made
 * (CONTRACT §0 rule 4). The transport below has never run outside a test with an injected one.
 *
 * The four outcomes and what each one means to the caller (B1's dispatcher):
 *
 *   "disabled" — push is not configured. Not an error, not a retry: the deployment cannot send.
 *   "sent"     — the push service accepted the message for delivery. It is not a read receipt.
 *   "gone"     — HTTP 404/410. The subscription is dead and the row has been PRUNED here, with its
 *                `PUSH_UNSUBSCRIBED` row. The caller must not retry and must not re-create it.
 *   "failed"   — anything else, including a network error or a timeout. The caller may retry later.
 *
 * It never throws. A notification dispatcher iterating a list of recipients must not have one dead
 * browser end the run, and the in-app inbox row is written either way — the push is the second
 * channel, never the record (CONTRACT §3.3 rule 3).
 *
 * THE SSRF GUARD RUNS AGAIN HERE, per send, with a live resolution — AND THE CONNECTION IS PINNED TO
 * WHAT IT VERIFIED. `subscribePush` already refused anything that is not a browser push service, but
 * this request leaves the VPC carrying an `Authorization` header and is driven by a row read back out
 * of the database, so the check belongs at the point of use as well as at the point of entry: a row
 * written before the guard existed, by a future code path, or by direct database access must not
 * become an egress primitive. A refusal is `"failed"` — never retried into a `"sent"`.
 *
 * The pinning is the half this file used to be missing. `fetch` resolved the endpoint a SECOND time,
 * independently of the guard, so the address that had been judged was not the address that got
 * connected to — the same defect `src/jobs/webhook-dispatch.ts` was rewritten to close, and the same
 * fix: `node:https` carrying the socket's own resolver (`./transport`), which re-judges every answer
 * at connect time. One resolver drives both halves, so the verdict and the connection cannot disagree.
 */
import { env, isWebPushEnabled } from "@/lib/env";
import { logError, logWarn } from "@/lib/logger";
import { encryptPayload } from "./ece";
import {
  assertPushEndpointResolvable,
  pushServiceHost,
  resolvePushAddresses,
  type PushAddressLookup,
} from "./endpoint";
import type { PushTransport, PushTransportResult } from "./transport";
import { vapidAuthorization, vapidJwt, vapidKeysMatch } from "./vapid";

export type PushOutcome = "sent" | "gone" | "failed" | "disabled";

/**
 * How long the push service should hold an undeliverable message. Four hours: a help-desk
 * notification that surfaces the next morning is noise a person has to dismiss, and the inbox row is
 * still there. RECOMMENDED DEFAULT, pending confirmation (CONTRACT §13 / integration notes).
 */
export const PUSH_TTL_SECONDS = 4 * 60 * 60;

/** A push service that has not answered in this long is not going to. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The subscription fields a send needs, exactly as `PushSubscription` stores them. */
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/**
 * `vapidKeysMatch` does an ECDH per call, so it is evaluated once per process rather than per send.
 * A mismatched pair is a configuration error that produces a 401 from every push service and looks
 * exactly like a revoked key; catching it here names it once, at the first send.
 */
let keysChecked: boolean | null = null;

function keysUsable(publicKey: string, privateKey: string): boolean {
  if (keysChecked === null) {
    keysChecked = vapidKeysMatch(publicKey, privateKey);
    if (!keysChecked) {
      logWarn("web-push", "vapid_key_pair_mismatch", { detail: "VAPID_PUBLIC_KEY is not the public key of VAPID_PRIVATE_KEY; push is off" });
    }
  }
  return keysChecked;
}

/** Exported for the tests, which run several configurations in one process. */
export function resetVapidKeyCheck(): void {
  keysChecked = null;
}

/**
 * Maps a push service's status to an outcome.
 *
 * 201 is the documented success; 200 and 202 are accepted because push services have returned both.
 * 404 and 410 are BOTH "this subscription no longer exists" — RFC 8030 says 404 for an unknown
 * subscription and 410 for one that has expired, and either way retrying is pointless and keeping the
 * row is a liability. Exported and pure so the mapping is tested without a network.
 */
export function outcomeForStatus(status: number): Exclude<PushOutcome, "disabled"> {
  if (status === 200 || status === 201 || status === 202) return "sent";
  if (status === 404 || status === 410) return "gone";
  return "failed";
}

/**
 * CONTRACT §10 B10. `payload` is B1's PII-light object (`{title, body, url, tag}`): a kind label, a
 * WM number and a deep link, never a subject and never body text. It is encrypted to
 * the subscription's own key either way — the push service cannot read it — but "the transport cannot
 * read it" is not a reason to put client material on a lock screen.
 *
 * `lookup` is the resolver BOTH halves of the guard use — the pre-send check and the socket's own
 * pinned resolver. It exists so the tests can prove the guard without a DNS query; production callers
 * pass nothing and get `node:dns`. `transport` exists for the same reason, one layer down: no test in
 * this repository opens a socket.
 */
export async function sendWebPush(
  sub: PushTarget,
  payload: unknown,
  lookup?: PushAddressLookup,
  transport?: PushTransport,
): Promise<PushOutcome> {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!isWebPushEnabled(env) || publicKey === undefined || privateKey === undefined || subject === undefined) {
    return "disabled";
  }
  if (!keysUsable(publicKey, privateKey)) return "disabled";

  let request: { body: Uint8Array; authorization: string };
  try {
    const json = JSON.stringify(payload ?? {});
    const encrypted = encryptPayload(new TextEncoder().encode(json ?? "{}"), sub.p256dh, sub.auth);
    const token = vapidJwt(sub.endpoint, subject, privateKey);
    request = { body: encrypted.body, authorization: vapidAuthorization(token, publicKey) };
  } catch (e) {
    // A bad p256dh/auth pair, an over-long payload or an unserialisable object. All of them are ours
    // to fix, none of them is retryable, and none of them may take the caller down.
    logError("web-push", e, { op: "build_message" });
    return "failed";
  }

  // One resolver for both halves: the verdict below and the socket's own lookup a moment later.
  const resolver = lookup ?? resolvePushAddresses;

  // The guard, immediately before the request and after everything that could not reach the network.
  // The reason is logged; the endpoint never is (CONTRACT §3.3 rule 2).
  const guard = await assertPushEndpointResolvable(sub.endpoint, resolver);
  if (!guard.allowed) {
    logWarn("web-push", "endpoint_refused", { reason: guard.reason, service: pushServiceHost(sub.endpoint) });
    return "failed";
  }

  let result: PushTransportResult;
  try {
    // Loaded at the call, so the "disabled" path every environment on this branch takes never pulls
    // `node:https` — or the pinned resolver's `node:dns` — into the module graph.
    const { pushHttpsTransport, pushPinnedLookup } = await import("./transport");
    const send = transport ?? pushHttpsTransport;
    result = await send({
      url: sub.endpoint,
      headers: {
        Authorization: request.authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: "normal",
      },
      body: request.body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      lookup: pushPinnedLookup(resolver),
    });
  } catch (e) {
    logError("web-push", e, { op: "send_request" });
    return "failed";
  }

  if (result.status === null) {
    // The reason this module wrote, never a push service's text and never the endpoint.
    logWarn("web-push", "request_failed", { reason: result.error });
    return "failed";
  }

  const outcome = outcomeForStatus(result.status);
  if (outcome === "failed") {
    // The status only. A push service's body can echo the endpoint, which is a capability.
    logWarn("web-push", "push_service_refused", { status: result.status });
  }
  if (outcome === "gone") {
    // Lazy, so the database layer is not in this module's graph for the "disabled" path that every
    // environment on this branch actually takes.
    try {
      const { pruneGoneSubscription } = await import("./prune");
      await pruneGoneSubscription(sub.endpoint);
    } catch (e) {
      logError("web-push", e, { op: "prune_gone_subscription" });
    }
  }
  return outcome;
}
