import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ call: vi.fn(), auth: vi.fn(), flag: vi.fn() }));
vi.mock("@/lib/trade-requests/client", () => ({ callTradeRequestService: m.call }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.flag }));

import { readNewRequestClients, resolveNewRequestHouseholds } from "@/lib/trade-requests/new-request-data";
import { loadNewRequestClients, lookupNewRequestHouseholds } from "@/app/(authenticated)/trade-requests/new/actions";

const CLIENTS = { data: [{ id: "c1", name: "Maeve Brennan", accounts: [{ id: "a1", clientId: "c1", accountNumber: "SYN1", accountType: "Roth IRA", balance: "1500.25", holdings: {} }] }] };
const RESOLVED = { data: { households: [{ householdId: 7101, householdName: "Brennan Family Household", selectedAccountIds: ["A"], clientIds: ["c1"],
  accounts: [{ accountId: "A", accountNumber: "SYN1", accountTitle: "Alex Roth", clientId: "c1", accountType: "Roth IRA", balance: 1 },
    { accountId: "B", accountNumber: null, accountTitle: "Unlisted", clientId: null }] }], unresolvedClientIds: [], unresolvedAccountIds: [] } };

beforeEach(() => {
  m.call.mockReset();
  m.auth.mockResolvedValue({ user: { email: "avery@example.com", role: "ADVISOR" } });
  m.flag.mockReturnValue(true);
});

describe("client list read (AC-39, AC-82)", () => {
  it("reads /clients through the delegated client and keeps only what the form shows", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: CLIENTS });
    await expect(readNewRequestClients()).resolves.toEqual({
      ok: true, clients: [{ id: "c1", name: "Maeve Brennan", accounts: [{ id: "a1", accountNumber: "SYN1", accountType: "Roth IRA", balance: 1500.25 }] }],
    });
    expect(m.call).toHaveBeenCalledWith({ operation: "clientList", method: "GET", path: "/clients", defaultMessage: "Failed to load clients" });
  });

  it("passes the failure message through and keeps the not-set-up outcome", async () => {
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 502, message: "Account data source is temporarily unavailable. Please try again." });
    await expect(readNewRequestClients()).resolves.toEqual({
      ok: false, outcome: "failed", message: "Account data source is temporarily unavailable. Please try again.",
    });
    m.call.mockResolvedValueOnce({ ok: false, outcome: "not_set_up", message: "Your account is not set up for Trade Requests — contact Operations." });
    await expect(readNewRequestClients()).resolves.toMatchObject({ ok: false, outcome: "not_set_up" });
  });

  it("uses the default text for a response it cannot read", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { clients: [] } });
    await expect(readNewRequestClients()).resolves.toEqual({ ok: false, outcome: "failed", message: "Failed to load clients" });
  });
});

describe("household lookup (AC-122 to AC-124)", () => {
  it("sends the selection as comma lists and normalises the households", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: RESOLVED });
    const result = await resolveNewRequestHouseholds(["c1", "c2"], ["A"]);
    expect(m.call).toHaveBeenCalledWith(expect.objectContaining({
      operation: "householdResolve", method: "GET", path: "/households/resolve", query: { clientIds: "c1,c2", accountIds: "A" },
    }));
    expect(result?.households[0]).toEqual({
      householdId: 7101, householdName: "Brennan Family Household", selectedAccountIds: ["A"], clientIds: ["c1"],
      accounts: [{ accountId: "A", accountNumber: "SYN1", accountTitle: "Alex Roth", clientId: "c1" },
        { accountId: "B", accountNumber: null, accountTitle: "Unlisted", clientId: null }],
    });
  });

  it("treats 503 as no household and any other failure as no change", async () => {
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 503, message: "x" });
    await expect(resolveNewRequestHouseholds(["c1"], [])).resolves.toEqual({ households: [] });
    expect(m.call.mock.calls[0][0].query).toEqual({ clientIds: "c1", accountIds: undefined });
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 400, message: "x" });
    await expect(resolveNewRequestHouseholds(["c1"], [])).resolves.toBeNull();
    m.call.mockResolvedValueOnce({ ok: false, outcome: "not_set_up", message: "x" });
    await expect(resolveNewRequestHouseholds(["c1"], [])).resolves.toBeNull();
  });
});

describe("server actions", () => {
  it("call the service only with the flag on and a workspace role", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: CLIENTS });
    await expect(loadNewRequestClients()).resolves.toMatchObject({ ok: true });
    for (const role of ["CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY"]) {
      m.auth.mockResolvedValueOnce({ user: { email: "x@example.com", role } });
      await expect(loadNewRequestClients()).resolves.toMatchObject({ ok: false, outcome: "not_allowed" });
    }
    m.flag.mockReturnValue(false);
    await expect(loadNewRequestClients()).resolves.toMatchObject({ ok: false, outcome: "not_allowed" });
    await expect(lookupNewRequestHouseholds(["c1"], [])).resolves.toBeNull();
    expect(m.call).toHaveBeenCalledTimes(1);
  });

  it("refuse malformed household lookup input", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: RESOLVED });
    await expect(lookupNewRequestHouseholds("c1", [])).resolves.toBeNull();
    await expect(lookupNewRequestHouseholds(["c1,c2"], [])).resolves.toBeNull();
    await expect(lookupNewRequestHouseholds([1], [])).resolves.toBeNull();
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
    await expect(lookupNewRequestHouseholds(ids(51), [])).resolves.toBeNull();
    await expect(lookupNewRequestHouseholds(["c1"], ids(51))).resolves.toBeNull();
    expect(m.call).not.toHaveBeenCalled();
    await expect(lookupNewRequestHouseholds(ids(50), ids(50))).resolves.toMatchObject({ households: [{ householdId: 7101 }] });
    expect(m.call).toHaveBeenCalledTimes(1);
    m.call.mockClear();
    await expect(lookupNewRequestHouseholds(["c1"], ["A"])).resolves.toMatchObject({ households: [{ householdId: 7101 }] });
  });
});
