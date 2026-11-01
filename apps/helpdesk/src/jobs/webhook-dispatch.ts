/**
 * Outbound webhook dispatch — node only.
 *
 * The desk's own ledger is the event stream. This job reads `AuditLog` forward by `seq` from a durable
 * `JobCursor`, exactly like `src/jobs/event-alerts.ts`, and turns each subscribed row into one
 * `WebhookDelivery` per subscribing endpoint. It then attempts the deliveries that are due.
 *
 * WHY A CURSOR AND NOT A TIME WINDOW: `seq` is gapless and assigned by the chain trigger, so
 * "everything after N" is exact. A `occurredAt > now - 5m` window silently drops a row written during
 * a slow transaction and silently repeats one when a run is late.
 *
 * FIRST RUN DOES NOT BACKFILL. With no cursor row the job writes the cursor at the ledger's head and
 * reports zero. Switching webhooks on must not replay months of history into a third party's endpoint.
 *
 * AT MOST ONCE PER (ENDPOINT, EVENT), AT LEAST ONCE PER DELIVERY. `@@unique([endpointId, auditSeq])`
 * is the first guarantee and it is the database's, not this code's; a re-run that re-scans the same
 * ledger rows creates nothing. The second is ordinary retry semantics: a delivery whose HTTP attempt
 * failed is retried with exponential backoff until `WAVE_B_LIMITS.webhookMaxAttempts`, then goes DEAD
 * and stops. A receiver therefore has to be idempotent on `X-WMHD-Delivery`, and
 * the build record says so.
 *
 * NOTHING IS SENT UNLESS `WEBHOOKS_ENABLED` IS SET, and it is set nowhere. Without it the job logs
 * "disabled", creates nothing, advances nothing and returns zeros — it is not a no-op that pretends to
 * have worked. The tests never reach the network either: `dispatchWebhooks` takes an injected
 * transport, and the default one is the only code in this file that opens a socket.
 *
 * NOTHING IS SENT UNSIGNED EITHER. The signing key is derived per endpoint from the app-held
 * `WEBHOOK_SIGNING_KEY` and the row's salt (`signingKeyFor`); with the key unset there is no key to
 * fall back to, and the attempt is recorded as an ordinary failure instead.
 *
 * THE SSRF GUARD RUNS AGAIN HERE, per send, with a live DNS lookup — AND THE CONNECTION IS PINNED TO
 * WHAT IT VERIFIED. The check at registration proves what the hostname pointed at that day; the
 * send-time one proves what it points at now; `pinnedLookup` proves that the socket goes to that same
 * answer rather than to whatever a second, independent resolution returns a moment later.
 */
import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupAllOptions, LookupOptions } from "node:dns";
import type { ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Prisma } from "@prisma/client";
import type { AuditAction, AuditEntityType, AuditEntry } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";
import {
  SYSTEM_ACTOR,
  actorFromMachineUser,
  resolveJobActorEmail,
  systemRequestContext,
  writeAuditMany,
} from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { env } from "@/lib/env";
import { sanitizePII } from "@/lib/pii";
import { isForbiddenAddress } from "@/lib/ssrf-guard";
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  deriveEndpointSigningKey,
  sha256Hex,
  signWebhookBody,
} from "@/lib/webhook-signing";
import { createJobLogger } from "@/jobs/logger";
import { appBaseUrl } from "@/jobs/slack";
import type { JobContext, JobOutcome } from "@/jobs/types";
import {
  assertEndpointUrlAllowed,
  buildWebhookPayload,
  isSubscribableAction,
  serializeWebhookPayload,
} from "@/server/webhooks";
import type { AddressLookup, WebhookSourceEvent, WebhookTicketFacts } from "@/server/webhooks";

/** `JobCursor.name` for this job. One row, updated in place; the JOB_RUN row is the evidence. */
export const WEBHOOK_DISPATCH_CURSOR = "webhook-dispatch";

/** Ledger rows examined per run. Matches the event-alert job's batch, for the same reason. */
export const WEBHOOK_DISPATCH_BATCH = 500;

/** Deliveries ATTEMPTED per run. Bounded so one unreachable endpoint cannot hold a schedule open. */
export const WEBHOOK_SEND_LIMIT = 50;

/** How long one HTTP attempt may take. A job must not hang its schedule on a slow receiver. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** First retry delay. Attempt n waits `base * 2^(n-1)`, capped — 1m, 2m, 4m … to the cap. */
export const WEBHOOK_BACKOFF_BASE_MS = 60_000;
export const WEBHOOK_BACKOFF_MAX_MS = 6 * 60 * 60_000;

