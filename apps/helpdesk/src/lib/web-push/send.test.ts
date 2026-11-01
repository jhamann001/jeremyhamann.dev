/**
 * `sendWebPush` — the four outcomes, with the network replaced.
 *
 * The acceptance criterion for the whole wave is that nothing transmits (CONTRACT §0 rule 4), so the
 * first and most important assertion here is the DISABLED one: with the `VAPID_*` keys unset —
 * which is every environment on this branch — the transport is never called at all. The rest drive an
 * injected transport to prove the status mapping, the headers a push service actually requires, and
 * that a 410 prunes the row.
 *
 * NO TEST HERE OPENS A SOCKET OR TOUCHES DNS. The transport is injected and the resolver is stubbed;
 * `global.fetch` is stubbed with a spy that every test asserts was never called, which is the standing
 * proof that the send has no second, unpinned resolution path left in it.
 *
 * `@/lib/web-push/prune` is mocked so this file never reaches a database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs, type LogCapture } from "@/test-support/capture-logs";
import type { PushAddressLookup } from "@/lib/web-push/endpoint";
import type { PushRequest, PushTransport, PushTransportResult } from "@/lib/web-push/transport";

const mockEnv = vi.hoisted(() => {
  const env = {
    NODE_ENV: "test" as const,
    APP_ENV: "local" as const,
    VAPID_PUBLIC_KEY: undefined as string | undefined,
    VAPID_PRIVATE_KEY: undefined as string | undefined,
    VAPID_SUBJECT: undefined as string | undefined,
  };
  return {
    env,
    isWebPushEnabled: (e: typeof env) =>
      e.VAPID_PUBLIC_KEY !== undefined && e.VAPID_PRIVATE_KEY !== undefined && e.VAPID_SUBJECT !== undefined,
  };
});
vi.mock("@/lib/env", () => mockEnv);

const mockPrune = vi.hoisted(() => ({ pruneGoneSubscription: vi.fn(async () => true) }));
vi.mock("@/lib/web-push/prune", () => mockPrune);

const { outcomeForStatus, PUSH_TTL_SECONDS, resetVapidKeyCheck, sendWebPush } = await import("@/lib/web-push/send");

/**
 * The resolver the send-time SSRF guard uses, stubbed. NO TEST HERE TOUCHES DNS: a unit test that
 * resolves `fcm.googleapis.com` is a network call and a flake. Every send below passes this, so the
 * guard is exercised with a known-public answer and the transport assertions stay about the request.
 */
const PUBLIC_LOOKUP: PushAddressLookup = async () => [{ address: "142.250.72.106" }];

const PRIVATE_KEY = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const PUBLIC_KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};
const PAYLOAD = { title: "WM Help Desk", body: "Assigned — HD-1042", url: "/tickets/wm/1042", tag: "wmhd-ASSIGNED-1042" };

function configure(overrides: Partial<typeof mockEnv.env> = {}): void {
  mockEnv.env.VAPID_PUBLIC_KEY = PUBLIC_KEY;
  mockEnv.env.VAPID_PRIVATE_KEY = PRIVATE_KEY;
  mockEnv.env.VAPID_SUBJECT = "mailto:helpdesk@example.invalid";
  Object.assign(mockEnv.env, overrides);
  resetVapidKeyCheck();
}

/** An injected transport that answers one status, and records the request it was handed. */
function stubTransport(status: number) {
  const answer: PushTransport = async (): Promise<PushTransportResult> => ({ status });
  return vi.fn(answer);
}

/** `global.fetch`, purely so every test can assert it was not the thing that sent. */
let fetchSpy: ReturnType<typeof vi.fn>;

/** The structured lines `@/lib/logger` wrote during one test. */
let logs: LogCapture;

beforeEach(() => {
  mockEnv.env.VAPID_PUBLIC_KEY = undefined;
  mockEnv.env.VAPID_PRIVATE_KEY = undefined;
  mockEnv.env.VAPID_SUBJECT = undefined;
  resetVapidKeyCheck();
  mockPrune.pruneGoneSubscription.mockClear();
  fetchSpy = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", fetchSpy);
  // `sendWebPush` writes through `@/lib/logger`, which never calls `console` — `console` is the sink
  // security scanner's CWE-209 rule watches — so a `console.error` spy here would suppress nothing and the JSON
  // would land in the reporter output. Capturing the structured lines both silences them and lets the
  // two "never logs X" tests below assert on the parsed record instead of on `args.join(" ")`.
  logs = captureLogs();
});

