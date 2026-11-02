import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ticket: the drift read and override routes behind the Drift screens.
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  findUnique: vi.fn(),
  served: vi.fn(async () => true),
  paused: vi.fn(() => false),
  history: vi.fn(),
  run: vi.fn(),
  overrides: vi.fn(),
  analyze: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: m.findUnique } } }));
vi.mock("@/lib/trade-requests/serving-state", () => ({ isAoaServed: m.served }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: m.paused }));
vi.mock("@/lib/trade-requests/pg-compat", () => ({ appPool: async () => ({ query: m.poolQuery, transaction: vi.fn() }) }));
vi.mock("@/lib/trade-requests/drift/position-drift-accounts-persistence", async (orig) => ({
  ...(await orig<typeof import("@/lib/trade-requests/drift/position-drift-accounts-persistence")>()),
  fetchAccountDriftHistory: m.history,
  fetchAccountDriftRun: m.run,
}));
vi.mock("@/lib/trade-requests/drift/drift-status-overrides", async (orig) => ({
  ...(await orig<typeof import("@/lib/trade-requests/drift/drift-status-overrides")>()),
  fetchActiveOverrides: m.overrides,
}));
vi.mock("@/lib/trade-requests/drift/drift-exclusion-analysis", () => ({ analyzeExclusionOverlapForRun: m.analyze }));
vi.mock("@/lib/trade-requests/drift/overrides-service", () => ({ saveDriftOverride: m.save, clearDriftOverride: m.clear }));

import { GET as history } from "@/app/api/trade-requests/drift/history/route";
import { GET as runDetail } from "@/app/api/trade-requests/drift/runs/[runDateLocal]/route";
import { GET as latest } from "@/app/api/trade-requests/drift/runs/latest/route";
import { GET as allowList } from "@/app/api/trade-requests/drift/allow-list/route";
import { GET as overlap, HEAD as overlapHead } from "@/app/api/trade-requests/drift/exclusion-overlap/route";
import { PUT, DELETE } from "@/app/api/trade-requests/drift/overrides/[accountId]/route";