/** `lastError` is a reason, never a provider payload. Same ceiling as the outbox's. */
export const WEBHOOK_ERROR_MAX_CHARS = 500;

/** Hex characters of `sha256(endpointId)` carried in a delivery id. 16 → 64 bits, collision-free here. */
export const DELIVERY_ID_ENDPOINT_CHARS = 16;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type WebhookRequest = {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
};

/** A response status, or a reason there was none. Never a response body: it is a third party's text. */
export type WebhookTransportResult = { status: number } | { status: null; error: string };

export type WebhookTransport = (request: WebhookRequest) => Promise<WebhookTransportResult>;

/** The DNS answer shape the pinned lookup works in: every address, so none can be judged unseen. */
export type AllAddressResolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** The `lookup` a socket accepts. Deliberately the same shape `node:net` declares, so it drops in. */
export type PinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

const defaultResolver: AllAddressResolver = dnsLookup;

/** The error a blocked connect fails with. Named so the delivery's `lastError` can say what happened. */
export class WebhookAddressBlockedError extends Error {
  constructor(hostname: string) {
    super(`Refusing to connect: ${hostname} resolves to an address this desk may not reach.`);
    this.name = "WebhookAddressBlockedError";
  }
}

/**
 * THE ADDRESS THAT IS CHECKED IS THE ADDRESS THAT IS USED.
 *
 * `assertEndpointUrlAllowed` resolves the hostname and judges the answers, and that check used to be
 * the whole control — but `fetch` then resolved the name a SECOND time, independently, and nothing
 * pinned the connection to what had been verified. An attacker who controls DNS for a registered
 * endpoint publishes a short-TTL record that answers public for the guard's lookup and `10.0.0.5` (or
 * `169.254.169.254`) for the connection's, and the rebinding window the module's header claimed to
 * close was wide open — no redirect involved, so `redirect: "manual"` never came into it.
 *
 * This is the socket's own resolver. It runs `isForbiddenAddress` over EVERY answer at the moment the
 * connection is about to be made, and fails the connect if any of them is forbidden — the same
 * all-or-nothing rule `assertResolvedAddresses` applies, because a name with one public and one private
 * answer is a rebind with the rebind pre-published, and happy-eyeballs may take either.
 *
 * A resolver error stays an error: "we could not check" is not "it is safe".
 */
