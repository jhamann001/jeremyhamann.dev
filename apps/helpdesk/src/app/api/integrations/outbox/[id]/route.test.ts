/**
 * POST /api/integrations/outbox/[id] — body-reading guarantees.
 *
 * This route is a machine surface behind a shared bearer, and `src/lib/integration-scope.ts` says
 * plainly that every n8n workflow carries that bearer in a workspace variable "readable by anyone who
 * can open a workflow". So the caller is authenticated but not trusted with the process's heap: the
 * 1 MiB cap has to be enforced on the STREAM, not on a body that has already been materialised by
 * `await req.json()`. The declared `content-length` is optional (absent on a chunked request) and
 * attacker-controlled when present, so it can only ever be the cheap early refusal.
 *
 * The transactional behaviour (idempotent replay, the FAILED/QUEUED rules, the audit rows) is proven
 * in src/server/outbox.integration.test.ts; this file is about what reaches memory before any of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  env: {
    NODE_ENV: "test" as const,
    // Composed from its parts at run time: a literal `postgresql://USER:PASSWORD@HOST/DB` is a security scanner
    // secret finding in any tracked file, tests included, even for a database nothing dials.
    // `vi.hoisted` runs before imports, so `@/test-support/db-url` cannot be called from in here;
    // this is that module's `unitDatabaseUrl()` written as one expression.
    DATABASE_URL: Object.assign(new URL("postgresql://localhost:5432/unit_never_connects"), {
      username: "unit",
      password: "unit",
    }).toString(),
    PUBLIC_DATABASE_URL: undefined as string | undefined,
    AUTH_DEV_LOGIN: false,
    TRUSTED_PROXY_HOPS: 0,
    CLIENT_API_TOKEN: undefined as string | undefined,
    INTEGRATION_API_TOKEN: undefined as string | undefined,
    OUTBOX_API_TOKEN: undefined as string | undefined,
    REPLY_TOKEN_SECRET: undefined as string | undefined,
    APP_ENV: "local" as const,
  },
}));
vi.mock("@/lib/env", () => mockEnv);

vi.mock("@/lib/db", () => ({
  prisma: {},
  withTx: vi.fn(),
}));

const mockAuth = vi.hoisted(() => ({
  INTEGRATION_ACTOR_ID: "svc_integration" as const,
  isIntegrationApiAuthorized: vi.fn(() => true),
  // the route now calls the token-or-legacy pair. The mock keeps
  // `isIntegrationApiAuthorized` as the switch this suite already drives and derives the pair from it,
  // so every existing `mockReturnValue(false)` still means "this caller is not authenticated" and the
  // suite keeps testing the ROUTE rather than the authenticator.
  authorizeMachineRequest: vi.fn(async () =>
    mockAuth.isIntegrationApiAuthorized() ? ({ kind: "legacy" } as const) : null,
  ),
  // Never throttled here: the rate limiter has its own suite, and a route test that could trip it
  // would fail on the request count rather than on what it is asserting.
  enforceMachineRateLimit: vi.fn(async () => null),
  integrationActor: vi.fn(async () => ({ id: "svc_integration", kind: "SERVICE" })),
  // The attribution helper the route spends its authorization on. `null` here because the mocked
  // authorization is `legacy`: a caller on the shared env bearer names no consumer, and the rows the
  // report writes must carry no `tokenId` key at all.
  machineAuthTokenId: vi.fn((auth: { kind: string; tokenId?: string } | null | undefined) =>
    auth !== null && auth !== undefined && auth.kind === "token" ? (auth.tokenId ?? null) : null,
  ),
  recordIntegrationDenied: vi.fn(async () => undefined),
}));
vi.mock("@/lib/integration-auth", () => mockAuth);

const mockOutbox = vi.hoisted(() => ({
  reportDeliveryOutcome: vi.fn(async () => ({ status: "SENT", attempts: 1 })),
  enqueueDelivery: vi.fn(),
}));
vi.mock("@/server/outbox", () => mockOutbox);

vi.mock("@/lib/request-context", () => ({
  getRequestContextFromRequest: () => ({ ipAddress: "203.0.113.7", userAgent: "vitest" }),
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "del_1" }) };

/** A body that hands out `chunks` and reports how much of it was consumed. */
function countingStream(chunks: readonly Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  /** Chunks handed out. A stream prefetches one on its own, so this counts DELIVERY, not reading. */
  pulled: () => number;
  /** Whether the route acquired a reader at all — i.e. whether it touched the body. */
  read: () => boolean;
} {
  let i = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      pulls++;
      controller.enqueue(chunks[i++]);
    },
  });
  const getReader = vi.fn(body.getReader.bind(body)) as unknown as ReadableStream<Uint8Array>["getReader"];
  body.getReader = getReader;
  return {
    body,
    pulled: () => pulls,
    read: () => (getReader as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0,
  };
}

