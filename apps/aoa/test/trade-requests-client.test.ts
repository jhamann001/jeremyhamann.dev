import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// client.ts imports "server-only" (throws outside an RSC bundle).
vi.mock("server-only", () => ({}));

const g = vi.hoisted(() => {
  const getIdTokenClient = vi.fn();
  const getCredentials = vi.fn();
  const getClient = vi.fn();
  const GoogleAuthMock = vi.fn(function () {
    return { getIdTokenClient, getCredentials, getClient };
  });
  return { getIdTokenClient, getCredentials, getClient, GoogleAuthMock, auth: vi.fn(), findUnique: vi.fn() };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: g.GoogleAuthMock }));
vi.mock("@/auth", () => ({ auth: g.auth }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: g.findUnique } } }));

import {
  callTradeRequestService,
  resetDelegatedClientState,
  TRADE_REQUEST_OPERATIONS,
  type TradeRequestCall,
  type TradeRequestOperation,
} from "@/lib/trade-requests/client";

const API = "https://trade-request.synthetic.invalid";
const AUDIENCE = `${API}/api/aoa`;
const SA = "Gtyiwf9bRptzzwuy-account@example-project.iam.gserviceaccount.com";
const NOT_SET_UP = "Your account is not set up for Trade Requests — contact Operations.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Init = RequestInit & { signal?: AbortSignal };
type Handler = (url: string, init: Init) => Promise<Response>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const empty = (status: number) => new Response("", { status });
const hang: Handler = (_url, init) => new Promise((_, reject) => {
  init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
});
function sequence(...responses: Array<() => Response>): Handler {
  let index = 0;
  return async () => responses[Math.min(index++, responses.length - 1)]();
}

let service: Handler;
let sign: Handler;
let signCount = 0;
const fetchMock = vi.fn(async (input: string | URL, init: Init = {}) => {
  const url = String(input);
  return url.startsWith("https://iamcredentials.googleapis.com/") ? sign(url, init) : service(url, init);
});
const serviceCalls = () => fetchMock.mock.calls.filter(([url]) => !String(url).startsWith("https://iamcredentials"));
const signCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://iamcredentials"));
const headersOf = (call: [string | URL, Init?]) => new Headers((call[1]?.headers ?? {}) as HeadersInit);
const assertionOf = (call: [string | URL, Init?]) => headersOf(call).get("x-aoa-actor-assertion");
const signedPayload = (index: number) =>
  JSON.parse(JSON.parse(String(signCalls()[index][1]?.body)).payload) as Record<string, unknown>;
const decode = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

const call = (over: Partial<TradeRequestCall> = {}) => callTradeRequestService({
  operation: "requestCounts", method: "GET", path: "/requests/counts", defaultMessage: "Failed to load counts", ...over,
});

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

function asAdvisor(role: string | null = "ADVISOR") {
  g.findUnique.mockResolvedValue({ name: "Synthetic Advisor", role });
}