export function pinnedLookup(resolver: AllAddressResolver = defaultResolver): PinnedLookup {
  return (hostname, options, callback) => {
    const all: LookupAllOptions = { ...options, all: true };
    resolver(hostname, all, (err, addresses) => {
      if (err !== null) {
        callback(err, []);
        return;
      }
      if (addresses.length === 0 || addresses.some((a) => isForbiddenAddress(a.address))) {
        callback(new WebhookAddressBlockedError(hostname), []);
        return;
      }
      if (options.all === true) {
        callback(null, addresses);
        return;
      }
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** The reason one failed attempt records. Never a response body: it is a third party's text. */
function transportFailure(e: unknown, timedOut: boolean): string {
  if (timedOut) return "timed out";
  if (e instanceof WebhookAddressBlockedError) {
    return "that host resolved to a private, loopback or link-local address at connect time";
  }
  const name = e instanceof Error ? e.name : typeof e;
  return `request failed (${name})`;
}

/**
 * The only code in this repository that opens a connection to an operator-supplied URL.
 *
 * `node:https` rather than `fetch`, for one reason: `fetch` gives no way to pin the connection to the
 * address the SSRF guard verified, and an unpinned check is a check an attacker re-points DNS around
 * (see `pinnedLookup`). The request carries the socket's resolver with it, so the guard's verdict and
 * the connection cannot disagree.
 *
 * REDIRECTS ARE NOT FOLLOWED — `node:https` does not follow them at all, which is the property
 * `redirect: "manual"` used to buy: a 302 to `http://169.254.169.254` would otherwise be fetched with
 * none of this module's guarding. A 3xx comes back as an ordinary non-2xx status, so an operator sees
 * it and fixes the URL.
 *
 * THE RESPONSE BODY IS NEVER READ. The stream is drained so the socket closes cleanly and discarded;
 * only the status travels back, and `lastError` is a reason this module wrote.
 */
export function webhookHttpsTransport(lookup: PinnedLookup = pinnedLookup()): WebhookTransport {
  return (request) =>
    new Promise<WebhookTransportResult>((resolve) => {
      const body = Buffer.from(request.body, "utf8");
      let settled = false;
      let timedOut = false;

      let req: ClientRequest;
      try {
        req = httpsRequest(request.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(body.byteLength),
            ...request.headers,
          },
          lookup,
          // A fresh agent per attempt: a pooled socket was resolved and verified for an earlier
          // attempt, and reusing it would reuse that verdict too.
          agent: false,
        });
      } catch (e) {
        // Nothing has been scheduled yet — a malformed or non-https URL never reaches a socket.
        resolve({ status: null, error: transportFailure(e, false) });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        req.destroy();
      }, request.timeoutMs);

      const done = (result: WebhookTransportResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // The status, the moment it is known. A destroyed or reset connection AFTER the status line is
      // still an answer from the receiver, and reporting it beats reporting the reset.
      let seenStatus: number | null = null;

      req.on("response", (res) => {
        seenStatus = res.statusCode ?? 0;
        // Drained, never read: the body is a third party's text and draining is what lets the
        // socket close instead of leaking for the length of the job.
        res.resume();
        res.on("end", () => done({ status: seenStatus ?? 0 }));
      });
      req.on("error", (e) => done({ status: null, error: transportFailure(e, timedOut) }));
      // Belt and braces: `close` always fires, so one attempt can never leave the job awaiting a
      // promise that nothing will settle — which would hold the whole schedule open.
      req.on("close", () =>
        done(
          seenStatus === null
            ? { status: null, error: transportFailure(new Error("connection closed"), timedOut) }
            : { status: seenStatus },
        ),
      );
      req.end(body);
    });
}

/** The default transport. The tests inject their own and never reach this one. */
export const fetchTransport: WebhookTransport = webhookHttpsTransport();

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export async function readWebhookCursor(): Promise<bigint | null> {
  const row = await prisma.jobCursor.findUnique({ where: { name: WEBHOOK_DISPATCH_CURSOR }, select: { seq: true } });
  return row?.seq ?? null;
}

export async function writeWebhookCursor(seq: bigint): Promise<void> {
  await prisma.jobCursor.upsert({
    where: { name: WEBHOOK_DISPATCH_CURSOR },
    create: { name: WEBHOOK_DISPATCH_CURSOR, seq },
    update: { seq },
  });
}

export async function webhookLedgerHead(): Promise<bigint> {
  const agg = await prisma.auditLog.aggregate({ _max: { seq: true } });
  return agg._max.seq ?? BigInt(0);
}

// ---------------------------------------------------------------------------
// Scan: ledger rows → delivery rows
// ---------------------------------------------------------------------------

export type ActiveEndpoint = { id: string; url: string; events: AuditAction[] };

/** Live endpoints with at least one subscribed event. A revoked or paused endpoint receives nothing. */
export async function activeEndpoints(): Promise<ActiveEndpoint[]> {
  const rows = await prisma.webhookEndpoint.findMany({
    where: { isActive: true, revokedAt: null },
    select: { id: true, url: true, events: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.filter((r) => r.events.length > 0);
}

/** The union of every live endpoint's subscriptions, narrowed to what may be subscribed to at all. */
export function subscribedActions(endpoints: readonly ActiveEndpoint[]): AuditAction[] {
  const union = new Set<AuditAction>();
  for (const endpoint of endpoints) {
    for (const action of endpoint.events) {
      if (isSubscribableAction(action)) union.add(action);
    }
  }
  return [...union];
}

export function webhookScanWhere(afterSeq: bigint, actions: readonly AuditAction[]): Prisma.AuditLogWhereInput {
  return { seq: { gt: afterSeq }, action: { in: [...actions] } };
}

const TICKET_FACTS_SELECT = {
  id: true,
  number: true,
  status: true,
  priority: true,
  category: true,
  brand: true,
  createdAt: true,
  updatedAt: true,
  queue: { select: { key: true } },
} as const;

/** One batch of subscribed ledger rows after `afterSeq`, oldest first, with PII-light ticket facts. */
export async function readWebhookEvents(afterSeq: bigint, actions: readonly AuditAction[]): Promise<WebhookSourceEvent[]> {
  if (actions.length === 0) return [];
  const rows = await prisma.auditLog.findMany({
    where: webhookScanWhere(afterSeq, actions),
    orderBy: { seq: "asc" },
    take: WEBHOOK_DISPATCH_BATCH,
    select: {
      seq: true,
      action: true,
      entityType: true,
      entityId: true,
      fieldChanged: true,
      oldValue: true,
      newValue: true,
      occurredAt: true,
      ticket: { select: TICKET_FACTS_SELECT },
    },
  });

  return rows.map((row) => {
    const ticket: WebhookTicketFacts | null =
      row.ticket === null
        ? null
        : {
            id: row.ticket.id,
            number: row.ticket.number,
            queue: row.ticket.queue.key,
            status: row.ticket.status,
            priority: row.ticket.priority,
            category: row.ticket.category,
            brand: row.ticket.brand,
            createdAt: row.ticket.createdAt.toISOString(),
            updatedAt: row.ticket.updatedAt.toISOString(),
          };
    return {
      seq: row.seq,
      action: row.action,
      entityType: row.entityType as AuditEntityType,
      entityId: row.entityId,
      fieldChanged: row.fieldChanged,
      oldValue: row.oldValue,
      newValue: row.newValue,
      occurredAt: row.occurredAt,
      ticket,
    };
  });
}

/**
 * `wdl_<seq base36>_<sha256(endpointId) first 16 hex>` — stable, so a retried scan produces the id it
 * produced before, and INJECTIVE in the endpoint id, which a suffix is not.
 *
 * It used to take `endpointId.slice(-12)`. Two endpoints whose cuids share their last twelve characters
 * would then produce the same id for the same `auditSeq`, and `createMany({ skipDuplicates: true })`
 * would discard the second row silently: one subscriber never receives that event, and nothing — not
 * the run's `created` count, not a log line, not an audit row — records the loss. A digest of the WHOLE
 * id removes the collision instead of making it rarer, and `@@unique([endpointId, auditSeq])` still
 * expresses the real guarantee.
 */
export function deliveryIdFor(endpointId: string, seq: bigint): string {
  return `wdl_${seq.toString(36)}_${sha256Hex(endpointId).slice(0, DELIVERY_ID_ENDPOINT_CHARS)}`;
}

/**
 * Creates the missing `WebhookDelivery` rows for one batch and advances the cursor, in ONE transaction.
 *
 * The cursor moves with the rows rather than after them: if the insert commits and the cursor write
 * does not, the next run re-scans the same seqs, `skipDuplicates` discards every row it already made,
 * and nothing is delivered twice — but if the cursor moved without the rows, those events would be lost
 * with no trace. Tying them together makes the failure mode the recoverable one.
 *
 * No audit row is written for CREATING a delivery. A `WebhookDelivery` row is DERIVED from a ledger row
 * that is already in the ledger, and auditing the derivation would double the ledger's volume to record
 * nothing new — the same argument §3 rule 3 makes about notifications. The TRANSITIONS are audited.
 */
export async function createDeliveriesForBatch(
  events: readonly WebhookSourceEvent[],
  endpoints: readonly ActiveEndpoint[],
  lastSeq: bigint,
  base: string | undefined,
  now: Date,
): Promise<number> {
  const data: Prisma.WebhookDeliveryCreateManyInput[] = [];
  for (const event of events) {
    for (const endpoint of endpoints) {
      if (!endpoint.events.includes(event.action)) continue;
      const id = deliveryIdFor(endpoint.id, event.seq);
      // Built and PII-checked here so a payload that would violate §7.3 fails the SCAN, loudly, rather
      // than at send time on one endpoint at a time.
      const serialized = serializeWebhookPayload(buildWebhookPayload(id, event, base));
      data.push({
        id,
        endpointId: endpoint.id,
        auditSeq: event.seq,
        eventAction: event.action,
        entityId: event.entityId,
        ticketId: event.ticket?.id ?? null,
        payloadHash: serialized.hash,
        status: "PENDING",
        attempts: 0,
        nextAttemptAt: now,
      });
    }
  }

  return withTx(async (tx) => {
    let created = 0;
    if (data.length > 0) {
      const result = await tx.webhookDelivery.createMany({ data, skipDuplicates: true });
      created = result.count;
    }
    await tx.jobCursor.upsert({
      where: { name: WEBHOOK_DISPATCH_CURSOR },
      create: { name: WEBHOOK_DISPATCH_CURSOR, seq: lastSeq },
      update: { seq: lastSeq },
    });
    return created;
  });
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export type DueDelivery = {
  id: string;
  endpointId: string;
  auditSeq: bigint;
  eventAction: AuditAction;
  attempts: number;
  status: "PENDING" | "FAILED";
  ticketId: string | null;
  endpoint: { id: string; url: string; secretHash: string; isActive: boolean; revokedAt: Date | null };
};

/**
 * Deliveries whose next attempt is due, oldest first, on endpoints that are still live.
 *
 * A DEAD or SENT row is never handed back; a row on a revoked endpoint is left alone rather than
 * cancelled, because "it was queued while the endpoint was live and then the endpoint was retired" is
 * the true story and a status change would overwrite it.
 */
export async function readDueDeliveries(now: Date, limit: number): Promise<DueDelivery[]> {
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      endpoint: { isActive: true, revokedAt: null },
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: {
      id: true,
      endpointId: true,
      auditSeq: true,
      eventAction: true,
      attempts: true,
      status: true,
      ticketId: true,
      endpoint: { select: { id: true, url: true, secretHash: true, isActive: true, revokedAt: true } },
    },
  });
  return rows.filter((r): r is DueDelivery => r.status === "PENDING" || r.status === "FAILED");
}

/** `base * 2^(attempts-1)`, capped. `attempts` is the attempt just completed, so attempt 1 waits `base`. */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = WEBHOOK_BACKOFF_BASE_MS * 2 ** Math.min(exponent, 20);
  return Math.min(raw, WEBHOOK_BACKOFF_MAX_MS);
}

/** Sanitized and bounded. A receiver's text is a third party's words and never lands raw in the ledger. */
export function deliveryError(reason: string): string {
  return sanitizePII(reason).text.slice(0, WEBHOOK_ERROR_MAX_CHARS);
}

export type SendOutcome = "sent" | "failed" | "dead";

/** Everything the transition writes, decided from the transport's answer alone. */
export type AttemptVerdict = {
  outcome: SendOutcome;
  status: "SENT" | "FAILED" | "DEAD";
  action: "WEBHOOK_DELIVERY_SENT" | "WEBHOOK_DELIVERY_FAILED" | "WEBHOOK_DELIVERY_DEAD";
  attempts: number;
  responseStatus: number | null;
  lastError: string | null;
  sentAt: Date | null;
  nextAttemptAt: Date | null;
};

/**
 * The whole decision, as arithmetic: given what the transport said and how many attempts have now been
 * taken, what does the row become.
 *
 * Extracted from `attemptDelivery` so it is unit-testable without a database. That matters more than
 * usual here: the DB-gated half of this slice cannot run until a foundation migration's
 * `webhook_endpoint_https_only` regex is repaired (see the integration notes), and the rule that
 * decides whether a client-facing integration keeps being retried or is abandoned should not be the
 * part of the system that is only covered by a suite that currently skips.
 *
 * `2xx` is success and nothing else is. A 3xx counts as a failure: the transport refuses to follow
 * redirects on purpose (a 302 to a metadata address would bypass every SSRF check), so a receiver
 * answering 301 is misconfigured and should see retries, not a silent success.
 */
export function classifyAttempt(
  result: WebhookTransportResult,
  previousAttempts: number,
  now: Date,
  maxAttempts: number = WAVE_B_LIMITS.webhookMaxAttempts,
): AttemptVerdict {
  const attempts = previousAttempts + 1;
  const ok = result.status !== null && result.status >= 200 && result.status < 300;
  if (ok) {
    return {
      outcome: "sent",
      status: "SENT",
      action: "WEBHOOK_DELIVERY_SENT",
      attempts,
      responseStatus: result.status,
      lastError: null,
      sentAt: now,
      nextAttemptAt: null,
    };
  }

  const error = deliveryError("error" in result ? result.error : `HTTP ${String(result.status)}`);
  if (attempts >= maxAttempts) {
    return {
      outcome: "dead",
      status: "DEAD",
      action: "WEBHOOK_DELIVERY_DEAD",
      attempts,
      responseStatus: result.status,
      lastError: error,
      sentAt: null,
      nextAttemptAt: null,
    };
  }
  return {
    outcome: "failed",
    status: "FAILED",
    action: "WEBHOOK_DELIVERY_FAILED",
    attempts,
    responseStatus: result.status,
    lastError: error,
    sentAt: null,
    nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
  };
}

/** The headers one attempt carries. Pure, so the signature can be reproduced in a test and in the docs. */
export function deliveryHeaders(
  signingKey: string,
  body: string,
  timestamp: number,
  deliveryId: string,
  event: AuditAction,
): Record<string, string> {
  return {
    [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(signingKey, body, timestamp),
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_DELIVERY_HEADER]: deliveryId,
    [WEBHOOK_EVENT_HEADER]: event,
  };
}

/**
 * The signing key for one endpoint, or null when this deployment cannot sign at all.
 *
 * TWO HALVES, AND THE DATABASE HOLDS ONLY ONE. `WebhookEndpoint.secretHash` (the column name is
 * historical; see `src/lib/webhook-signing.ts`) holds a random per-endpoint salt, and the key is
 * `HMAC-SHA256(WEBHOOK_SIGNING_KEY, "<domain>:<salt>")`. A dump, a backup, a restore drill or a
 * SQL-injection read of that table therefore yields nothing signable: forging `X-WMHD-Signature` needs
 * the app-held key as well, which lives in Secret Manager and never in a row.
 *
 * It used to sign with the stored digest itself, which made that one column the credential — the exact
 * property the docstring claimed it avoided. Fixed here; the reasoning and the migration note are in
 * the build record, and the receiver now uses the secret it was
 * shown at creation VERBATIM rather than hashing it first.
 *
 * NULL IS FAIL-CLOSED, not a fallback. With `WEBHOOK_SIGNING_KEY` unset the caller records the delivery
 * as an ordinary failure; it never sends an unsigned or differently-keyed request, because a receiver
 * that accepts one of those has no authenticity property left.
 */
export function signingKeyFor(
  endpoint: { secretHash: string },
  appKey: string | undefined = env.WEBHOOK_SIGNING_KEY,
): string | null {
  return deriveEndpointSigningKey(appKey, endpoint.secretHash);
}

/**
 * Attempts ONE delivery and records the transition, each in its own transaction with its audit row last.
 *
 * Re-runs the SSRF guard immediately before the send. A refusal is an ordinary failure — it counts an
 * attempt, backs off and eventually goes DEAD — rather than a throw, because a hostname that has been
 * re-pointed at a private address is exactly the case where the desk must keep behaving predictably and
 * leave a trail.
 */
export async function attemptDelivery(
  delivery: DueDelivery,
  job: JobContext,
  transport: WebhookTransport,
  lookup?: AddressLookup,
): Promise<SendOutcome> {
  const base = appBaseUrl();
  const event = await loadSourceEvent(delivery);
  const payload = buildWebhookPayload(delivery.id, event, base);
  const serialized = serializeWebhookPayload(payload);

  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000);

  const guard = await assertEndpointUrlAllowed(delivery.endpoint.url, lookup);
  // Fail closed on BOTH gates before anything opens a socket. An unsigned request is worse than no
  // request: a receiver that accepts one has no authenticity property left, so a deployment with no
  // `WEBHOOK_SIGNING_KEY` records an ordinary failure and retries rather than sending.
  const signingKey = guard.allowed ? signingKeyFor(delivery.endpoint) : null;
  const unsignable = guard.allowed && signingKey === null;

  let result: WebhookTransportResult;
  if (!guard.allowed) {
    result = { status: null, error: guard.reason ?? "destination refused by the SSRF guard" };
  } else if (signingKey === null) {
    result = { status: null, error: "WEBHOOK_SIGNING_KEY is not set, so this delivery cannot be signed" };
  } else {
    result = await transport({
      url: delivery.endpoint.url,
      body: serialized.body,
      headers: deliveryHeaders(signingKey, serialized.body, timestamp, delivery.id, delivery.eventAction),
      timeoutMs: WEBHOOK_TIMEOUT_MS,
    });
  }

  const verdict = classifyAttempt(result, delivery.attempts, now);

  await withTx(async (tx) => {
    await tx.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: verdict.status,
        attempts: verdict.attempts,
        responseStatus: verdict.responseStatus,
        lastError: verdict.lastError,
        sentAt: verdict.sentAt,
        nextAttemptAt: verdict.nextAttemptAt,
        // The hash of the bytes THIS attempt signed, so a receiver's copy reconciles with ours even
        // though the ticket facts may have moved since the row was created.
        payloadHash: serialized.hash,
      },
    });

    const entry: AuditEntry = {
      action: verdict.action,
      entityType: "WEBHOOK_DELIVERY",
      entityId: delivery.id,
      ticketId: delivery.ticketId,
      fieldChanged: "status",
      oldValue: delivery.status,
      newValue: verdict.status,
      metadata: {
        responseStatus: verdict.responseStatus,
        attempts: verdict.attempts,
        endpointId: delivery.endpointId,
        event: delivery.eventAction,
        auditSeq: delivery.auditSeq.toString(),
        ...(verdict.lastError === null ? {} : { error: verdict.lastError }),
        ...(guard.allowed ? {} : { refusedBySsrfGuard: true }),
        ...(unsignable ? { refusedUnsigned: true } : {}),
      },
    };
    await writeAuditMany(tx, job.actor, job.ctx, [entry]);
  });

  job.log.info("delivery", {
    delivery: delivery.id,
    endpoint: delivery.endpointId,
    event: delivery.eventAction,
    attempts: verdict.attempts,
    outcome: verdict.outcome,
    responseStatus: verdict.responseStatus,
  });
  return verdict.outcome;
}

