import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ call: vi.fn(), enabled: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/trade-requests/client", () => ({ callTradeRequestService: m.call }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.enabled }));
vi.mock("@/auth", () => ({ auth: m.auth }));

import { readTradeRequestExport } from "@/lib/trade-requests/export";
import { GET as getExport } from "@/app/api/trade-requests/export/route";
import type { TradeRequestCall } from "@/lib/trade-requests/client";
import type { TradeRequest } from "@/lib/trade-requests/request-types";
import { syntheticRequest } from "./helpers/export-requests";

// ticket: the export read follows the standalone handleExport and its two
// loaders (trade-request client/src/App.tsx). Synthetic data only.

type Reply = { ok: true; status: number; data: unknown } | { ok: false; outcome: "failed" | "not_set_up"; status?: number | null; message: string };
const ok = (data: unknown): Reply => ({ ok: true, status: 200, data });
const fail = (message: string): Reply => ({ ok: false, outcome: "failed", status: 500, message });

let list: Reply;
let clients: Reply;
let standing: (ids: string[]) => Reply;
let accounts: (ids: string[]) => Reply;

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
  m.auth.mockResolvedValue({ user: { role: "ADVISOR", email: "avery@example.com" } });
  list = ok({ data: [], truncated: false });
  clients = ok({ data: [] });
  standing = (ids) => ok({ data: Object.fromEntries(ids.map((id) => [id, []])) });
  accounts = (ids) => ok({ data: Object.fromEntries(ids.map((id) => [id, []])) });
  m.call.mockImplementation(async (call: TradeRequestCall) => {
    if (call.path === "/requests") return list;
    if (call.path === "/clients") return clients;
    if (call.path === "/clients/exclusions/bulk") return standing((call.body as { clientIds: string[] }).clientIds);
    if (call.path === "/clients/account-exclusions/bulk") return accounts((call.body as { accountIds: string[] }).accountIds);
    throw new Error(`unexpected ${call.path}`);
  });
});

const calls = (path: string) => m.call.mock.calls.map(([call]) => call as TradeRequestCall).filter((call) => call.path === path);
const exclusion = (kind: "advisor" | "client", ticker: string, extra: Record<string, unknown> = {}) =>
  ({ id: `x-${ticker}`, ticker, kind, reason: "", noBuy: true, noSell: true, ...extra });
const CLIENTS = [
  { id: "HH-1", name: "Synthetic One", accounts: [{ id: "ACC-1A", clientId: "HH-1", accountNumber: "SYN-1A", accountType: "IRA", balance: 1 }] },
  { id: "HH-2", name: "Synthetic Two", accounts: [
    { id: "ACC-2A", clientId: "HH-2", accountNumber: "SYN-2A", accountType: "IRA", balance: 1 },
    { id: "ACC-SHARED-2", clientId: "HH-2", accountNumber: "SYN-SHARED", accountType: "IRA", balance: 1 },
  ] },
  { id: "HH-3", name: "Synthetic Three", accounts: [{ id: "ACC-SHARED-3", clientId: "HH-3", accountNumber: "SYN-SHARED", accountType: "IRA", balance: 1 }] },
];

async function readOk() {
  const result = await readTradeRequestExport();
  if (!result.ok) throw new Error(`expected ok, got ${result.message}`);
  return result.data;
}

describe("export read: the full firm-wide list (AC-19)", () => {
  it("asks for every request with all=true and no search, keeping the service's newest-first order", async () => {
    const rows: TradeRequest[] = [3, 2, 1].map((n) => syntheticRequest({ id: `REQ-${n}`, clientId: `HH-${n}`, clientIds: [`HH-${n}`], selectedAccounts: [] }));
    list = ok({ data: rows, truncated: false });
    const data = await readOk();
    expect(calls("/requests")).toEqual([expect.objectContaining({ operation: "listRequests", method: "GET", query: { all: true } })]);
    expect(calls("/requests")[0].query).not.toHaveProperty("q");
    expect(calls("/clients")).toEqual([expect.objectContaining({ operation: "clientList", method: "GET" })]);
    expect(data.requests.map((row) => row.id)).toEqual(["REQ-3", "REQ-2", "REQ-1"]);
    expect(data.messages).toEqual([]);
  });

  it("a failed list fails the export with the delegated client's text; not set up passes through (AC-57)", async () => {
    list = fail("timeout of 30000ms exceeded");
    expect(await readTradeRequestExport()).toEqual({ ok: false, outcome: "failed", message: "timeout of 30000ms exceeded" });
    list = { ok: false, outcome: "not_set_up", message: "Your account is not set up for Trade Requests — contact Operations." };
    expect(await readTradeRequestExport()).toMatchObject({ ok: false, outcome: "not_set_up" });
    list = ok({ data: [{ id: "REQ-1" }] });
    expect(await readTradeRequestExport()).toEqual({ ok: false, outcome: "failed", message: "An unexpected error occurred" });
    expect(calls("/clients/exclusions/bulk")).toEqual([]);
  });

  it("raises the cap message when the service truncates at 5,000 (AC-20)", async () => {
    list = ok({ data: [syntheticRequest({ selectedAccounts: [] })], truncated: true });
    expect((await readOk()).messages).toEqual([
      "Export capped at 5,000 requests. The file may be incomplete — contact ops for a full report if needed.",
    ]);
  });
});

