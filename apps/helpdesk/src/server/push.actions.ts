"use server";

/**
 * Web-push subscriptions — the writes. `"use server"`, node, layer L4.
 *
 * A `PushSubscription` row is a DEVICE REGISTRATION, not a record about a client: an endpoint URL
 * issued by a push service, two key halves the browser generated, and a sanitized user-agent string
 * so a person can tell their phone from their laptop. It carries nothing about a ticket, and the
 * push messages it later receives are PII-light by contract.
 *
 * WHY THE ENDPOINT IS A SECRET. Anyone holding a push endpoint URL can send that browser
 * notifications. It is a bearer capability, which is why §3.3 rule 2 puts it beside a token: the
 * ledger stores `sha256(endpoint)` and never the URL, and no DTO, route or log ever returns one.
 *
 * WHY THIS TABLE MAY BE DELETED. CONTRACT §1.4, one of exactly two exceptions: a dead subscription
 * is a liability, not evidence, and the `PUSH_SUBSCRIBED` / `PUSH_UNSUBSCRIBED` pair is the record
 * either way. `unsubscribePush` is the human path; `pruneGoneSubscription` (in `@/lib/web-push`) is
 * the 410 path.
 *
 * AUTH IS THE SESSION AND NOTHING ELSE. There is no capability gate: registering the
 * browser you are already signed in on is not a privilege, and a viewer with no group never reaches
 * an authenticated page to begin with. The row is bound to `viewer.id`, so a subscription can only
 * ever be made for oneself.
 *
 * AND THEREFORE THE ENDPOINT IS GUARDED LIKE A WEBHOOK URL. This is the second place in the
 * application where a person supplies a URL the server later fetches (the first is `/admin/webhooks`,
 * which B5 built `@/lib/ssrf-guard` for), and it is the WIDER of the two: every signed-in member of
 * staff reaches it, the fetch carries a VAPID `Authorization` header out of the VPC, and the caller
 * never learns the outcome, so the forgery would be blind. `assertPushEndpointAllowed` — an allowlist
 * of the real browser push services over the top of B5's forbidden-host and forbidden-address
 * primitives — refuses anything that is not one, here at registration, and `sendWebPush` re-checks it
 * with a live resolution immediately before the send.
 *
 * Nothing here transmits anything.
 */
import { z } from "zod";
import type { ActionResult, AuditEntry } from "@/types/domain";
import { actorFromViewer, prepareUserAgent, writeAuditMany } from "@/lib/audit";
import { withTx } from "@/lib/db";
import { env, isWebPushEnabled } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";
import { fromBase64Url } from "@/lib/web-push/codec";
import {
  PUSH_ENDPOINT_MAX_CHARS,
  assertPushEndpointAllowed,
  hashEndpoint,
  pushServiceHost,
} from "@/lib/web-push/endpoint";
import { runAction } from "@/server/action-utils";

/** Push endpoints are long; this is a ceiling, not a shape. The guard caps at the same number. */
const ENDPOINT_MAX = PUSH_ENDPOINT_MAX_CHARS;
/** Uncompressed P-256 point. */
const P256DH_BYTES = 65;
/** RFC 8291 §3.1 authentication secret. */
const AUTH_BYTES = 16;

/** A base64url field of an exact decoded length, refused by NAME rather than by a length guess. */
function base64UrlOf(bytes: number, label: string): z.ZodType<string> {
  return z.string().superRefine((value, ctx) => {
    try {
      fromBase64Url(value, bytes);
    } catch {
      ctx.addIssue({ code: "custom", message: `${label} must be ${bytes} bytes of base64url` });
    }
  });
}

const subscribeSchema = z.object({
  /**
   * The URL the server will later POST to. `assertPushEndpointAllowed` is the whole check: https,
   * no credentials, no internal name, no bare address, and a host that is one of the browser push
   * services. Its `reason` is surfaced verbatim because it describes the SHAPE of an endpoint and
   * names no person, no ticket and no internal host (the route returns it as a 400 message).
   */
  endpoint: z
    .string()
    .trim()
    .max(ENDPOINT_MAX)
    .superRefine((value, ctx) => {
      const verdict = assertPushEndpointAllowed(value);
      if (!verdict.allowed) ctx.addIssue({ code: "custom", message: verdict.reason ?? "endpoint is not accepted" });
    }),
  keys: z.object({ p256dh: base64UrlOf(P256DH_BYTES, "p256dh"), auth: base64UrlOf(AUTH_BYTES, "auth") }),
  /**
   * The endpoint this one REPLACES, sent by the service worker's `pushsubscriptionchange` handler
   * (`public/sw.js`). A push service may rotate a subscription with no page open; without this the
   * old row lingers until a send earns its 410. Ignored unless it belongs to the same viewer.
   *
   * DELIBERATELY NOT PUT THROUGH THE SSRF GUARD, unlike `endpoint`. Nothing is ever fetched from this
   * value: it is a lookup key for a DELETE, scoped to a row that already belongs to the caller. Any
   * row it can match passed the guard when it was created, and refusing an unguarded legacy value
   * here would strand exactly the dead row this field exists to retire.
   */
  replaces: z.string().trim().max(ENDPOINT_MAX).optional(),
});

const unsubscribeSchema = z.object({ endpoint: z.string().trim().max(ENDPOINT_MAX) });

export type SubscribePushActionInput = z.input<typeof subscribeSchema>;
export type UnsubscribePushActionInput = z.input<typeof unsubscribeSchema>;

