/**
 * Unit tests for the webhook dispatcher's pure surface.
 *
 * Nothing here touches the database or the network: the DB-gated behaviour is in
 * `webhook-dispatch.integration.test.ts`, and the transport is injected there. What is pinned here is
 * the arithmetic an operator's expectations rest on — how long a retry waits, when a delivery gives
 * up, and that a receiver's error text never reaches the ledger unsanitized.
 */
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { describe, expect, it } from "vitest";
import { WAVE_B_LIMITS } from "@/types/domain";
import { deriveEndpointSigningKey, sha256Hex, signWebhookBody } from "@/lib/webhook-signing";
import {
  DELIVERY_ID_ENDPOINT_CHARS,
  WEBHOOK_BACKOFF_BASE_MS,
  WEBHOOK_BACKOFF_MAX_MS,
  WEBHOOK_DISPATCH_BATCH,
  WEBHOOK_DISPATCH_CURSOR,
  WEBHOOK_ERROR_MAX_CHARS,
  WEBHOOK_SEND_LIMIT,
  WEBHOOK_TIMEOUT_MS,
  WebhookAddressBlockedError,
  backoffMs,
  classifyAttempt,
  deliveryError,
  deliveryHeaders,
  deliveryIdFor,
  pinnedLookup,
  signingKeyFor,
  subscribedActions,
  webhookScanWhere,
} from "@/jobs/webhook-dispatch";