describe("export read: client-level standing exclusions (AC-54, AC-55, AC-56)", () => {
  it("looks up every client of every request once, 1,000 ids per call, with no retry", async () => {
    const rows = Array.from({ length: 1500 }, (_, n) => syntheticRequest({
      id: `REQ-${n}`, clientId: `HH-${n}`, clientIds: [`HH-${n}`, "HH-SHARED"], selectedAccounts: [],
    }));
    list = ok({ data: rows, truncated: false });
    standing = (ids) => ok({ data: Object.fromEntries(ids.map((id) => [id, id === "HH-7" ? [exclusion("advisor", "SYNA")] : []])) });
    const data = await readOk();
    const lookups = calls("/clients/exclusions/bulk");
    expect(lookups.map((call) => call.operation)).toEqual(["exportExclusions", "exportExclusions"]);
    const sent = lookups.flatMap((call) => (call.body as { clientIds: string[] }).clientIds);
    expect(lookups.map((call) => (call.body as { clientIds: string[] }).clientIds.length)).toEqual([1000, 501]);
    expect(new Set(sent).size).toBe(1501);
    expect(data.standingByClient["HH-7"]).toEqual([expect.objectContaining({ ticker: "SYNA" })]);
    expect(Object.keys(data.standingByClient)).toHaveLength(1501);
  });

  it("completes without them and raises the message with the reason when the lookup fails", async () => {
    list = ok({ data: [syntheticRequest({ selectedAccounts: [] })], truncated: true });
    standing = () => fail("Request failed with status code 503");
    const data = await readOk();
    expect(data.requests).toHaveLength(1);
    expect(Object.keys(data.standingByClient)).toEqual([]);
    expect(data.messages).toEqual([
      "Export capped at 5,000 requests. The file may be incomplete — contact ops for a full report if needed.",
      "Standing exclusions unavailable for export: Request failed with status code 503",
    ]);
  });

  it("an unreadable lookup reply is a failure with the default reason", async () => {
    list = ok({ data: [syntheticRequest({ selectedAccounts: [] })] });
    standing = () => ok({ data: { "HH-901": [{ ticker: 1 }] } });
    expect((await readOk()).messages).toEqual(["Standing exclusions unavailable for export: An unexpected error occurred"]);
  });

  it("keeps ids such as __proto__ as plain keys", async () => {
    list = ok({ data: [syntheticRequest({ clientId: "__proto__", clientIds: ["__proto__"], selectedAccounts: [] })] });
    standing = () => ({ ok: true, status: 200, data: JSON.parse('{"data":{"__proto__":[{"id":"x","ticker":"SYNP","kind":"client","reason":"","noBuy":true,"noSell":false}]}}') });
    const data = await readOk();
    expect(Object.getPrototypeOf(data.standingByClient)).toBeNull();
    expect(data.standingByClient["__proto__"]).toEqual([expect.objectContaining({ ticker: "SYNP" })]);
  });
});

