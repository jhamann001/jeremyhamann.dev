import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ call: vi.fn(), enabled: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/trade-requests/client", () => ({ callTradeRequestService: m.call }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.enabled }));
vi.mock("@/auth", () => ({ auth: m.auth }));

import { readTradeRequestCounts, readTradeRequestPage } from "@/lib/trade-requests/queue";
import { GET as getRequests } from "@/app/api/trade-requests/requests/route";
import { GET as getCounts } from "@/app/api/trade-requests/counts/route";

const PAGE = { data: [{ id: "REQ-1", clientName: "A", clientNames: ["A"], status: "Approved" }], nextCursor: "cursor-1" };
const COUNTS = { total: 112, pendingReview: 20, needsInfo: 19, approved: 37 };
const req = (path: string, headers: Record<string, string> = {}) => new Request(`http://127.0.0.1:3131${path}`, { headers });

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
  m.auth.mockResolvedValue({ user: { role: "ADVISOR", email: "avery@example.com" } });
});

describe("queue reads through the delegated client", () => {
  it("asks for the newest 50, passing the search, and keeps the cursor (AC-4, AC-5)", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: PAGE });
    const result = await readTradeRequestPage({ q: "  aufderhar  " });
    expect(m.call).toHaveBeenCalledWith(expect.objectContaining({
      operation: "listRequests", method: "GET", path: "/requests",
      query: { limit: 50, before: undefined, q: "aufderhar" }, defaultMessage: "Failed to load requests",
    }));
    expect(result).toEqual({ ok: true, data: { data: [expect.objectContaining({ id: "REQ-1" })], nextCursor: "cursor-1" } });
  });

  it("Load more asks for the next 50 older than the cursor with the same search (AC-28)", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: [], nextCursor: null } });
    expect(await readTradeRequestPage({ before: "cursor-1", q: "park" })).toEqual({ ok: true, data: { data: [], nextCursor: null } });
    expect(m.call.mock.calls[0][0].query).toEqual({ limit: 50, before: "cursor-1", q: "park" });
    expect(m.call.mock.calls[0][0].defaultMessage).toBe("Failed to load more requests");
  });

  it("passes the client's failure text and not-set-up outcome through unchanged (AC-79, AC-22)", async () => {
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 500, message: "Request failed with status code 500" });
    expect(await readTradeRequestPage({})).toEqual({ ok: false, outcome: "failed", message: "Request failed with status code 500" });
    m.call.mockResolvedValueOnce({ ok: false, outcome: "not_set_up", message: "Your account is not set up for Trade Requests — contact Operations." });
    expect(await readTradeRequestPage({})).toMatchObject({ ok: false, outcome: "not_set_up" });
  });

  it("an unreadable list is the default failure", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { rows: [] } });
    expect(await readTradeRequestPage({})).toEqual({ ok: false, outcome: "failed", message: "Failed to load requests" });
  });

  it("counts read the firm-wide totals (AC-31)", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: COUNTS });
    expect(await readTradeRequestCounts()).toEqual({ ok: true, data: COUNTS });
    expect(m.call).toHaveBeenCalledWith(expect.objectContaining({ operation: "requestCounts", method: "GET", path: "/requests/counts" }));
    m.call.mockResolvedValue({ ok: true, status: 200, data: { total: 3 } });
    expect(await readTradeRequestCounts()).toMatchObject({ ok: false, outcome: "failed" });
  });
});

describe("workspace JSON routes", () => {
  it("flag off: both routes are not found and never call the service", async () => {
    m.enabled.mockReturnValue(false);
    expect((await getRequests(req("/api/trade-requests/requests"))).status).toBe(404);
    expect((await getCounts(req("/api/trade-requests/counts"))).status).toBe(404);
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.call).not.toHaveBeenCalled();
  });

  it("refuses no session, CLIENT_SERVICE, VIEWER and cross-site requests", async () => {
    m.auth.mockResolvedValueOnce(null);
    expect((await getRequests(req("/api/trade-requests/requests"))).status).toBe(401);
    for (const role of ["CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY"]) {
      m.auth.mockResolvedValueOnce({ user: { role } });
      expect((await getCounts(req("/api/trade-requests/counts"))).status).toBe(403);
    }
    expect((await getRequests(req("/api/trade-requests/requests", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(m.call).not.toHaveBeenCalled();
  });

  it("rejects any URL parameter (the search never travels in the URL) and bad or oversized headers", async () => {
    for (const path of ["/api/trade-requests/requests?limit=500", "/api/trade-requests/requests?q=aufderhar", "/api/trade-requests/requests?before=c1"]) {
      expect((await getRequests(req(path))).status).toBe(400);
    }
    for (const headers of <Array<Record<string, string>>>[{ "x-trade-requests-search": "x".repeat(201) }, { "x-trade-requests-search": "%E0%A4%A" }, { "x-trade-requests-before": "c".repeat(201) }]) {
      expect((await getRequests(req("/api/trade-requests/requests", headers))).status).toBe(400);
    }
    expect((await getCounts(req("/api/trade-requests/counts?x=1"))).status).toBe(400);
    expect(m.call).not.toHaveBeenCalled();
  });

  it("answers every workspace role with the read's outcome, uncached", async () => {
    for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"]) {
      m.auth.mockResolvedValue({ user: { role } });
      m.call.mockResolvedValueOnce({ ok: true, status: 200, data: PAGE });
      const response = await getRequests(req("/api/trade-requests/requests", {
        "x-trade-requests-search": encodeURIComponent("Emory & Chaim"), "x-trade-requests-before": "cursor-1",
      }));
      expect(m.call.mock.lastCall![0].query).toEqual({ limit: 50, before: "cursor-1", q: "Emory & Chaim" });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({ ok: true, data: { nextCursor: "cursor-1" } });
    }
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: null, message: "timeout of 30000ms exceeded" });
    expect(await (await getCounts(req("/api/trade-requests/counts"))).json()).toEqual({ ok: false, outcome: "failed", message: "timeout of 30000ms exceeded" });
  });
});
