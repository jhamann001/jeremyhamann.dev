import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The serving dispatch (ticket): each operation goes native only with the switch on, while AOA-served and
// when a handler is registered; otherwise the delegated call runs unchanged. Synthetic actors only.
vi.mock("server-only", () => ({}));
const g = vi.hoisted(() => ({ auth: vi.fn(), findUnique: vi.fn(), isAoaServed: vi.fn(), load: vi.fn() }));
vi.mock("@/auth", () => ({ auth: g.auth }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: g.findUnique } } }));
vi.mock("@/lib/trade-requests/serving-state", () => ({ isAoaServed: g.isAoaServed }));
vi.mock("@/lib/trade-requests/native", () => ({ loadNativeHandlers: g.load }));

import {
  callTradeRequestService, resetDelegatedClientState, TRADE_REQUEST_OPERATIONS,
  type TradeRequestCall, type TradeRequestOperation,
} from "@/lib/trade-requests/client";
import { registerNativeHandler, type NativeHandler } from "@/lib/trade-requests/native/registry";

const OPERATIONS = Object.keys(TRADE_REQUEST_OPERATIONS) as TradeRequestOperation[];
const NOT_SET_UP = "Your account is not set up for Trade Requests — contact Operations.";
const native = Object.fromEntries(OPERATIONS.map((op) => [op, vi.fn<NativeHandler>(async () => ({ ok: true, status: 200, data: { native: op } }))])) as Record<TradeRequestOperation, ReturnType<typeof vi.fn<NativeHandler>>>;
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ delegated: true }), { status: 200 }));
const callFor = (operation: TradeRequestOperation, over: Partial<TradeRequestCall> = {}): TradeRequestCall =>
  ({ operation, method: "GET", path: "/requests/counts", defaultMessage: "synthetic_default", ...over });
const nativeCalls = () => OPERATIONS.reduce((sum, op) => sum + native[op].mock.calls.length, 0);

function signedIn(role: string | null) {
  g.auth.mockResolvedValue({ user: { id: "aoa-user-1", email: "pat.person@example.test" } });
  g.findUnique.mockResolvedValue(role === null ? null : { name: "Synthetic Person", role });
}

beforeAll(() => {
  for (const op of OPERATIONS) registerNativeHandler(op, native[op]);
});