describe("export read: account-level standing exclusions (AC-54, AC-55, AC-103, AC-104)", () => {
  it("resolves selected accounts through the client list, first matching client, once per request", async () => {
    clients = ok({ data: CLIENTS });
    list = ok({ data: [
      syntheticRequest({ id: "REQ-A", clientId: "HH-2", clientIds: ["HH-2", "HH-3"], selectedAccounts: ["SYN-SHARED", "SYN-2A", "SYN-SHARED"] }),
      syntheticRequest({ id: "REQ-B", clientId: "HH-1", clientIds: ["HH-1"], selectedAccounts: ["SYN-1A"] }),
    ] });
    accounts = (ids) => ok({ data: Object.fromEntries(ids.map((id) => [id, id === "ACC-SHARED-2"
      ? [exclusion("advisor", "SYNS", { reason: "Synthetic hold", noSell: false })]
      : id === "ACC-1A" ? [exclusion("client", "SYNC")] : []])) });
    const data = await readOk();
    const lookups = calls("/clients/account-exclusions/bulk");
    expect(lookups).toEqual([expect.objectContaining({ operation: "accountExclusionsLookup", body: { accountIds: ["ACC-SHARED-2", "ACC-2A", "ACC-1A"] } })]);
    expect(data.accountExclusionsByRequestId["REQ-A"]).toEqual([
      { accountNumber: "SYN-SHARED", kind: "advisor", ticker: "SYNS", reason: "Synthetic hold", noBuy: true, noSell: false },
    ]);
    expect(data.accountExclusionsByRequestId["REQ-B"]).toEqual([
      { accountNumber: "SYN-1A", kind: "client", ticker: "SYNC", reason: "", noBuy: true, noSell: true },
    ]);
    expect(data.messages).toEqual([]);
  });

  it("skips malformed or null clients and accounts instead of failing the export", async () => {
    clients = ok({ data: [
      null, "HH-X", { id: 7 },
      { id: "HH-1", name: "Synthetic One", accounts: [null, { accountNumber: "SYN-1A" }, { id: 5, accountNumber: "SYN-1A" }, ...CLIENTS[0].accounts] },
      { id: "HH-2", name: "Synthetic Two", accounts: null },
    ] });
    list = ok({ data: [
      syntheticRequest({ id: "REQ-A", clientId: "HH-1", clientIds: ["HH-1"], selectedAccounts: ["SYN-1A"] }),
      syntheticRequest({ id: "REQ-B", clientId: "HH-2", clientIds: ["HH-2"], selectedAccounts: ["SYN-2A", null as unknown as string] }),
    ] });
    const data = await readOk();
    expect(calls("/clients/account-exclusions/bulk")).toEqual([expect.objectContaining({ body: { accountIds: ["ACC-1A"] } })]);
    expect(data.requests).toHaveLength(2);
    expect(data.messages).toEqual([
      "Some exported accounts could not be resolved to current account IDs (2). Account-level exclusions may be partial.",
    ]);
  });

  it("raises the partial message with the unresolved count when the lookup succeeds", async () => {
    clients = ok({ data: CLIENTS });
    list = ok({ data: [
      syntheticRequest({ id: "REQ-A", clientId: "HH-1", clientIds: ["HH-1"], selectedAccounts: ["SYN-1A", "SYN-GONE"] }),
      syntheticRequest({ id: "REQ-B", clientId: "HH-9", clientIds: ["HH-9"], selectedAccounts: ["SYN-9A", "SYN-9B"] }),
    ] });
    expect((await readOk()).messages).toEqual([
      "Some exported accounts could not be resolved to current account IDs (3). Account-level exclusions may be partial.",
    ]);
  });

  it("a failed lookup leaves them out and raises only the unavailable message", async () => {
    clients = ok({ data: CLIENTS });
    list = ok({ data: [syntheticRequest({ clientId: "HH-1", clientIds: ["HH-1"], selectedAccounts: ["SYN-1A", "SYN-GONE"] })] });
    accounts = () => fail("Too many account IDs");
    const data = await readOk();
    expect(Object.keys(data.accountExclusionsByRequestId)).toEqual([]);
    expect(data.messages).toEqual(["Account exclusions unavailable for export: Too many account IDs"]);
  });

  it("with no resolvable account (or no client list) makes no lookup and raises nothing", async () => {
    list = ok({ data: [syntheticRequest({ selectedAccounts: ["SYN-GONE"] })] });
    clients = fail("Request failed with status code 502");
    expect((await readOk()).messages).toEqual([]);
    clients = ok({ data: CLIENTS });
    expect((await readOk()).messages).toEqual([]);
    expect(calls("/clients/account-exclusions/bulk")).toEqual([]);
  });

  it("raises messages in the standalone order: cap, client-level, account-level", async () => {
    clients = ok({ data: CLIENTS });
    list = ok({ data: [syntheticRequest({ clientId: "HH-1", clientIds: ["HH-1"], selectedAccounts: ["SYN-1A"] })], truncated: true });
    standing = () => fail("Network Error");
    accounts = () => fail("timeout of 30000ms exceeded");
    expect((await readOk()).messages).toEqual([
      "Export capped at 5,000 requests. The file may be incomplete — contact ops for a full report if needed.",
      "Standing exclusions unavailable for export: Network Error",
      "Account exclusions unavailable for export: timeout of 30000ms exceeded",
    ]);
  });
});

describe("export route", () => {
  const req = (path: string, headers: Record<string, string> = {}) => new Request(`http://127.0.0.1:3191${path}`, { headers });

  it("flag off: not found, no session read, no service call", async () => {
    m.enabled.mockReturnValue(false);
    expect((await getExport(req("/api/trade-requests/export"))).status).toBe(404);
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.call).not.toHaveBeenCalled();
  });

  it("refuses no session, non-workspace roles, cross-site requests and any query parameter", async () => {
    m.auth.mockResolvedValueOnce(null);
    expect((await getExport(req("/api/trade-requests/export"))).status).toBe(401);
    for (const role of ["CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY"]) {
      m.auth.mockResolvedValueOnce({ user: { role } });
      expect((await getExport(req("/api/trade-requests/export"))).status).toBe(403);
    }
    expect((await getExport(req("/api/trade-requests/export", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await getExport(req("/api/trade-requests/export?q=aufderhar"))).status).toBe(400);
    expect(m.call).not.toHaveBeenCalled();
  });

  it("answers each workspace role with the read, privately", async () => {
    list = ok({ data: [syntheticRequest({ selectedAccounts: [] })], truncated: false });
    for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"]) {
      m.auth.mockResolvedValueOnce({ user: { role } });
      const response = await getExport(req("/api/trade-requests/export"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({ ok: true, data: { requests: [{ id: "REQ-SYN0001" }], messages: [] } });
    }
  });
});