const BASE = "https://ops-portal.example.test/api/trade-requests/drift";
const read = (path: string, site = "same-origin") => new Request(`${BASE}${path}`, { headers: { "sec-fetch-site": site } });
const write = (method: "PUT" | "DELETE", body?: unknown, site = "same-origin") =>
  new Request(`${BASE}/overrides/ACCT-1`, {
    method,
    headers: { "sec-fetch-site": site, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const acct = { params: Promise.resolve({ accountId: "ACCT-1" }) };
const date = (runDateLocal: string) => ({ params: Promise.resolve({ runDateLocal }) });
const as = (role: string) => {
  m.auth.mockResolvedValue({ user: { id: "u-1" } });
  m.findUnique.mockResolvedValue({ role, email: "ops@example.test", name: "Ops Person" });
};
const VALID = { reason: "intentional_cash", note: "client holds cash", expiresOn: "2026-12-31" };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE = "1";
  delete process.env.TRADE_REQUEST_DRIFT_EXCLUSION_OVERLAP_ENABLED;
  m.served.mockResolvedValue(true);
  m.paused.mockReturnValue(false);
  m.history.mockResolvedValue([{ accountId: "ACCT-1", status: "out" }, { accountId: "ACCT-2", status: "in" }]);
  m.overrides.mockResolvedValue(new Map([["ACCT-1", { reason: "intentional_cash", note: "", expiresOn: null, setByName: "Ops Person", setAt: "2026-05-13T00:00:00.000Z" }]]));
  m.save.mockResolvedValue({ reason: "intentional_cash", note: "client holds cash", expiresOn: "2026-12-31", setByName: "Ops Person", setAt: "2026-05-13T00:00:00.000Z" });
  m.clear.mockResolvedValue(true);
  as("ADVISOR");
});
afterEach(() => {
  delete process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE;
});

describe("drift routes", () => {
  it("refuses every route with 404 while the epic switch is off", async () => {
    delete process.env.EPIC_TRADE_REQUESTS_BACKEND_MOVE;
    as("ADMIN");
    expect((await history(read("/history"))).status).toBe(404);
    expect((await PUT(write("PUT", VALID), acct)).status).toBe(404);
    expect(m.save).not.toHaveBeenCalled();
  });

  it("refuses reads and override writes with 404 while Trade Requests are standalone-served", async () => {
    m.served.mockResolvedValue(false);
    as("ADMIN");
    expect((await history(read("/history"))).status).toBe(404);
    expect((await PUT(write("PUT", VALID), acct)).status).toBe(404);
    expect((await DELETE(write("DELETE"), acct)).status).toBe(404);
    expect(m.save).not.toHaveBeenCalled();
    expect(m.clear).not.toHaveBeenCalled();
  });

  it("serves an ADVISOR the live history with each account's active override attached", async () => {
    const res = await history(read("/history?days=7"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    const body = await res.json();
    expect(body.days).toBe(7);
    expect(body.runs.map((r: { accountId: string; override: unknown }) => [r.accountId, r.override === null])).toEqual([["ACCT-1", false], ["ACCT-2", true]]);
    expect(m.overrides).toHaveBeenCalledWith(expect.anything(), ["ACCT-1", "ACCT-2"]);
  });

  it("refuses CLIENT_SERVICE and VIEWER reads with 403", async () => {
    for (const role of ["CLIENT_SERVICE", "VIEWER"]) {
      as(role);
      expect((await history(read("/history"))).status).toBe(403);
    }
    expect(m.history).not.toHaveBeenCalled();
  });

  it("refuses override saves and clears by ADVISOR, CLIENT_SERVICE and VIEWER with 403", async () => {
    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER"]) {
      as(role);
      expect((await PUT(write("PUT", VALID), acct)).status).toBe(403);
      expect((await DELETE(write("DELETE"), acct)).status).toBe(403);
    }
    expect(m.save).not.toHaveBeenCalled();
    expect(m.clear).not.toHaveBeenCalled();
  });

  it("saves an OPERATIONS user's override with their identity and name", async () => {
    as("OPERATIONS");
    const res = await PUT(write("PUT", VALID), acct);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: "ACCT-1", override: expect.objectContaining({ setByName: "Ops Person" }) });
    expect(m.save).toHaveBeenCalledWith(
      { aoaUserId: "u-1", email: "ops@example.test", name: "Ops Person", role: "OPERATIONS" },
      "ACCT-1",
      { reason: "intentional_cash", note: "client holds cash", expiresOn: "2026-12-31" },
    );
  });

  it("clears an ADMIN user's override and reports whether a row was removed", async () => {
    as("ADMIN");
    const res = await DELETE(write("DELETE"), acct);
    expect(await res.json()).toEqual({ accountId: "ACCT-1", cleared: true });
    expect(m.clear).toHaveBeenCalledWith(expect.objectContaining({ aoaUserId: "u-1", name: "Ops Person" }), "ACCT-1");
  });

  it("rejects an invalid reason and an 'other' reason without a note with 400", async () => {
    as("ADMIN");
    expect((await PUT(write("PUT", { reason: "because" }), acct)).status).toBe(400);
    const res = await PUT(write("PUT", { reason: "other", note: "  " }), acct);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Validation failed");
    expect(m.save).not.toHaveBeenCalled();
  });

  it("refuses a write without a same-origin fetch and any cross-site read with 403", async () => {
    as("ADMIN");
    expect((await PUT(write("PUT", VALID, "none"), acct)).status).toBe(403);
    expect((await history(read("/history", "cross-site"))).status).toBe(403);
  });

  it("refuses writes with 503 while application writes are paused", async () => {
    as("ADMIN");
    m.paused.mockReturnValue(true);
    expect((await PUT(write("PUT", VALID), acct)).status).toBe(503);
    expect(m.save).not.toHaveBeenCalled();
  });

  it("answers 401 without a session and 503 when the session lookup fails", async () => {
    m.auth.mockResolvedValue(null);
    expect((await history(read("/history"))).status).toBe(401);
    m.auth.mockRejectedValue(new Error("down"));
    expect((await history(read("/history"))).status).toBe(503);
  });

  it("validates the run date, answers 404 for a missing run and returns a found run as-is", async () => {
    expect((await runDetail(read("/runs/2026-02-30"), date("2026-02-30"))).status).toBe(400);
    m.run.mockResolvedValueOnce(null);
    const missing = await runDetail(read("/runs/2026-05-12"), date("2026-05-12"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "drift run not found", runDateLocal: "2026-05-12" });
    m.run.mockResolvedValueOnce({ runDateLocal: "2026-05-13", accounts: [] });
    expect(await (await runDetail(read("/runs/2026-05-13"), date("2026-05-13"))).json()).toEqual({ runDateLocal: "2026-05-13", accounts: [] });
  });

  it("returns the latest live run, or 404 when there is none", async () => {
    m.poolQuery.mockResolvedValueOnce({ rows: [{ latest: null }], rowCount: 1 });
    expect((await latest(read("/runs/latest"))).status).toBe(404);
    m.poolQuery.mockResolvedValueOnce({ rows: [{ latest: "2026-05-13" }], rowCount: 1 });
    m.run.mockResolvedValueOnce({ runDateLocal: "2026-05-13", accounts: [] });
    expect((await latest(read("/runs/latest"))).status).toBe(200);
    expect(m.run).toHaveBeenCalledWith(expect.anything(), "2026-05-13");
    expect(String(m.poolQuery.mock.calls[0][0])).toContain("FROM trade_request.position_drift_accounts");
  });

  it("returns the static allow list", async () => {
    expect(await (await allowList(read("/allow-list"))).json()).toEqual({ entries: [] });
  });

  it("keeps the exclusion overlap off unless enabled, then serves and caches the report", async () => {
    expect((await overlapHead(read("/exclusion-overlap"))).status).toBe(404);
    expect(await (await overlap(read("/exclusion-overlap"))).json()).toEqual({ error: "drift exclusion overlap diagnostic disabled" });
    process.env.TRADE_REQUEST_DRIFT_EXCLUSION_OVERLAP_ENABLED = "1";
    expect((await overlapHead(read("/exclusion-overlap"))).status).toBe(204);
    m.analyze.mockResolvedValue({ runDateLocal: "2026-05-14", totalAccounts: 1 });
    expect((await overlap(read("/exclusion-overlap?runDateLocal=2026-05-14"))).status).toBe(200);
    expect((await overlap(read("/exclusion-overlap?runDateLocal=2026-05-14"))).status).toBe(200);
    expect(m.analyze).toHaveBeenCalledTimes(1);
    m.analyze.mockResolvedValueOnce(null);
    expect((await overlap(read("/exclusion-overlap?runDateLocal=2026-05-15"))).status).toBe(404);
  });
});