/**
 * The ledger row this delivery carries, re-read at send time.
 *
 * A TEST delivery has a negative `auditSeq` and no ledger row behind it (see `recordTestDelivery`); it
 * is reconstructed from the delivery row itself so the receiver gets the same payload shape as a real
 * event, with `ticket: null`.
 */
async function loadSourceEvent(delivery: DueDelivery): Promise<WebhookSourceEvent> {
  if (delivery.auditSeq < BigInt(0)) {
    return {
      seq: delivery.auditSeq,
      action: delivery.eventAction,
      entityType: "WEBHOOK_ENDPOINT",
      entityId: delivery.endpointId,
      fieldChanged: "testDelivery",
      oldValue: null,
      newValue: null,
      occurredAt: new Date(-Number(delivery.auditSeq)),
      ticket: null,
    };
  }

  const row = await prisma.auditLog.findUnique({
    where: { seq: delivery.auditSeq },
    select: {
      seq: true,
      action: true,
      entityType: true,
      entityId: true,
      fieldChanged: true,
      oldValue: true,
      newValue: true,
      occurredAt: true,
      ticket: { select: TICKET_FACTS_SELECT },
    },
  });
  if (row === null) {
    // The ledger is append-only and nothing deletes from it, so this is unreachable in a healthy
    // database. Reconstructing from the delivery row rather than throwing keeps one impossible row
    // from stalling every other delivery behind it in the queue.
    return {
      seq: delivery.auditSeq,
      action: delivery.eventAction,
      entityType: "TICKET",
      entityId: null,
      fieldChanged: null,
      oldValue: null,
      newValue: null,
      occurredAt: new Date(),
      ticket: null,
    };
  }
  return {
    seq: row.seq,
    action: row.action,
    entityType: row.entityType as AuditEntityType,
    entityId: row.entityId,
    fieldChanged: row.fieldChanged,
    oldValue: row.oldValue,
    newValue: row.newValue,
    occurredAt: row.occurredAt,
    ticket:
      row.ticket === null
        ? null
        : {
            id: row.ticket.id,
            number: row.ticket.number,
            queue: row.ticket.queue.key,
            status: row.ticket.status,
            priority: row.ticket.priority,
            category: row.ticket.category,
            brand: row.ticket.brand,
            createdAt: row.ticket.createdAt.toISOString(),
            updatedAt: row.ticket.updatedAt.toISOString(),
          },
  };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export type WebhookDispatchOptions = {
  limit?: number;
  /** Injected by the tests. The default is the only path that opens a socket. */
  transport?: WebhookTransport;
  /** Injected by the tests, so the SSRF re-check is exercised without a resolver. */
  lookup?: AddressLookup;
  now?: Date;
};

export type WebhookDispatchResult = {
  sent: number;
  failed: number;
  dead: number;
  created: number;
  scanned: number;
  cursor: string | null;
  disabled: boolean;
};

/**
 * Scan, then send. Exported separately from `runWebhookDispatch` so a test can inject a transport and
 * a resolver, and so the jobs registry has an ordinary `JobHandler` to call.
 */
export async function dispatchWebhooks(job: JobContext, options: WebhookDispatchOptions = {}): Promise<WebhookDispatchResult> {
  const empty: WebhookDispatchResult = {
    sent: 0,
    failed: 0,
    dead: 0,
    created: 0,
    scanned: 0,
    cursor: null,
    disabled: false,
  };

  if (!env.WEBHOOKS_ENABLED) {
    job.log.info("disabled", { key: "WEBHOOKS_ENABLED" });
    return { ...empty, disabled: true };
  }

  const endpoints = await activeEndpoints();
  const now = options.now ?? job.now;

  // --- Scan ---------------------------------------------------------------
  const cursor = await readWebhookCursor();
  if (cursor === null) {
    const head = await webhookLedgerHead();
    await writeWebhookCursor(head);
    job.log.info("cursor-initialised", { head: head.toString() });
    return { ...empty, cursor: head.toString() };
  }

  let created = 0;
  let scanned = 0;
  const actions = subscribedActions(endpoints);
  if (actions.length > 0) {
    const events = await readWebhookEvents(cursor, actions);
    scanned = events.length;
    if (events.length > 0) {
      created = await createDeliveriesForBatch(events, endpoints, events[events.length - 1].seq, appBaseUrl(), now);
    }
  } else {
    // No endpoint subscribes to anything. Advance past the batch anyway: holding the cursor would make
    // switching the first endpoint on replay every row since the job started, which is the backfill
    // the first-run rule exists to prevent.
    const head = await webhookLedgerHead();
    if (head > cursor) await writeWebhookCursor(head);
  }

  // --- Send ---------------------------------------------------------------
  const limit = Math.min(Math.max(options.limit ?? WEBHOOK_SEND_LIMIT, 1), WEBHOOK_SEND_LIMIT);
  const due = await readDueDeliveries(now, limit);
  const transport = options.transport ?? fetchTransport;

  let sent = 0;
  let failed = 0;
  let dead = 0;
  for (const delivery of due) {
    const outcome = await attemptDelivery(delivery, job, transport, options.lookup);
    if (outcome === "sent") sent += 1;
    else if (outcome === "dead") dead += 1;
    else failed += 1;
  }

  return { sent, failed, dead, created, scanned, cursor: cursor.toString(), disabled: false };
}

/**
 * A `JobContext` for a call that did not come through `src/jobs/run.ts`.
 *
 * Built from `@/lib/audit`'s primitives rather than by importing `jobActor` from `@/jobs/run`, because
 * `run.ts` imports THIS module to register the handler and the cycle would be real. The seeded jobs
 * identity is resolved the same way (`resolveJobActorEmail`, which `@/lib/audit` owns as the single
 * definition), and an inactive row falls back to `SYSTEM_ACTOR` rather than throwing — a direct call
 * to `runWebhookDispatch` has no `JOB_RUN` row to record the refusal on, and `activeEndpoints` will
 * find nothing to do anyway on a desk where the jobs identity is disabled.
 */
async function standaloneJobContext(): Promise<JobContext> {
  const ctx = systemRequestContext("job-webhook-dispatch");
  const email = resolveJobActorEmail(env.JOB_ACTOR_EMAIL);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, isActive: true } });
  const actor = user !== null && user.isActive ? actorFromMachineUser({ id: user.id, email: user.email }) : SYSTEM_ACTOR;
  return {
    name: "webhook-dispatch",
    actor,
    ctx,
    now: new Date(),
    log: createJobLogger("webhook-dispatch", ctx.requestId),
  };
}