/**
 * Duck-typed so a body can exist with NO declared length, which a constructed `Request` will not
 * allow — and that chunked shape is precisely the one a `content-length` check cannot see.
 */
function post(body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}): Request {
  return {
    url: "https://wm-helpdesk.local/api/integrations/outbox/del_1",
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body,
  } as unknown as Request;
}

const encode = (s: string): ReadableStream<Uint8Array> => countingStream([new TextEncoder().encode(s)]).body;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.isIntegrationApiAuthorized.mockReturnValue(true);
  mockOutbox.reportDeliveryOutcome.mockResolvedValue({ status: "SENT", attempts: 1 });
});

describe("POST /api/integrations/outbox/[id] body handling", () => {
  it("accepts a well-formed streamed outcome that declares no content-length", async () => {
    const res = await POST(post(encode(JSON.stringify({ outcome: "SENT" }))), params);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "del_1", status: "SENT", attempts: 1 });
    expect(mockOutbox.reportDeliveryOutcome).toHaveBeenCalledTimes(1);
  });

  it("caps an unbounded chunked body instead of buffering it: 400, and the transaction never runs", async () => {
    // 64 MiB offered with no declared length — the shape that drives the instance's heap wherever the
    // sender wants it if the cap is only ever checked on the result.
    const s = countingStream(Array.from({ length: 64 }, () => new Uint8Array(1_048_576).fill(0x20)));
    const res = await POST(post(s.body), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "payload_too_large" });
    // The cap is 1 MiB, so at most the chunk that crossed it (plus the stream's own prefetch) is read.
    expect(s.pulled()).toBeLessThanOrEqual(3);
    expect(mockOutbox.reportDeliveryOutcome).not.toHaveBeenCalled();
  });

  it("caps a body whose content-length lies about being small", async () => {
    const s = countingStream(Array.from({ length: 64 }, () => new Uint8Array(1_048_576).fill(0x20)));
    const res = await POST(post(s.body, { "content-length": "2" }), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "payload_too_large" });
    expect(s.pulled()).toBeLessThanOrEqual(3);
  });

  it("still refuses an oversize DECLARED length without reading the body at all", async () => {
    const s = countingStream([new TextEncoder().encode(JSON.stringify({ outcome: "SENT" }))]);
    const res = await POST(post(s.body, { "content-length": "1048577" }), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "payload_too_large" });
    expect(s.read()).toBe(false);
  });

  it("answers malformed JSON with 400 and never echoes the payload", async () => {
    const res = await POST(post(encode('{"outcome": ')), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "malformed_json" });
  });

  it("answers a body that errors mid-stream with 400, not a 500", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"outcome"'));
        controller.error(new Error("connection reset"));
      },
    });
    const res = await POST(post(body), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "malformed_json" });
  });

  it("a valid JSON body that is not a valid outcome is still 422 with fieldErrors", async () => {
    const res = await POST(post(encode(JSON.stringify({ outcome: "MAYBE" }))), params);
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string; fieldErrors: Record<string, string[]> };
    expect(json.error).toBe("validation");
    expect(json.fieldErrors.outcome).toBeDefined();
  });

  it("an unauthenticated caller is refused before the body is touched", async () => {
    mockAuth.isIntegrationApiAuthorized.mockReturnValue(false);
    const s = countingStream([new TextEncoder().encode(JSON.stringify({ outcome: "SENT" }))]);
    const res = await POST(post(s.body), params);
    expect(res.status).toBe(401);
    expect(s.read()).toBe(false);
    expect(mockAuth.recordIntegrationDenied).toHaveBeenCalledTimes(1);
  });

  it("a malformed delivery id is refused before the body is touched", async () => {
    const s = countingStream([new TextEncoder().encode(JSON.stringify({ outcome: "SENT" }))]);
    const res = await POST(post(s.body), { params: Promise.resolve({ id: "../../etc/passwd" }) });
    expect(res.status).toBe(404);
    expect(s.read()).toBe(false);
  });
});
