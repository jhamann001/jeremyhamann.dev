import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ auth: vi.fn(), findUnique: vi.fn(), aoaServed: vi.fn() }));
vi.mock("google-auth-library", () => ({ GoogleAuth: vi.fn(function () { return {}; }) }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: m.findUnique } } }));
vi.mock("@/lib/trade-requests/serving-state", () => ({ isAoaServed: m.aoaServed }));

import { exportDriftExclusions } from "@/app/(authenticated)/trade-requests/drift/actions";
import { resetDelegatedClientState } from "@/lib/trade-requests/client";
import { DRIFT_COPY } from "@/lib/trade-requests/drift-view/api";

const API = "https://trade-request.synthetic.invalid";
const NOT_SET_UP = "Your account is not set up for Trade Requests — contact Operations.";
const ROW = {
  scope: "client", clientId: "CL-SYN-1", clientName: "Synthetic Client One", accountId: "", accountNumber: "", ticker: "SYNA",
  kind: "advisor", reason: "Synthetic", noBuy: true, noSell: false, createdByName: "Dana Admin", createdAt: "2026-10-01T15:00:00.000Z",
};
let reply: { status: number; body: unknown };
const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply.body), { status: reply.status }));

function signIn(role: string) {
  m.auth.mockResolvedValue({ user: { id: `usr_${role.toLowerCase()}`, email: `${role.toLowerCase()}@example.test` } });
  m.findUnique.mockResolvedValue({ name: `Synthetic ${role}`, role });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetDelegatedClientState();
  vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", "1");
  vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
  vi.stubEnv("TRADE_REQUESTS_DRIFT_VIEW", "1");
  vi.stubEnv("TRADE_REQUESTS_NATIVE", "0");
  vi.stubEnv("TRADE_REQUEST_API_URL", API);
  vi.stubEnv("TRADE_REQUEST_DELEGATED_LOCAL_KEY", "synthetic-local-key");
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  m.aoaServed.mockResolvedValue(true);
  reply = { status: 200, body: { data: [ROW] } };
  signIn("OPERATIONS");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Drift exclusions export action (ticket)", () => {
  it("refuses while the workspace switch is off, before any session or service call", async () => {
    vi.stubEnv("EPIC_TRADE_REQUESTS_WORKSPACE", "0");
    expect(await exportDriftExclusions()).toEqual({ ok: false, message: DRIFT_COPY.unavailable });
    expect(m.auth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses while the Drift view switch or the epic master is off", async () => {
    for (const [master, view] of [["1", "0"], ["0", "1"]]) {
      vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", master);
      vi.stubEnv("TRADE_REQUESTS_DRIFT_VIEW", view);
      expect(await exportDriftExclusions()).toEqual({ ok: false, message: DRIFT_COPY.unavailable });
    }
    expect(m.aoaServed).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses while Trade Requests are standalone-served", async () => {
    m.aoaServed.mockResolvedValue(false);
    expect(await exportDriftExclusions()).toEqual({ ok: false, message: DRIFT_COPY.unavailable });
    expect(m.auth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a stored role outside ADMIN, OPERATIONS and ADVISOR gets the not-set-up message and no service call", async () => {
    for (const role of ["CLIENT_SERVICE", "VIEWER"]) {
      signIn(role);
      expect(await exportDriftExclusions()).toEqual({ ok: false, message: NOT_SET_UP });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the firm-wide rows from GET /clients/exclusions/export", async () => {
    expect(await exportDriftExclusions()).toEqual({ ok: true, rows: [ROW] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/api/aoa/clients/exclusions/export`);
    expect(init.method).toBe("GET");
  });

  it("a malformed body or a failed call returns a message, never rows", async () => {
    reply = { status: 200, body: { data: [{ ...ROW, scope: "household" }] } };
    expect(await exportDriftExclusions()).toEqual({ ok: false, message: DRIFT_COPY.exportExclusionsFailed });
    reply = { status: 500, body: { error: "Synthetic service failure" } };
    expect(await exportDriftExclusions()).toEqual({ ok: false, message: "Synthetic service failure" });
  });
});