/**
 * The contract's entry point.
 *
 * `runJob` in `src/jobs/run.ts` calls `runWebhookDispatchJob` below instead, which reuses the runner's
 * actor, request context and logger and therefore writes its `JOB_RUN` row with the seeded jobs
 * identity. This export exists so the dispatcher can also be driven directly — from a one-off script,
 * or from a test that wants the contract's exact signature.
 */
export async function runWebhookDispatch(limit?: number): Promise<{ sent: number; failed: number; dead: number }> {
  const job = await standaloneJobContext();
  const result = await dispatchWebhooks(job, limit === undefined ? {} : { limit });
  return { sent: result.sent, failed: result.failed, dead: result.dead };
}

/** The `JobHandler` shape `src/jobs/run.ts` registers (B4 owns that registry; see the integration notes). */
export async function runWebhookDispatchJob(job: JobContext): Promise<JobOutcome> {
  const result = await dispatchWebhooks(job);
  return {
    processed: result.created,
    skipped: Math.max(0, result.scanned - result.created),
    posted: result.sent,
    ok: result.dead === 0,
    metadata: {
      disabled: result.disabled,
      created: result.created,
      scanned: result.scanned,
      sent: result.sent,
      failed: result.failed,
      dead: result.dead,
      cursor: result.cursor,
      batchFull: result.scanned === WEBHOOK_DISPATCH_BATCH,
    },
  };
}