afterEach(() => {
  // Nothing may leave this file over the network, by any route.
  expect(fetchSpy).not.toHaveBeenCalled();
  logs.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("outcomeForStatus", () => {
  it("maps the accepted, the gone and everything else", () => {
    for (const s of [200, 201, 202]) expect(outcomeForStatus(s)).toBe("sent");
    for (const s of [404, 410]) expect(outcomeForStatus(s)).toBe("gone");
    for (const s of [400, 401, 403, 413, 429, 500, 502, 503]) expect(outcomeForStatus(s)).toBe("failed");
    // A redirect is not followed and is not special: `node:https` hands back the 3xx as a status.
    for (const s of [301, 302, 307]) expect(outcomeForStatus(s)).toBe("failed");
  });
});

describe("sendWebPush", () => {
  it("is DISABLED and makes no request when the VAPID keys are unset", async () => {
    const transport = stubTransport(201);
    await expect(sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, transport)).resolves.toBe("disabled");
    expect(transport).not.toHaveBeenCalled();
  });

  it("is disabled when only some of the three keys are set", async () => {
    const transport = stubTransport(201);
    configure({ VAPID_SUBJECT: undefined });
    await expect(sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, transport)).resolves.toBe("disabled");
    expect(transport).not.toHaveBeenCalled();
  });

  it("is disabled, without sending, when the configured pair does not match", async () => {
    const transport = stubTransport(201);
    configure({ VAPID_PUBLIC_KEY: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4" });
    await expect(sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, transport)).resolves.toBe("disabled");
    expect(transport).not.toHaveBeenCalled();
  });

  it("POSTs an aes128gcm body with a VAPID Authorization header and a TTL", async () => {
    const transport = stubTransport(201);
    configure();
    await expect(sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, transport)).resolves.toBe("sent");
    expect(transport).toHaveBeenCalledTimes(1);
    const [request] = transport.mock.calls[0] as [PushRequest];
    expect(request.url).toBe(SUB.endpoint);
    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(request.headers["Content-Type"]).toBe("application/octet-stream");
    expect(request.headers.TTL).toBe(String(PUSH_TTL_SECONDS));
    // Split rather than a pattern built from `PUBLIC_KEY`: a constructed regex is a security scanner CWE-185
    // finding even in a test, and the parts assert more than the pattern
    // did — the scheme, a three-segment JWT with non-empty base64url parts, and the exact key.
    const auth = request.headers.Authorization;
    expect(auth.startsWith("vapid t=")).toBe(true);
    const [token, key] = auth.slice("vapid t=".length).split(", k=");
    const segments = (token ?? "").split(".");
    expect(segments).toHaveLength(3);
    for (const segment of segments) expect(segment).toMatch(/^[\w-]+$/);
    expect(key).toBe(PUBLIC_KEY);
    expect(request.timeoutMs).toBeGreaterThan(0);
    // The body is the framed record, not the JSON: the push service never sees the payload.
    expect(request.body.byteLength).toBeGreaterThan(86);
    expect(new TextDecoder().decode(request.body)).not.toContain("HD-1042");
  });

  it("returns gone and prunes the row on 410, and on 404", async () => {
    for (const status of [410, 404]) {
      mockPrune.pruneGoneSubscription.mockClear();
      configure();
      await expect(sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, stubTransport(status))).resolves.toBe("gone");
      expect(mockPrune.pruneGoneSubscription).toHaveBeenCalledWith(SUB.endpoint);
    }
  });

  it("returns failed without pruning on a refusal", async () => {
    configure();
    await expect(sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, stubTransport(429))).resolves.toBe("failed");
    expect(mockPrune.pruneGoneSubscription).not.toHaveBeenCalled();
  });

  it("returns failed, never throws, when the transport reports no answer", async () => {
    configure();
    const transport: PushTransport = async () => ({ status: null, error: "request failed (Error)" });
    await expect(sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, transport)).resolves.toBe("failed");
    expect(mockPrune.pruneGoneSubscription).not.toHaveBeenCalled();
  });

  it("returns failed, never throws, when the transport itself throws", async () => {
    configure();
    const transport: PushTransport = async () => {
      throw new Error("ECONNRESET");
    };
    await expect(sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, transport)).resolves.toBe("failed");
  });

  it("returns failed, never throws, when the subscription keys are unusable", async () => {
    const transport = stubTransport(201);
    configure();
    await expect(sendWebPush({ ...SUB, p256dh: "nonsense!" }, PAYLOAD, PUBLIC_LOOKUP, transport)).resolves.toBe("failed");
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns failed, never throws, when the payload will not fit one record", async () => {
    configure();
    await expect(sendWebPush(SUB, { body: "x".repeat(5000) }, PUBLIC_LOOKUP, stubTransport(201))).resolves.toBe(
      "failed",
    );
  });

  it("still returns gone when the prune itself fails", async () => {
    configure();
    mockPrune.pruneGoneSubscription.mockRejectedValueOnce(new Error("db down"));
    await expect(sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, stubTransport(410))).resolves.toBe("gone");
  });

  it("never logs the push service's reason as a body, only a status", async () => {
    configure();
    await sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, stubTransport(429));
    // Not vacuous: the refusal IS recorded, and what it records is the status and nothing else.
    const refusal = logs.all().find((r) => r.event === "push_service_refused");
    expect(refusal, "the refusal was not logged at all").toBeDefined();
    expect(refusal?.status).toBe(429);
    expect(JSON.stringify(logs.all())).not.toContain("abc123");
  });

  /**
   * The send-time half of the SSRF guard. `subscribePush` refuses these at registration, but the row
   * this function is handed comes back out of the database, so the check runs again at the point of
   * use — a stored endpoint must never become an egress primitive, whatever put it there.
   */
  describe("the SSRF guard at send time", () => {
    it("refuses an internal address without sending, and does not prune", async () => {
      const transport = stubTransport(201);
      configure();
      const outcome = await sendWebPush(
        { ...SUB, endpoint: "https://10.0.0.5:8443/push" },
        PAYLOAD,
        PUBLIC_LOOKUP,
        transport,
      );
      expect(outcome).toBe("failed");
      expect(transport).not.toHaveBeenCalled();
      expect(mockPrune.pruneGoneSubscription).not.toHaveBeenCalled();
    });

    it("refuses a host that is not a browser push service", async () => {
      const transport = stubTransport(201);
      configure();
      const outcome = await sendWebPush(
        { ...SUB, endpoint: "https://attacker.example.com/collect" },
        PAYLOAD,
        PUBLIC_LOOKUP,
        transport,
      );
      expect(outcome).toBe("failed");
      expect(transport).not.toHaveBeenCalled();
    });

    it("refuses an allowlisted name that RESOLVES to a private address — the rebind case", async () => {
      const transport = stubTransport(201);
      configure();
      const rebound: PushAddressLookup = async () => [{ address: "142.250.72.106" }, { address: "10.0.0.5" }];
      await expect(sendWebPush(SUB, PAYLOAD, rebound, transport)).resolves.toBe("failed");
      expect(transport).not.toHaveBeenCalled();
    });

    it("refuses when the resolver fails — 'could not check' is not 'safe'", async () => {
      const transport = stubTransport(201);
      configure();
      const broken: PushAddressLookup = async () => {
        throw new Error("ENOTFOUND");
      };
      await expect(sendWebPush(SUB, PAYLOAD, broken, transport)).resolves.toBe("failed");
      expect(transport).not.toHaveBeenCalled();
    });

    it("never logs the endpoint when it refuses one", async () => {
      configure();
      await sendWebPush(
        { ...SUB, endpoint: "https://attacker.example.com/c4p4b1l1ty-path" },
        PAYLOAD,
        PUBLIC_LOOKUP,
        stubTransport(201),
      );
      // Not vacuous: the refusal IS recorded, with the reason and the service host — never the path,
      // which is the capability (CONTRACT §3.3 rule 2).
      const refusal = logs.all().find((r) => r.event === "endpoint_refused");
      expect(refusal, "the refusal was not logged at all").toBeDefined();
      expect(refusal?.reason).toBeDefined();
      expect(JSON.stringify(logs.all())).not.toContain("c4p4b1l1ty-path");
    });

    /**
     * THE ADDRESS THAT WAS CHECKED IS THE ADDRESS THAT IS USED. The guard passing is not the control
     * on its own: the request handed to the transport must carry the socket's own resolver, built over
     * the SAME resolver the guard used, so a name that answers public once and private a moment later
     * fails the connect rather than being reached.
     */
    it("hands the transport a pinned lookup built over the same resolver", async () => {
      const transport = stubTransport(201);
      configure();
      await expect(sendWebPush(SUB, PAYLOAD, PUBLIC_LOOKUP, transport)).resolves.toBe("sent");
      const [request] = transport.mock.calls[0] as [PushRequest];
      expect(typeof request.lookup).toBe("function");

      const pinned = await new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
        request.lookup("fcm.googleapis.com", { all: false }, (err, address) => resolve({ err, address }));
      });
      expect(pinned.err).toBeNull();
      expect(pinned.address).toBe("142.250.72.106");
    });

    it("the pinned lookup it hands over refuses a rebind at connect time", async () => {
      const transport = stubTransport(201);
      configure();
      // Public for the guard's first call, private for the socket's — the rebinding window.
      let call = 0;
      const rebinding: PushAddressLookup = async () => {
        call += 1;
        return call === 1 ? [{ address: "142.250.72.106" }] : [{ address: "169.254.169.254" }];
      };
      await expect(sendWebPush(SUB, PAYLOAD, rebinding, transport)).resolves.toBe("sent");
      const [request] = transport.mock.calls[0] as [PushRequest];

      const blocked = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        request.lookup("fcm.googleapis.com", { all: true }, (err) => resolve(err));
      });
      expect(blocked).toBeInstanceOf(Error);
      expect(blocked?.name).toBe("PushAddressBlockedError");
    });
  });
});
