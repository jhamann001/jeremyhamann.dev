import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ call: vi.fn(), enabled: vi.fn() }));
vi.mock("@/lib/trade-requests/client", () => ({ callTradeRequestService: m.call }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.enabled }));

import { loadAccountExclusions, loadTradeRequestDetail } from "@/lib/trade-requests/detail";
import { loadRequestPdfExclusions } from "@/app/(authenticated)/trade-requests/[id]/actions";

// ticket: the direct-link load (AC-9, AC-10, AC-83) and the PDF's exclusion
// lookup (AC-58, AC-100) through the delegated client. Synthetic data.

const REQUEST = {
  id: "REQ-SYN1", clientId: "HH-1", clientName: "Synthetic", clientIds: ["HH-1"], clientNames: ["Synthetic"], status: "Pending Review",
  selectedAccounts: ["SYN-1"], accountMetadata: [{ accountId: "ulid-1", accountNumber: "SYN-1", accountType: "Taxable", balance: 5 }],
  auditLog: [],
};
const CLIENTS = [{ id: "HH-1", name: "Synthetic", accounts: [{ id: "live-1", clientId: "HH-1", accountNumber: "SYN-1", accountType: "Taxable", balance: 7 }] }];

function respond(detail: unknown, clients: unknown = { ok: true, status: 200, data: { data: CLIENTS } }) {
  m.call.mockImplementation(async (call: { operation: string }) => (call.operation === "requestDetail" ? detail : clients));
}

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
});

describe("loadTradeRequestDetail (ticket)", () => {
  it("reads the request and the client list with the detail and client-list policies", async () => {
    respond({ ok: true, status: 200, data: { data: REQUEST } });
    const load = await loadTradeRequestDetail("REQ-SYN1");
    expect(load).toEqual({ kind: "found", request: REQUEST, accounts: [CLIENTS[0].accounts[0]] });
    expect(m.call).toHaveBeenCalledWith(expect.objectContaining({
      operation: "requestDetail", method: "GET", path: "/requests/REQ-SYN1", defaultMessage: "Failed to load request. Please try again.",
    }));
    expect(m.call).toHaveBeenCalledWith(expect.objectContaining({ operation: "clientList", method: "GET", path: "/clients" }));
  });

  it("falls back to the request's stored accounts when the client list fails", async () => {
    respond({ ok: true, status: 200, data: { data: REQUEST } }, { ok: false, outcome: "failed", status: 502, message: "x" });
    const load = await loadTradeRequestDetail("REQ-SYN1");
    expect(load.kind === "found" && load.accounts.map((a) => [a.id, a.balance])).toEqual([["ulid-1", 5]]);
  });

  it("shows the failure screen for a malformed request row instead of throwing (AC-83)", async () => {
    const { selectedAccounts: _accounts, ...noAccounts } = REQUEST;
    const { status: _status, ...noStatus } = REQUEST;
    for (const row of [
      noAccounts, noStatus, { ...REQUEST, selectedAccounts: "SYN-1" }, { ...REQUEST, clientName: null },
      { ...REQUEST, clientIds: "HH-1" }, { ...REQUEST, accountMetadata: {} }, { ...REQUEST, equityStrategies: "x" },
    ]) {
      respond({ ok: true, status: 200, data: { data: row } });
      expect(await loadTradeRequestDetail("REQ-SYN1")).toEqual({ kind: "failed", message: "Failed to load request. Please try again." });
    }
    respond({ ok: true, status: 200, data: { data: { ...REQUEST, clientIds: undefined, accountMetadata: null } } });
    expect((await loadTradeRequestDetail("REQ-SYN1")).kind).toBe("found");
  });

  it("never calls the service for workspace sub-routes", async () => {
    for (const id of ["queue", "new"]) expect(await loadTradeRequestDetail(id)).toEqual({ kind: "not_found" });
    expect(m.call).not.toHaveBeenCalled();
  });

  it("encodes the id as one path segment", async () => {
    respond({ ok: true, status: 200, data: { data: REQUEST } });
    await loadTradeRequestDetail("REQ 1/2");
    expect(m.call).toHaveBeenCalledWith(expect.objectContaining({ path: "/requests/REQ%201%2F2" }));
  });

  it("maps a 404 and a dot-segment id to not found (AC-10)", async () => {
    respond({ ok: false, outcome: "failed", status: 404, message: "Request REQ-X not found" });
    expect(await loadTradeRequestDetail("REQ-X")).toEqual({ kind: "not_found" });
    m.call.mockClear();
    expect(await loadTradeRequestDetail("..")).toEqual({ kind: "not_found" });
    expect(m.call).not.toHaveBeenCalled();
  });

  it("passes every other failure's message through, and the not-set-up outcome (AC-83, AC-22)", async () => {
    respond({ ok: false, outcome: "failed", status: 400, message: "Validation failed: id: ID is too long" });
    expect(await loadTradeRequestDetail("x".repeat(60))).toEqual({ kind: "failed", message: "Validation failed: id: ID is too long" });
    respond({ ok: false, outcome: "failed", status: null, message: "timeout of 30000ms exceeded" });
    expect(await loadTradeRequestDetail("REQ-1")).toEqual({ kind: "failed", message: "timeout of 30000ms exceeded" });
    respond({ ok: false, outcome: "not_set_up", message: "Your account is not set up for Trade Requests — contact Operations." });
    expect(await loadTradeRequestDetail("REQ-1")).toMatchObject({ kind: "not_set_up" });
    respond({ ok: true, status: 200, data: { data: { nope: true } } });
    expect(await loadTradeRequestDetail("REQ-1")).toEqual({ kind: "failed", message: "Failed to load request. Please try again." });
  });
});

describe("PDF account exclusions (ticket)", () => {
  it("reads the selected accounts once with the no-retry lookup policy", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: { "ulid-1": [] } } });
    expect(await loadAccountExclusions(["ulid-1", "ulid-1"])).toEqual({ ok: true, byAccountId: { "ulid-1": [] } });
    expect(m.call).toHaveBeenCalledWith(expect.objectContaining({
      operation: "accountExclusionsLookup", method: "POST", path: "/clients/account-exclusions/bulk",
      body: { accountIds: ["ulid-1"] }, defaultMessage: "PDF export failed. Please try again.",
    }));
  });

  it("skips the call without accounts and reports failures with the service text (AC-100)", async () => {
    expect(await loadAccountExclusions([])).toEqual({ ok: true, byAccountId: {} });
    expect(m.call).not.toHaveBeenCalled();
    m.call.mockResolvedValue({ ok: false, outcome: "failed", status: 500, message: "Internal server error" });
    expect(await loadAccountExclusions(["a"])).toEqual({ ok: false, message: "Internal server error" });
  });

  it("the server action is dark with the flag off and validates its input", async () => {
    m.enabled.mockReturnValue(false);
    expect(await loadRequestPdfExclusions(["a"])).toEqual({ ok: false, message: "PDF export failed. Please try again." });
    m.enabled.mockReturnValue(true);
    for (const bad of [null, "a", [1], [""], ["x".repeat(101)], Array(1001).fill("a")]) {
      expect(await loadRequestPdfExclusions(bad)).toEqual({ ok: false, message: "PDF export failed. Please try again." });
    }
    expect(m.call).not.toHaveBeenCalled();
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: { a: [] } } });
    expect(await loadRequestPdfExclusions(["a"])).toEqual({ ok: true, byAccountId: { a: [] } });
  });
});