const logs: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  resetDelegatedClientState();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  vi.stubEnv("TRADE_REQUEST_API_URL", API);
  vi.stubEnv("TRADE_REQUEST_DELEGATED_AUDIENCE", "");
  vi.stubEnv("TRADE_REQUEST_DELEGATED_LOCAL_KEY", "");
  signCount = 0;
  sign = async () => json(200, { signedJwt: `signed-${++signCount}` });
  service = async () => json(200, { total: 1 });
  g.auth.mockReset().mockResolvedValue({ user: { id: "synthetic-user-1", email: "Synthetic.Advisor@example.com", name: "Synthetic Advisor" } });
  g.findUnique.mockReset();
  asAdvisor();
  g.getIdTokenClient.mockReset().mockImplementation(async () => ({
    getRequestHeaders: async () => new Headers({ authorization: "Bearer synthetic-id-token" }),
  }));
  g.getCredentials.mockReset().mockImplementation(async () => ({ client_email: SA }));
  g.getClient.mockReset().mockImplementation(async () => ({
    getRequestHeaders: async () => new Headers({ authorization: "Bearer synthetic-access-token" }),
  }));
  logs.length = 0;
  for (const method of ["error", "warn", "info", "log"] as const) {
    logs.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("delegated Trade Request client (TDD §3.3)", () => {
  it("sends the ID token and the actor assertion with the TDD claims", async () => {
    const result = await settle(call());
    expect(result).toEqual({ ok: true, status: 200, data: { total: 1 } });
    expect(serviceCalls()).toHaveLength(1);
    const [url] = serviceCalls()[0];
    expect(String(url)).toBe(`${API}/api/aoa/requests/counts`);
    const headers = headersOf(serviceCalls()[0]);
    expect(headers.get("authorization")).toBe("Bearer synthetic-id-token");
    expect(headers.get("x-aoa-actor-assertion")).toBe("signed-1");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("idempotency-key")).toBeNull();
    expect(g.getIdTokenClient).toHaveBeenCalledWith(AUDIENCE);
    expect(String(signCalls()[0][0])).toContain(`serviceAccounts/${encodeURIComponent(SA)}:signJwt`);
    const payload = signedPayload(0);
    expect(payload).toMatchObject({
      iss: SA, sub: "synthetic.advisor@example.com", aud: AUDIENCE, aoa_role: "ADVISOR", name: "Synthetic Advisor",
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(120);
    expect(String(payload.jti)).toMatch(UUID);
  });

  it("uses TRADE_REQUEST_DELEGATED_AUDIENCE for the ID token and the aud claim", async () => {
    vi.stubEnv("TRADE_REQUEST_DELEGATED_AUDIENCE", "https://aud.synthetic.invalid/api/aoa");
    await settle(call());
    expect(g.getIdTokenClient).toHaveBeenCalledWith("https://aud.synthetic.invalid/api/aoa");
    expect(signedPayload(0).aud).toBe("https://aud.synthetic.invalid/api/aoa");
    expect(String(serviceCalls()[0][0])).toBe(`${API}/api/aoa/requests/counts`);
  });

  it("reads the role from the AOA database on every call", async () => {
    g.findUnique
      .mockResolvedValueOnce({ name: "Synthetic Advisor", role: "ADVISOR" })
      .mockResolvedValueOnce({ name: "Synthetic Advisor", role: "OPERATIONS" });
    await settle(call());
    await settle(call());
    expect(g.findUnique).toHaveBeenCalledTimes(2);
    expect(g.findUnique).toHaveBeenCalledWith({ where: { id: "synthetic-user-1" }, select: { name: true, role: true } });
    expect(signedPayload(0).aoa_role).toBe("ADVISOR");
    expect(signedPayload(1).aoa_role).toBe("OPERATIONS");
  });

  it("reuses an assertion for at most 30 seconds per email and role", async () => {
    await settle(call());
    await vi.advanceTimersByTimeAsync(29_999);
    await settle(call());
    expect(signCalls()).toHaveLength(1);
    expect(assertionOf(serviceCalls()[0])).toBe(assertionOf(serviceCalls()[1]));
    await vi.advanceTimersByTimeAsync(1);
    await settle(call());
    expect(signCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    asAdvisor("OPERATIONS");
    await settle(call());
    expect(signCalls()).toHaveLength(3);
    expect(signedPayload(2).aoa_role).toBe("OPERATIONS");
  });

  it("takes the assertion from the cache anew on every attempt", async () => {
    service = sequence(() => empty(502), () => empty(502), () => json(200, {}));
    expect((await settle(call())).ok).toBe(true);
    expect(serviceCalls()).toHaveLength(3);
    expect(signCalls()).toHaveLength(1);
    expect(new Set(serviceCalls().map(assertionOf))).toEqual(new Set(["signed-1"]));

    fetchMock.mockClear();
    resetDelegatedClientState();
    service = hang;
    await settle(call());
    expect(serviceCalls()).toHaveLength(3);
    expect(signCalls()).toHaveLength(3);
    expect(new Set(serviceCalls().map(assertionOf)).size).toBe(3);
  });

  it("waits 30 seconds per attempt, and 120 seconds for create and resubmit", async () => {
    const cases: Array<[TradeRequestOperation, TradeRequestCall["method"], `/${string}`, number]> = [
      ["requestCounts", "GET", "/requests/counts", 30_000],
      ["createRequest", "POST", "/requests", 120_000],
      ["resubmitRequest", "PUT", "/requests/7f1c", 120_000],
    ];
    service = hang;
    for (const [operation, method, path, limit] of cases) {
      fetchMock.mockClear();
      const pending = call({ operation, method, path });
      await vi.advanceTimersByTimeAsync(limit - 1);
      const signal = serviceCalls()[0][1]?.signal;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      await settle(pending);
    }
  });

  it("retries exactly the epic's repeatable calls, twice", async () => {
    const retried: TradeRequestOperation[] = [
      "listRequests", "requestCounts", "requestDetail", "checklistRead", "clientList", "lastAllocation",
      "clientExclusions", "householdResolve", "notificationsList", "resubmitRequest", "statusChange", "checklistSave",
    ];
    const once: TradeRequestOperation[] = [
      "createRequest", "exportExclusions", "clientsExclusionsLookup", "accountExclusionsLookup", "exclusionSave",
      "markNotificationRead", "markAllNotificationsRead",
    ];
    expect([...retried, ...once].sort()).toEqual(Object.keys(TRADE_REQUEST_OPERATIONS).sort());
    service = hang;
    for (const operation of [...retried, ...once]) {
      fetchMock.mockClear();
      const result = await settle(call({ operation }));
      expect(result).toMatchObject({ ok: false, outcome: "failed", status: null });
      expect([operation, serviceCalls().length]).toEqual([operation, retried.includes(operation) ? 3 : 1]);
    }
  });

  it("retries 502, 503 and 504 but not 500 or 429", async () => {
    for (const status of [502, 503, 504]) {
      fetchMock.mockClear();
      service = async () => empty(status);
      expect(await settle(call())).toEqual({ ok: false, outcome: "failed", status, message: `Request failed with status code ${status}` });
      expect(serviceCalls()).toHaveLength(3);
    }
    for (const status of [500, 429]) {
      fetchMock.mockClear();
      service = async () => empty(status);
      expect(await settle(call())).toMatchObject({ outcome: "failed", status });
      expect(serviceCalls()).toHaveLength(1);
    }
    fetchMock.mockClear();
    service = async () => json(503, { error: "Delegated access is not configured", code: "delegated_not_configured" });
    expect(await settle(call())).toEqual({ ok: false, outcome: "failed", status: 503, message: "Delegated access is not configured" });
    expect(serviceCalls()).toHaveLength(3);
  });

  it("waits 500 ms then 1000 ms between attempts", async () => {
    service = async () => empty(502);
    const pending = call();
    await vi.advanceTimersByTimeAsync(0);
    expect(serviceCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(serviceCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(serviceCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(serviceCalls()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(serviceCalls()).toHaveLength(3);
    await settle(pending);
  });

  it("maps person, role and caller refusals to the AC-22 message", async () => {
    const refusals: Array<[number, string]> = [
      [401, "person_unconfirmed"], [401, "role_unconfirmed"], [403, "role_not_permitted"],
      [401, "caller_unauthenticated"], [403, "caller_not_permitted"],
    ];
    for (const [status, code] of refusals) {
      fetchMock.mockClear();
      service = async () => json(status, { error: "refused", requestId: "r", code });
      expect(await settle(call())).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
      expect(serviceCalls()).toHaveLength(1);
    }
  });

  it("maps a signJwt failure to the AC-22 message without calling the service", async () => {
    const failures: Array<() => void> = [
      () => { sign = async () => json(403, { error: { message: "denied" } }); },
      () => { sign = async () => { throw new TypeError("fetch failed"); }; },
      () => { g.getCredentials.mockImplementation(async () => ({})); },
      () => { g.getIdTokenClient.mockImplementation(async () => { throw new Error("no adc"); }); },
    ];
    for (const fail of failures) {
      resetDelegatedClientState();
      fetchMock.mockClear();
      fail();
      expect(await settle(call())).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
      expect(serviceCalls()).toHaveLength(0);
    }
  });

  it("refuses to sign for the production service from an AOA DEV runtime", async () => {
    const devSa = "trade-request-caller@ops-portal-dev.iam.gserviceaccount.com";
    const production = "https://trade-request-123456789012.us-central1.run.app";
    const cases: Array<[string, string]> = [[production, ""], [API, `${production}/api/aoa`], ["https://trade.jeremyhamann.dev", ""]];
    for (const [apiUrl, audience] of cases) {
      resetDelegatedClientState();
      fetchMock.mockClear();
      vi.stubEnv("TRADE_REQUEST_API_URL", apiUrl);
      vi.stubEnv("TRADE_REQUEST_DELEGATED_AUDIENCE", audience);
      g.getCredentials.mockImplementation(async () => ({ client_email: devSa }));
      expect(await settle(call())).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
      expect(fetchMock).not.toHaveBeenCalled();
    }

    resetDelegatedClientState();
    vi.stubEnv("TRADE_REQUEST_API_URL", "https://trade-request-dev-123456789012.us-central1.run.app");
    vi.stubEnv("TRADE_REQUEST_DELEGATED_AUDIENCE", "");
    expect(await settle(call())).toMatchObject({ ok: true });

    resetDelegatedClientState();
    vi.stubEnv("TRADE_REQUEST_API_URL", production);
    g.getCredentials.mockImplementation(async () => ({ client_email: "Gtyiwf9bRptzzwuy-account@example-project.iam.gserviceaccount.com" }));
    expect(await settle(call())).toMatchObject({ ok: true });
  });

  it("maps a missing session or AOA user to the AC-22 message without calling the service", async () => {
    g.auth.mockResolvedValueOnce(null);
    expect(await settle(call())).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
    g.auth.mockResolvedValueOnce({ user: { id: "synthetic-user-1", name: "No Email" } });
    expect(await settle(call())).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
    g.auth.mockResolvedValueOnce({ user: { email: "synthetic.advisor@example.com", name: "No Id" } });
    expect(await settle(call())).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
    expect(g.findUnique).not.toHaveBeenCalled();
    g.findUnique.mockResolvedValueOnce(null);
    expect(await settle(call())).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
    expect(fetchMock).not.toHaveBeenCalled();
    g.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await settle(call())).toEqual({ ok: false, outcome: "failed", status: null, message: "Failed to load counts" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bell calls always show the fixed default, never the AC-22 message or service text", async () => {
    const message = "Notifications could not be checked.";
    const bell = { operation: "notificationsList" as const, path: "/notifications" as const, channel: "bell" as const, defaultMessage: message };
    service = async () => json(403, { error: "Role has no Trade Request access", code: "role_not_permitted" });
    expect(await settle(call(bell))).toEqual({ ok: false, outcome: "failed", status: 403, message });
    service = async () => json(500, { error: "Internal detail from the service" });
    expect(await settle(call(bell))).toEqual({ ok: false, outcome: "failed", status: 500, message });
    service = async () => empty(502);
    expect(await settle(call(bell))).toEqual({ ok: false, outcome: "failed", status: 502, message });
    service = hang;
    expect(await settle(call(bell))).toEqual({ ok: false, outcome: "failed", status: null, message });
    service = async () => new Response("<html>not json</html>", { status: 200 });
    expect(await settle(call(bell))).toEqual({ ok: false, outcome: "failed", status: 200, message });
    resetDelegatedClientState();
    sign = async () => json(403, {});
    expect(await settle(call(bell))).toEqual({ ok: false, outcome: "failed", status: null, message });
    asAdvisor("VIEWER");
    expect(await settle(call(bell))).toEqual({ ok: false, outcome: "failed", status: null, message });
  });

  it("no response on the last attempt returns the action failure outcome", async () => {
    service = hang;
    let settled = false;
    const pending = call().then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(91_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await pending).toEqual({ ok: false, outcome: "failed", status: null, message: "timeout of 30000ms exceeded" });

    fetchMock.mockClear();
    service = async () => { throw new TypeError("fetch failed"); };
    expect(await settle(call())).toEqual({ ok: false, outcome: "failed", status: null, message: "Network Error" });
    expect(serviceCalls()).toHaveLength(3);

    fetchMock.mockClear();
    resetDelegatedClientState();
    sign = hang;
    expect(await settle(call())).toEqual({ ok: false, outcome: "failed", status: null, message: "timeout of 30000ms exceeded" });
    expect(serviceCalls()).toHaveLength(0);
  });

  it("failure text prefers the service error, then the failure description, then the default", async () => {
    const cases: Array<[Response, number, string]> = [
      [json(409, { error: "Request was modified by another user" }), 409, "Request was modified by another user"],
      [json(400, { error: "Invalid input", details: [{ path: ["tradeAmount"], message: "Required" }] }), 400, "Invalid input: tradeAmount: Required"],
      [json(403, { error: "Insufficient permissions" }), 403, "Insufficient permissions"],
      [empty(500), 500, "Request failed with status code 500"],
      [json(404, { error: "Not found" }), 404, "Not found"],
    ];
    for (const [response, status, message] of cases) {
      fetchMock.mockClear();
      service = async () => response;
      expect(await settle(call())).toEqual({ ok: false, outcome: "failed", status, message });
      expect(serviceCalls()).toHaveLength(1);
    }
  });

  it("sends the JSON body unchanged on every attempt with idempotencyKey in the body", async () => {
    const body = { idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e", notes: "synthetic" };
    service = sequence(() => empty(503), () => empty(503), () => json(200, {}));
    await settle(call({ operation: "resubmitRequest", method: "PUT", path: "/requests/7f1c", body }));
    const bodies = serviceCalls().map(([, init]) => init?.body);
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify(body)]));
    for (const entry of serviceCalls()) {
      expect(headersOf(entry).get("content-type")).toBe("application/json");
      expect(headersOf(entry).get("idempotency-key")).toBeNull();
    }
    fetchMock.mockClear();
    service = async () => empty(503);
    await settle(call({ operation: "createRequest", method: "POST", path: "/requests", body }));
    expect(serviceCalls()).toHaveLength(1);
    expect(serviceCalls()[0][1]?.body).toBe(JSON.stringify(body));
  });

  it("local mode signs both tokens with HS256 as aoa-local@delegated.invalid", async () => {
    vi.stubEnv("TRADE_REQUEST_DELEGATED_LOCAL_KEY", "synthetic-local-key");
    expect((await settle(call())).ok).toBe(true);
    expect(g.getIdTokenClient).not.toHaveBeenCalled();
    expect(g.getCredentials).not.toHaveBeenCalled();
    expect(g.getClient).not.toHaveBeenCalled();
    expect(signCalls()).toHaveLength(0);
    const headers = headersOf(serviceCalls()[0]);
    const bearer = String(headers.get("authorization")).replace(/^Bearer /, "");
    const assertion = String(headers.get("x-aoa-actor-assertion"));
    for (const token of [bearer, assertion]) {
      const [header, payload, signature] = token.split(".");
      expect(decode(header)).toEqual({ alg: "HS256", typ: "JWT" });
      expect(signature).toBe(createHmac("sha256", "synthetic-local-key").update(`${header}.${payload}`).digest("base64url"));
    }
    const bearerClaims = decode(bearer.split(".")[1]);
    expect(bearerClaims).toMatchObject({ iss: "aoa-local@delegated.invalid", email: "aoa-local@delegated.invalid", aud: AUDIENCE });
    expect(bearerClaims.exp - bearerClaims.iat).toBe(120);
    const claims = decode(assertion.split(".")[1]);
    expect(claims).toMatchObject({
      iss: "aoa-local@delegated.invalid", sub: "synthetic.advisor@example.com", aud: AUDIENCE,
      aoa_role: "ADVISOR", name: "Synthetic Advisor",
    });
    expect(claims.jti).toMatch(UUID);
    expect(claims.exp - claims.iat).toBe(120);
  });

  it("ignores the local key in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRADE_REQUEST_DELEGATED_LOCAL_KEY", "synthetic-local-key");
    expect((await settle(call())).ok).toBe(true);
    expect(g.getIdTokenClient).toHaveBeenCalledWith(AUDIENCE);
    expect(signCalls()).toHaveLength(1);
    const headers = headersOf(serviceCalls()[0]);
    expect(headers.get("authorization")).toBe("Bearer synthetic-id-token");
    expect(headers.get("x-aoa-actor-assertion")).toBe("signed-1");
  });

  it("logs no email, name or token", async () => {
    service = async () => json(403, { error: "refused", code: "role_not_permitted" });
    await settle(call());
    resetDelegatedClientState();
    sign = async () => json(403, {});
    await settle(call());
    resetDelegatedClientState();
    sign = async () => json(200, { signedJwt: `signed-${++signCount}` });
    service = hang;
    await settle(call());
    service = async () => json(200, {});
    await settle(call());
    const text = logs.flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n");
    for (const secret of ["synthetic.advisor", "Synthetic Advisor", "synthetic-id-token", "signed-", "trade-request.synthetic.invalid"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[trade-requests-delegated]");
  });

  it("shares one signJwt call across concurrent calls and evicts a failed mint", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    sign = async () => { await gate; return json(200, { signedJwt: `signed-${++signCount}` }); };
    const pending = Array.from({ length: 5 }, () => call());
    await vi.advanceTimersByTimeAsync(0);
    release();
    const results = await settle(Promise.all(pending));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(signCalls()).toHaveLength(1);
    expect(new Set(serviceCalls().map(assertionOf))).toEqual(new Set(["signed-1"]));

    resetDelegatedClientState();
    fetchMock.mockClear();
    sign = async () => json(500, {});
    expect(await settle(call())).toMatchObject({ outcome: "not_set_up" });
    sign = async () => json(200, { signedJwt: "signed-after-failure" });
    expect((await settle(call())).ok).toBe(true);
    expect(signCalls()).toHaveLength(2);
    expect(assertionOf(serviceCalls()[0])).toBe("signed-after-failure");
  });

  it("treats a 2xx body that does not parse as the action failure outcome", async () => {
    service = async () => new Response("<html>gateway page</html>", { status: 200 });
    expect(await settle(call())).toEqual({ ok: false, outcome: "failed", status: 200, message: "Failed to load counts" });
    expect(serviceCalls()).toHaveLength(1);
    fetchMock.mockClear();
    service = async () => new Response("", { status: 200 });
    expect(await settle(call())).toEqual({ ok: true, status: 200, data: null });
  });

  it("never sends a role other than ADMIN, OPERATIONS or ADVISOR to the service", async () => {
    // auth.ts normalizes the session role, so a legacy HEAD_OF_ADVISORY can only
    // appear in the stored row; the stored-role check is what refuses it.
    for (const role of ["HEAD_OF_ADVISORY", "CLIENT_SERVICE", "VIEWER", "", null]) {
      asAdvisor(role);
      expect(await settle(call())).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    asAdvisor("OPERATIONS");
    await settle(call());
    expect(serviceCalls()).toHaveLength(1);
    expect(signedPayload(0).aoa_role).toBe("OPERATIONS");
    fetchMock.mockClear();
    for (const path of [
      "/requests/%2e%2e/users", "/requests/%2E%2e", "/requests/../x", "/requests/.%2e/users", "/requests/%2e./users",
      "/requests//users", "//evil.invalid/requests", "/requests/counts?all=true", "/requests/x?",
    ] as const) {
      await expect(call({ path })).rejects.toThrow("invalid_trade_request_path");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