describe("constants", () => {
  it("names its own cursor, distinct from the event-alert job's", () => {
    expect(WEBHOOK_DISPATCH_CURSOR).toBe("webhook-dispatch");
  });

  it("bounds a run so one unreachable endpoint cannot hold a schedule open", () => {
    expect(WEBHOOK_SEND_LIMIT).toBeLessThanOrEqual(WEBHOOK_DISPATCH_BATCH);
    expect(WEBHOOK_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(WEBHOOK_SEND_LIMIT * WEBHOOK_TIMEOUT_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe("backoffMs", () => {
  it("doubles from the base and is capped", () => {
    expect(backoffMs(1)).toBe(WEBHOOK_BACKOFF_BASE_MS);
    expect(backoffMs(2)).toBe(WEBHOOK_BACKOFF_BASE_MS * 2);
    expect(backoffMs(3)).toBe(WEBHOOK_BACKOFF_BASE_MS * 4);
    expect(backoffMs(4)).toBe(WEBHOOK_BACKOFF_BASE_MS * 8);
    expect(backoffMs(100)).toBe(WEBHOOK_BACKOFF_MAX_MS);
  });

  it("treats a zero or negative attempt count as the first wait, never as no wait", () => {
    expect(backoffMs(0)).toBe(WEBHOOK_BACKOFF_BASE_MS);
    expect(backoffMs(-5)).toBe(WEBHOOK_BACKOFF_BASE_MS);
  });

  it("reaches the cap before the attempt limit, so the last retries are not months apart", () => {
    expect(backoffMs(WAVE_B_LIMITS.webhookMaxAttempts)).toBeLessThanOrEqual(WEBHOOK_BACKOFF_MAX_MS);
  });

  it("spans a useful window across the whole attempt budget", () => {
    let total = 0;
    for (let n = 1; n < WAVE_B_LIMITS.webhookMaxAttempts; n++) total += backoffMs(n);
    // Long enough to ride out a deploy of the receiving system, short enough to matter the same day.
    expect(total).toBeGreaterThan(30 * 60_000);
    expect(total).toBeLessThan(48 * 60 * 60_000);
  });
});

describe("deliveryIdFor", () => {
  it("is stable for the same (endpoint, seq), so a re-scan produces the id it produced before", () => {
    expect(deliveryIdFor("ckendpoint000001", BigInt(4211))).toBe(deliveryIdFor("ckendpoint000001", BigInt(4211)));
  });

  it("differs per endpoint and per seq", () => {
    const a = deliveryIdFor("ckendpoint000001", BigInt(1));
    const b = deliveryIdFor("ckendpoint000002", BigInt(1));
    const c = deliveryIdFor("ckendpoint000001", BigInt(2));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("stays inside the shape the audit ledger will store verbatim", () => {
    expect(deliveryIdFor("ckendpoint000001", BigInt(4211))).toMatch(/^[A-Za-z0-9_]{1,64}$/);
  });

  it("does not collide when two endpoint ids share a suffix", () => {
    // The old `endpointId.slice(-12)` produced ONE id for both of these, and
    // `createMany({ skipDuplicates: true })` would then drop the second endpoint's delivery in silence.
    const shared = "0123456789ab";
    const a = deliveryIdFor(`ckendpointAAAA${shared}`, BigInt(4211));
    const b = deliveryIdFor(`ckendpointBBBB${shared}`, BigInt(4211));
    expect(a).not.toBe(b);
  });

  it("derives its endpoint half from the WHOLE id, not a slice of it", () => {
    const endpointId = "ckendpoint000001";
    expect(deliveryIdFor(endpointId, BigInt(4211))).toBe(
      `wdl_${BigInt(4211).toString(36)}_${sha256Hex(endpointId).slice(0, DELIVERY_ID_ENDPOINT_CHARS)}`,
    );
  });
});

describe("subscribedActions", () => {
  it("is the union across endpoints, narrowed to the allowlist", () => {
    const actions = subscribedActions([
      { id: "a", url: "https://a.example.com", events: ["TICKET_CREATED", "TICKET_STATUS_CHANGED"] },
      { id: "b", url: "https://b.example.com", events: ["TICKET_CREATED", "COMMENT_ADDED_INTERNAL"] },
    ]);
    expect(new Set(actions)).toEqual(new Set(["TICKET_CREATED", "TICKET_STATUS_CHANGED"]));
  });

  it("is empty when nothing is subscribed", () => {
    expect(subscribedActions([])).toEqual([]);
    expect(subscribedActions([{ id: "a", url: "https://a.example.com", events: [] }])).toEqual([]);
  });
});

describe("webhookScanWhere", () => {
  it("reads strictly after the cursor, and only the named actions", () => {
    const where = webhookScanWhere(BigInt(10), ["TICKET_CREATED"]);
    expect(where).toEqual({ seq: { gt: BigInt(10) }, action: { in: ["TICKET_CREATED"] } });
  });
});

describe("deliveryError", () => {
  it("bounds a receiver's text", () => {
    expect(deliveryError("x".repeat(5000))).toHaveLength(WEBHOOK_ERROR_MAX_CHARS);
  });

  it("sanitizes it — a receiver could echo client data back at us", () => {
    expect(deliveryError("rejected for account 123456789012")).not.toContain("123456789012");
  });
});

describe("classifyAttempt", () => {
  const NOW = new Date("2026-09-20T12:00:00.000Z");

  it("treats every 2xx as success and stamps sentAt", () => {
    for (const status of [200, 201, 202, 204, 299]) {
      const verdict = classifyAttempt({ status }, 0, NOW);
      expect(verdict.outcome, String(status)).toBe("sent");
      expect(verdict.status).toBe("SENT");
      expect(verdict.action).toBe("WEBHOOK_DELIVERY_SENT");
      expect(verdict.attempts).toBe(1);
      expect(verdict.sentAt).toEqual(NOW);
      expect(verdict.nextAttemptAt).toBeNull();
      expect(verdict.lastError).toBeNull();
    }
  });

  it("treats a redirect as a failure — the transport refuses to follow one on purpose", () => {
    const verdict = classifyAttempt({ status: 301 }, 0, NOW);
    expect(verdict.outcome).toBe("failed");
    expect(verdict.lastError).toBe("HTTP 301");
  });

  it("schedules the next attempt at the backoff and records the status", () => {
    const verdict = classifyAttempt({ status: 500 }, 2, NOW);
    expect(verdict.outcome).toBe("failed");
    expect(verdict.status).toBe("FAILED");
    expect(verdict.action).toBe("WEBHOOK_DELIVERY_FAILED");
    expect(verdict.attempts).toBe(3);
    expect(verdict.responseStatus).toBe(500);
    expect(verdict.sentAt).toBeNull();
    expect(verdict.nextAttemptAt).toEqual(new Date(NOW.getTime() + backoffMs(3)));
  });

  it("gives up exactly at the attempt cap, and stops scheduling", () => {
    const last = classifyAttempt({ status: 503 }, WAVE_B_LIMITS.webhookMaxAttempts - 1, NOW);
    expect(last.outcome).toBe("dead");
    expect(last.status).toBe("DEAD");
    expect(last.action).toBe("WEBHOOK_DELIVERY_DEAD");
    expect(last.attempts).toBe(WAVE_B_LIMITS.webhookMaxAttempts);
    expect(last.nextAttemptAt).toBeNull();

    const oneBefore = classifyAttempt({ status: 503 }, WAVE_B_LIMITS.webhookMaxAttempts - 2, NOW);
    expect(oneBefore.outcome).toBe("failed");
    expect(oneBefore.nextAttemptAt).not.toBeNull();
  });

  it("records a transport-level failure with no status", () => {
    const verdict = classifyAttempt({ status: null, error: "timed out" }, 0, NOW);
    expect(verdict.outcome).toBe("failed");
    expect(verdict.responseStatus).toBeNull();
    expect(verdict.lastError).toBe("timed out");
  });

  it("sanitizes and bounds whatever the receiver said", () => {
    const verdict = classifyAttempt({ status: null, error: `rejected for account 123456789012 ${"x".repeat(9000)}` }, 0, NOW);
    expect(verdict.lastError).not.toContain("123456789012");
    expect(verdict.lastError?.length).toBeLessThanOrEqual(WEBHOOK_ERROR_MAX_CHARS);
  });

  it("succeeds on a single attempt even when the cap is one", () => {
    expect(classifyAttempt({ status: 200 }, 0, NOW, 1).outcome).toBe("sent");
    expect(classifyAttempt({ status: 500 }, 0, NOW, 1).outcome).toBe("dead");
  });
});

describe("deliveryHeaders", () => {
  it("carries the four documented headers and a reproducible signature", () => {
    const body = '{"id":"wdl_1"}';
    const headers = deliveryHeaders("k".repeat(64), body, 1_789_000_000, "wdl_1", "TICKET_CREATED");
    expect(headers).toEqual({
      "X-WMHD-Signature": signWebhookBody("k".repeat(64), body, 1_789_000_000),
      "X-WMHD-Timestamp": "1789000000",
      "X-WMHD-Delivery": "wdl_1",
      "X-WMHD-Event": "TICKET_CREATED",
    });
  });

  it("does not put the signing key anywhere in the headers", () => {
    const key = "k".repeat(64);
    const headers = deliveryHeaders(key, '{"id":"wdl_1"}', 1, "wdl_1", "TICKET_CREATED");
    expect(JSON.stringify(headers)).not.toContain(key);
  });
});

describe("signingKeyFor", () => {
  const APP_KEY = "app-held-key-at-least-32-characters-long";
  const SALT = "a".repeat(64);

  it("never signs with the value stored on the row", () => {
    // The row used to BE the signing key: anything that could read that one column could forge a
    // signature every receiver would accept. It is a salt now, and signing needs the app-held key too.
    expect(signingKeyFor({ secretHash: SALT }, APP_KEY)).not.toBe(SALT);
  });

  it("is the derived key for that salt", () => {
    expect(signingKeyFor({ secretHash: SALT }, APP_KEY)).toBe(deriveEndpointSigningKey(APP_KEY, SALT));
  });

  it("is null when the app-held key is unset, so the caller fails closed rather than signing anyway", () => {
    expect(signingKeyFor({ secretHash: SALT }, undefined)).toBeNull();
    expect(signingKeyFor({ secretHash: SALT }, "")).toBeNull();
  });
});

describe("pinnedLookup", () => {
  /** A resolver that answers with whatever the test names, without touching DNS. */
  function resolver(addresses: readonly string[]): (
    hostname: string,
    options: LookupAllOptions,
    callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ) => void {
    return (_hostname, _options, callback) => {
      callback(
        null,
        addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      );
    };
  }

  function resolve(
    addresses: readonly string[],
    all = false,
  ): Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[] }> {
    return new Promise((done) => {
      pinnedLookup(resolver(addresses))("hooks.example.com", { all }, (err, address) => done({ err, address }));
    });
  }

  it("passes a public answer through, so an ordinary send still connects", async () => {
    const { err, address } = await resolve(["93.184.216.34"]);
    expect(err).toBeNull();
    expect(address).toBe("93.184.216.34");
  });

  it("returns every answer when the socket asked for all of them", async () => {
    const { err, address } = await resolve(["93.184.216.34", "93.184.216.35"], true);
    expect(err).toBeNull();
    expect(address).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
  });

  it("fails the CONNECT when the name now answers private — the rebinding case", async () => {
    // This is the half that was missing: the guard resolved, and then `fetch` resolved again and
    // connected to whatever the second answer said.
    const { err } = await resolve(["10.0.0.5"]);
    expect(err).toBeInstanceOf(WebhookAddressBlockedError);
  });

  it("fails the connect on the metadata address, however it is reached", async () => {
    expect((await resolve(["169.254.169.254"])).err).toBeInstanceOf(WebhookAddressBlockedError);
    expect((await resolve(["::ffff:169.254.169.254"])).err).toBeInstanceOf(WebhookAddressBlockedError);
  });

  it("refuses a mixed answer outright — happy-eyeballs could take either one", async () => {
    const { err } = await resolve(["93.184.216.34", "127.0.0.1"], true);
    expect(err).toBeInstanceOf(WebhookAddressBlockedError);
  });

  it("refuses an empty answer rather than treating 'no answer' as 'no forbidden answer'", async () => {
    expect((await resolve([])).err).toBeInstanceOf(WebhookAddressBlockedError);
  });

  it("passes a resolver failure back as a failure", async () => {
    const boom: NodeJS.ErrnoException = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    const err = await new Promise((done) => {
      pinnedLookup((_h, _o, callback) => callback(boom, []))("hooks.example.com", { all: false }, (e) => done(e));
    });
    expect(err).toBe(boom);
  });
});