/**
 * Registers (or re-registers) this browser for web push. CONTRACT §10 B10.
 *
 * `endpoint` is UNIQUE, so the write is an upsert and the interesting case is the one where the row
 * already exists:
 *
 *  - **same viewer, same keys** — a page that re-subscribed on load. `lastSeenAt` is touched and
 *    **no audit row is written**, because nothing transitioned. A ledger that gains a row every time
 *    a tab opens is a ledger nobody reads.
 *  - **same viewer, rotated keys** — the browser re-keyed the subscription. One row, updated, and one
 *    `PUSH_SUBSCRIBED`.
 *  - **a different viewer** — a shared or re-assigned device. The row moves to the current viewer,
 *    with `PUSH_UNSUBSCRIBED` for the previous owner and `PUSH_SUBSCRIBED` for this one, so the
 *    ledger never shows one endpoint belonging to two people at once.
 *
 * `NOT_FOUND` when push is unconfigured, matching the route's 404: a deployment that cannot send must
 * not accumulate subscriptions it will never use.
 */
export async function subscribePush(input: SubscribePushActionInput): Promise<ActionResult<{ id: string }>> {
  return runAction("subscribePush", async (viewer, ctx) => {
    if (!isWebPushEnabled(env)) throw new NotFoundError("web push is not configured");
    const data = subscribeSchema.parse(input);
    const actor = actorFromViewer(viewer);
    const userAgent = prepareUserAgent(ctx.userAgent);

    return withTx(async (tx) => {
      const entries: AuditEntry[] = [];

      // The rotation the service worker reported, if it is this viewer's to retire.
      if (data.replaces !== undefined && data.replaces !== data.endpoint) {
        const old = await tx.pushSubscription.findUnique({
          where: { endpoint: data.replaces },
          select: { id: true, userId: true },
        });
        if (old !== null && old.userId === viewer.id) {
          await tx.pushSubscription.delete({ where: { id: old.id } });
          entries.push({
            action: "PUSH_UNSUBSCRIBED",
            entityType: "PUSH_SUBSCRIPTION",
            entityId: old.id,
            fieldChanged: "endpoint",
            oldValue: null,
            newValue: hashEndpoint(data.replaces),
            metadata: { reason: "ROTATED", service: pushServiceHost(data.replaces) },
          });
        }
      }

      const existing = await tx.pushSubscription.findUnique({
        where: { endpoint: data.endpoint },
        select: { id: true, userId: true, p256dh: true, auth: true },
      });

      const unchanged =
        existing !== null &&
        existing.userId === viewer.id &&
        existing.p256dh === data.keys.p256dh &&
        existing.auth === data.keys.auth;

      const row = await tx.pushSubscription.upsert({
        where: { endpoint: data.endpoint },
        create: {
          userId: viewer.id,
          endpoint: data.endpoint,
          p256dh: data.keys.p256dh,
          auth: data.keys.auth,
          userAgent,
          lastSeenAt: new Date(),
        },
        update: {
          userId: viewer.id,
          p256dh: data.keys.p256dh,
          auth: data.keys.auth,
          userAgent,
          lastSeenAt: new Date(),
        },
        select: { id: true },
      });

      if (existing !== null && existing.userId !== viewer.id) {
        entries.push({
          action: "PUSH_UNSUBSCRIBED",
          entityType: "PUSH_SUBSCRIPTION",
          entityId: existing.id,
          fieldChanged: "endpoint",
          oldValue: null,
          newValue: hashEndpoint(data.endpoint),
          metadata: { reason: "REASSIGNED", service: pushServiceHost(data.endpoint), previousUserId: existing.userId },
        });
      }

      if (!unchanged) {
        entries.push({
          action: "PUSH_SUBSCRIBED",
          entityType: "PUSH_SUBSCRIPTION",
          entityId: row.id,
          fieldChanged: "endpoint",
          // The hash, never the URL (§3.3 rule 2).
          oldValue: null,
          newValue: hashEndpoint(data.endpoint),
          metadata: { service: pushServiceHost(data.endpoint), rekeyed: existing !== null },
        });
      }

      if (entries.length > 0) await writeAuditMany(tx, actor, ctx, entries);
      return { id: row.id };
    });
  });
}

/**
 * Removes this browser's subscription. CONTRACT §10 B10.
 *
 * `{ deleted: false }` when there is nothing to remove — a second tap, or a browser that had already
 * been pruned by a 410 — and no audit row, because nothing transitioned. An endpoint belonging to
 * someone else is `NOT_FOUND`, the same answer as one that does not exist: whose device an endpoint
 * is may not be probed by anyone who happens to hold the URL.
 */
export async function unsubscribePush(input: UnsubscribePushActionInput): Promise<ActionResult<{ deleted: boolean }>> {
  return runAction("unsubscribePush", async (viewer, ctx) => {
    const data = unsubscribeSchema.parse(input);
    const actor = actorFromViewer(viewer);

    return withTx(async (tx) => {
      const existing = await tx.pushSubscription.findUnique({
        where: { endpoint: data.endpoint },
        select: { id: true, userId: true },
      });
      if (existing === null) return { deleted: false };
      if (existing.userId !== viewer.id) throw new NotFoundError("subscription not found");

      await tx.pushSubscription.delete({ where: { id: existing.id } });
      await writeAuditMany(tx, actor, ctx, [
        {
          action: "PUSH_UNSUBSCRIBED",
          entityType: "PUSH_SUBSCRIPTION",
          entityId: existing.id,
          fieldChanged: "endpoint",
          oldValue: null,
          newValue: hashEndpoint(data.endpoint),
          metadata: { reason: "USER", service: pushServiceHost(data.endpoint) },
        },
      ]);
      return { deleted: true };
    });
  });
}
