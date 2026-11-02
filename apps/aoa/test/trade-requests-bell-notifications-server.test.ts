import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth, call } = vi.hoisted(() => ({ auth: vi.fn(), call: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/lib/trade-requests/client", () => ({ callTradeRequestService: call }));

import { GET } from "@/app/api/trade-requests/notifications/route";
import { PATCH } from "@/app/api/trade-requests/notifications/[id]/read/route";
import { POST } from "@/app/api/trade-requests/notifications/read-all/route";
import {
  BELL_CLIENT_TIMEOUT_MS, BELL_LIST_LIMIT, fetchBellNotifications, parseBellNotifications, postBellMarkAllRead, postBellMarkRead,
} from "@/lib/trade-requests/notifications-model";

const ID = "6f1c2a52-6d0e-4c4e-9a59-3b7d0f1e2a01";
const ROW = { id: ID, message: "Trade request TR-1 status updated to: Approved", isRead: false, date: "2026-10-17T09:00:00.000Z", requestId: "TR-1" };
const request = (method: string, site: string | null = "same-origin") =>
  new Request("http://127.0.0.1:3161/api/trade-requests/notifications", { method, headers: site ? { "sec-fetch-site": site } : {} });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const signIn = (role: string) => auth.mockResolvedValue({ user: { id: "u1", email: "synthetic@example.test", role } });

describe("bell notification routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", "1");
    signIn("ADVISOR");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("lists up to 100 notifications through the delegated client on the bell channel (AC-60)", async () => {
    call.mockResolvedValue({ ok: true, status: 200, data: { data: [ROW], unreadCount: 3 } });
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true, data: { notifications: [{ id: ID, message: ROW.message, date: ROW.date, isRead: false }], unreadCount: 3 } });
    expect(call).toHaveBeenCalledExactlyOnceWith({
      operation: "notificationsList", method: "GET", path: "/notifications", query: { limit: 100 },
      defaultMessage: "Trade Request notifications could not be checked.", channel: "bell",
    });
  });

  it("answers a failed or malformed load with a bare failure, never service text", async () => {
    call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 500, message: "Trade Request notifications could not be checked." });
    call.mockResolvedValueOnce({ ok: true, status: 200, data: { data: [{ ...ROW, isRead: "no" }], unreadCount: 1 } });
    call.mockResolvedValueOnce({ ok: false, outcome: "not_set_up", message: "Your account is not set up for Trade Requests — contact Operations." });
    for (let index = 0; index < 3; index += 1) {
      const response = await GET(request("GET"));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ ok: false });
    }
  });

  it("marks one notification read; refuses a non-UUID id without calling the service", async () => {
    call.mockResolvedValue({ ok: true, status: 204, data: null });
    const response = await PATCH(request("PATCH"), params(ID));
    expect(await response.json()).toEqual({ ok: true });
    expect(call).toHaveBeenCalledExactlyOnceWith({
      operation: "markNotificationRead", method: "PATCH", path: `/notifications/${ID}/read`,
      defaultMessage: "Trade Request notifications could not be checked.", channel: "bell",
    });
    call.mockClear();
    for (const id of ["../users", "not-a-uuid", `${ID}/x`]) {
      expect((await PATCH(request("PATCH"), params(id))).status).toBe(400);
    }
    expect(call).not.toHaveBeenCalled();
    call.mockResolvedValue({ ok: false, outcome: "failed", status: 404, message: "x" });
    expect((await PATCH(request("PATCH"), params(ID))).status).toBe(502);
  });

  it("marks every notification read", async () => {
    call.mockResolvedValue({ ok: true, status: 204, data: null });
    expect(await (await POST(request("POST"))).json()).toEqual({ ok: true });
    expect(call).toHaveBeenCalledExactlyOnceWith({
      operation: "markAllNotificationsRead", method: "POST", path: "/notifications/read-all",
      defaultMessage: "Trade Request notifications could not be checked.", channel: "bell",
    });
    call.mockResolvedValue({ ok: false, outcome: "failed", status: null, message: "x" });
    expect((await POST(request("POST"))).status).toBe(502);
  });

  it("makes no Trade Request call while the flag is off, or for CLIENT_SERVICE and VIEWER (AC-158)", async () => {
    vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", "0");
    expect((await GET(request("GET"))).status).toBe(404);
    expect((await POST(request("POST"))).status).toBe(404);
    vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", "1");
    for (const role of ["CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY"]) {
      signIn(role);
      expect((await GET(request("GET"))).status).toBe(403);
      expect((await PATCH(request("PATCH"), params(ID))).status).toBe(403);
      expect((await POST(request("POST"))).status).toBe(403);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("refuses signed-out, cross-site and non-same-origin writes before any call", async () => {
    auth.mockResolvedValue(null);
    expect((await GET(request("GET"))).status).toBe(401);
    auth.mockRejectedValue(new Error("auth unavailable"));
    expect((await GET(request("GET"))).status).toBe(503);
    signIn("ADMIN");
    expect((await GET(request("GET", "cross-site"))).status).toBe(403);
    for (const site of ["cross-site", "same-site", "none", null]) {
      expect((await POST(request("POST", site))).status).toBe(403);
      expect((await PATCH(request("PATCH", site), params(ID))).status).toBe(403);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("aborts a hung browser request after the client timeout so it ends as a failure", async () => {
    let controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => controller.signal);
    // Never answers on its own: only the abort signal ends it.
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const calls: Array<[() => Promise<unknown>, unknown]> = [
        [fetchBellNotifications, null], [() => postBellMarkRead(ID), false], [postBellMarkAllRead, false],
      ];
      for (const [start, failure] of calls) {
        controller = new AbortController();
        const pending = start();
        await Promise.resolve();
        controller.abort();
        expect(await pending).toBe(failure);
      }
      expect(timeout).toHaveBeenCalledTimes(3);
      expect(timeout.mock.calls.every(([ms]) => ms === BELL_CLIENT_TIMEOUT_MS)).toBe(true);
      expect(BELL_CLIENT_TIMEOUT_MS).toBe(100_000);
    } finally {
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("parses at most 100 rows and rejects malformed lists", () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({ ...ROW, id: `${index}` }));
    expect(parseBellNotifications({ data: rows, unreadCount: 120 })?.notifications).toHaveLength(BELL_LIST_LIMIT);
    for (const bad of [null, [], { data: [] }, { data: [], unreadCount: -1 }, { data: [{ ...ROW, date: "not a date" }], unreadCount: 1 }]) {
      expect(parseBellNotifications(bad)).toBeNull();
    }
  });
});