beforeEach(() => {
  resetDelegatedClientState();
  vi.clearAllMocks();
  g.load.mockResolvedValue(undefined);
  g.isAoaServed.mockResolvedValue(true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TRADE_REQUEST_API_URL", "https://trade-request.synthetic.invalid");
  vi.stubEnv("TRADE_REQUEST_DELEGATED_AUDIENCE", "");
  vi.stubEnv("TRADE_REQUEST_DELEGATED_LOCAL_KEY", "dispatch-test-key");
  vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
  vi.stubEnv("TRADE_REQUESTS_NATIVE", "1");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  signedIn("OPERATIONS");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("serving dispatch", () => {
  it("delegates all 19 operations while the native switch is off, without reading the serving state", async () => {
    vi.stubEnv("TRADE_REQUESTS_NATIVE", "");
    for (const op of OPERATIONS) expect(await callTradeRequestService(callFor(op))).toEqual({ ok: true, status: 200, data: { delegated: true } });
    expect([OPERATIONS.length, fetchMock.mock.calls.length, nativeCalls(), g.isAoaServed.mock.calls.length]).toEqual([19, 19, 0, 0]);
  });

  it("delegates all 19 operations while the epic master is off", async () => {
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "");
    for (const op of OPERATIONS) await callTradeRequestService(callFor(op));
    expect([fetchMock.mock.calls.length, nativeCalls(), g.isAoaServed.mock.calls.length]).toEqual([19, 0, 0]);
  });

  it("delegates all 19 operations while standalone-served, reading the serving state on every call", async () => {
    g.isAoaServed.mockResolvedValue(false);
    for (const op of OPERATIONS) await callTradeRequestService(callFor(op));
    expect([fetchMock.mock.calls.length, nativeCalls(), g.isAoaServed.mock.calls.length]).toEqual([19, 0, 19]);
  });

  it("answers each registered operation natively while AOA-served, with zero service calls", async () => {
    for (const op of OPERATIONS) expect(await callTradeRequestService(callFor(op))).toEqual({ ok: true, status: 200, data: { native: op } });
    expect(fetchMock).not.toHaveBeenCalled();
    for (const op of OPERATIONS) {
      expect(native[op]).toHaveBeenCalledTimes(1);
      expect(native[op].mock.calls[0][1]).toEqual({ aoaUserId: "aoa-user-1", email: "pat.person@example.test", name: "Synthetic Person", role: "OPERATIONS" });
    }
  });

  it("refuses a native read for any stored role outside ADMIN, OPERATIONS and ADVISOR", async () => {
    for (const role of ["VIEWER", "CLIENT_SERVICE", "HEAD_OF_ADVISORY", null]) {
      signedIn(role);
      expect(await callTradeRequestService(callFor("listRequests"))).toEqual({ ok: false, outcome: "not_set_up", message: NOT_SET_UP });
    }
    expect([nativeCalls(), fetchMock.mock.calls.length]).toEqual([0, 0]);
  });

  it("decides from the current stored AOA role on every call", async () => {
    signedIn("ADVISOR");
    await callTradeRequestService(callFor("lastAllocation"));
    signedIn("OPERATIONS");
    await callTradeRequestService(callFor("lastAllocation"));
    expect(native.lastAllocation.mock.calls.map((c) => c[1].role)).toEqual(["ADVISOR", "OPERATIONS"]);
    expect(g.findUnique).toHaveBeenCalledTimes(2);
  });

  it("turns a throwing handler into the service's internal error, and the bell's fixed line", async () => {
    native.requestDetail.mockRejectedValueOnce(new Error("synthetic"));
    expect(await callTradeRequestService(callFor("requestDetail"))).toEqual({ ok: false, outcome: "failed", status: 500, message: "Internal server error" });
    native.notificationsList.mockRejectedValueOnce(new Error("synthetic"));
    expect(await callTradeRequestService(callFor("notificationsList", { channel: "bell", defaultMessage: "bell_line" }))).toEqual({ ok: false, outcome: "failed", status: 500, message: "bell_line" });
  });

  it("bounds a native call by the operation's per-attempt limit", async () => {
    vi.useFakeTimers();
    native.requestCounts.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = callTradeRequestService(callFor("requestCounts"));
    await vi.advanceTimersByTimeAsync(TRADE_REQUEST_OPERATIONS.requestCounts.timeoutMs);
    expect(await pending).toEqual({ ok: false, outcome: "failed", status: null, message: "timeout of 30000ms exceeded" });
  });

  it("logs one structured line per native call with no person, path or body", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await callTradeRequestService(callFor("clientList", { path: "/clients", body: { secret: "synthetic" } }));
    expect(info).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(info.mock.calls[0][0]));
    expect(Object.keys(line).sort()).toEqual(["durationMs", "event", "operation", "outcome", "status"]);
    expect(line).toMatchObject({ event: "trade_request_native_call", operation: "clientList", outcome: "ok", status: 200 });
    expect(String(info.mock.calls[0][0])).not.toMatch(/example\.test|Synthetic Person|\/clients|secret/);
  });

  it("fails closed with the default message when the native handlers cannot load", async () => {
    g.load.mockRejectedValueOnce(new Error("synthetic"));
    expect(await callTradeRequestService(callFor("listRequests"))).toEqual({ ok: false, outcome: "failed", status: null, message: "synthetic_default" });
    expect([fetchMock.mock.calls.length, nativeCalls()]).toEqual([0, 0]);
  });

  it("refuses a second, different handler for one operation", () => {
    expect(() => registerNativeHandler("listRequests", vi.fn())).toThrow("native handler already registered: listRequests");
    expect(() => registerNativeHandler("listRequests", native.listRequests)).not.toThrow();
  });
});
