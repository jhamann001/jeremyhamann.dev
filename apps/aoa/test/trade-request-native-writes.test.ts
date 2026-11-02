import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const g = vi.hoisted(() => {
  const state = { serving: "aoa" };
  const tx = {
    $executeRawUnsafe: vi.fn(async (_sql: string, ..._args: unknown[]) => 1),
    $queryRawUnsafe: vi.fn(async (sql: string, ..._args: unknown[]): Promise<unknown[]> =>
      sql.includes("trade_request.serving_state") ? [{ serving_source: state.serving }] : []),
  };
  return {
    state,
    tx,
    prisma: {
      $transaction: vi.fn(async (work: (t: typeof tx) => Promise<unknown>) => work(tx)),
      $queryRawUnsafe: vi.fn(async (_sql: string, ..._args: unknown[]): Promise<unknown[]> => []),
    },
    resolveActorIdentity: vi.fn(async () => ({ id: "00000000-0000-4000-8000-000000000a01", email: "unit.advisor@example.test", name: "Una Identity", role: "advisor", isActive: true, slackUserId: null })),
    emit: vi.fn(),
    loadRequest: vi.fn(async (id: string) => ({ id, status: "Pending Review" })),
    configured: vi.fn(() => false),
    getCachedClients: vi.fn(async (): Promise<unknown[]> => []),
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: g.prisma }));
vi.mock("@/lib/trade-requests/identity", () => ({ resolveActorIdentity: g.resolveActorIdentity }));
vi.mock("@/lib/trade-requests/native/side-effects", () => ({ emitTradeRequestEvent: g.emit }));
vi.mock("@/lib/trade-requests/native/reads/requests", () => ({ loadRequest: g.loadRequest }));
vi.mock("@/lib/trade-requests/native/reads/sources", () => ({ tradeRequestWarehouseConfigured: g.configured, getCachedClients: g.getCachedClients }));

import "@/lib/trade-requests/native/writes";
import type { TradeRequestCall, TradeRequestOperation } from "@/lib/trade-requests/client";
import { nativeHandlerFor, registeredNativeOperations, type NativeActor } from "@/lib/trade-requests/native/registry";

const advisor: NativeActor = { aoaUserId: "aoa-advisor", email: "unit.advisor@example.test", name: "Una AOA", role: "ADVISOR" };
const ops: NativeActor = { aoaUserId: "aoa-ops", email: "unit.ops@example.test", name: "Oli AOA", role: "OPERATIONS" };
const SEED_VERSION = "2026-10-01T12:00:00.000Z";
const LOCK_SQL = "SELECT pg_advisory_xact_lock_shared(hashtext('trade_request.serving_state'))";
const liquidate = {
  clientId: "UNIT-C1", clientName: "Unit Client", tradeType: "Liquidate", liquidateOption: "Entire Account", selectedAccounts: ["UNIT-1"],
  accountsData: [{ accountNumber: "UNIT-1", accountType: "Taxable", balance: 10 }], priority: "Standard",
};
const CALLS: Record<string, Pick<TradeRequestCall, "method" | "path" | "body" | "channel">> = {
  createRequest: { method: "POST", path: "/requests", body: liquidate },
  resubmitRequest: { method: "PUT", path: "/requests/REQ-UNIT0001", body: { ...liquidate, expectedUpdatedAt: SEED_VERSION } },
  statusChange: { method: "PUT", path: "/requests/REQ-UNIT0001/status", body: { status: "Approved", note: "", expectedUpdatedAt: SEED_VERSION } },
  checklistSave: { method: "PUT", path: "/requests/REQ-UNIT0001/checklist", body: { key: "templates", checked: true } },
  exclusionSave: { method: "POST", path: "/clients/UNIT-C1/exclusions/batch", body: { add: [{ ticker: "AAPL", kind: "client" }] } },
  markNotificationRead: { method: "PATCH", path: "/notifications/00000000-0000-4000-8000-000000000e01/read", channel: "bell" },
  markAllNotificationsRead: { method: "POST", path: "/notifications/read-all", channel: "bell" },
};
const run = (op: string, actor: NativeActor, over: Partial<TradeRequestCall> = {}) =>
  nativeHandlerFor(op as TradeRequestOperation)!({ operation: op as TradeRequestOperation, defaultMessage: `default ${op}`, ...CALLS[op], ...over }, actor);
const writeCalls = () => g.tx.$executeRawUnsafe.mock.calls.filter(([sql]) => sql !== LOCK_SQL);
const insertParams = () => writeCalls().find(([sql]) => sql.startsWith("INSERT INTO trade_request.trade_requests"));
const failed = (status: number, message: string) => ({ ok: false, outcome: "failed", status, message });
const timeout = () => Object.assign(new Error("source timed out"), { name: "TimeoutError" });

beforeEach(() => {
  g.state.serving = "aoa";
  g.tx.$executeRawUnsafe.mockReset().mockImplementation(async () => 1);
  g.tx.$queryRawUnsafe.mockClear();
  g.prisma.$queryRawUnsafe.mockReset().mockImplementation(async () => []);
  g.prisma.$transaction.mockClear();
  g.resolveActorIdentity.mockClear();
  g.emit.mockClear();
  g.configured.mockReset().mockReturnValue(false);
  g.getCachedClients.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("native Trade Request writes (ticket)", () => {
  it("registers exactly the seven workspace write operations", () => {
    expect(registeredNativeOperations()).toEqual([
      "checklistSave", "createRequest", "exclusionSave", "markAllNotificationsRead", "markNotificationRead", "resubmitRequest", "statusChange",
    ]);
  });

  it("refuses every write while standalone-served, before resolving the actor or writing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    g.state.serving = "standalone";
    for (const op of Object.keys(CALLS)) {
      await expect(run(op, op === "statusChange" || op === "checklistSave" ? ops : advisor)).resolves.toEqual(failed(503, `default ${op}`));
    }
    expect(writeCalls()).toEqual([]);
    expect(g.resolveActorIdentity).not.toHaveBeenCalled();
    expect(g.prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(g.emit).not.toHaveBeenCalled();
  });

  it("answers an advisor's status change and checklist save with the service's 403 and writes nothing", async () => {
    await expect(run("statusChange", advisor)).resolves.toEqual(failed(403, "Insufficient permissions"));
    await expect(run("checklistSave", advisor)).resolves.toEqual(failed(403, "Insufficient permissions"));
    expect(writeCalls()).toEqual([]);
  });

  it("reports validation failures with the first three details, as the delegated text does", async () => {
    await expect(run("createRequest", advisor, { body: {} })).resolves.toEqual(
      failed(400, "Validation failed: clientId: Required; clientName: Required; tradeType: Required"),
    );
  });

  it("shows the bell's fixed line for a bell failure", async () => {
    await expect(run("markNotificationRead", advisor, { path: "/notifications/not-a-uuid/read" })).resolves.toEqual(
      failed(400, "default markNotificationRead"),
    );
  });

  it("maps an unexpected database error to the service's 500 text and logs only a code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    g.tx.$executeRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.startsWith("UPDATE trade_request.notifications")) throw Object.assign(new Error("boom unit.advisor@example.test"), { code: "P2010", meta: { code: "XX000" } });
      return 1;
    });
    await expect(run("markAllNotificationsRead", advisor, { channel: undefined })).resolves.toEqual(failed(500, "Internal server error"));
    const line = String(logged.mock.calls.at(-1)?.[0]);
    expect(line).toContain('"operation":"markAllNotificationsRead"');
    expect(line).toContain('"code":"P2010"');
    expect(line).not.toContain("example.test");
  });

  it("records the actor and the aoa channel, never writes the plan column, and emits once after a create", async () => {
    const result = await run("createRequest", advisor);
    expect(result).toEqual({ ok: true, status: 201, data: { data: { id: expect.stringMatching(/^REQ-[0-9A-F]{8}$/), status: "Pending Review" } } });
    const [insert, audit] = writeCalls();
    expect(insert[0]).toContain("INSERT INTO trade_request.trade_requests");
    expect(insert[0]).not.toContain("execution_plan");
    expect(audit[0]).toContain("'aoa'");
    expect(audit.slice(2, 4)).toEqual(["Una Identity", "00000000-0000-4000-8000-000000000a01"]);
    expect(g.emit).toHaveBeenCalledTimes(1);
    expect(g.emit.mock.calls[0][0]).toMatchObject({ kind: "submitted", request: { submittedBy: "Una Identity", totalValue: 10 } });
  });

  it("answers a path the service would not route with 404 before resolving the actor", async () => {
    await expect(run("statusChange", ops, { path: "/requests/REQ-UNIT0001/state" })).resolves.toEqual(failed(404, "Not found"));
    expect(g.prisma.$transaction).not.toHaveBeenCalled();
    expect(g.resolveActorIdentity).not.toHaveBeenCalled();
  });

  it("with Warehouse configured, refuses an advisor's create for a client with no accounts", async () => {
    g.configured.mockReturnValue(true);
    g.getCachedClients.mockResolvedValue([{ id: "UNIT-C2", name: "Other", accounts: [] }]);
    await expect(run("createRequest", advisor)).resolves.toEqual(failed(403, "Client UNIT-C1 not found or you do not have access"));
    expect(insertParams()).toBeUndefined();
    expect(g.emit).not.toHaveBeenCalled();
  });

  it("with Warehouse configured and no account data, reports selected accounts the source does not have", async () => {
    g.configured.mockReturnValue(true);
    g.getCachedClients.mockResolvedValue([{ id: "UNIT-C1", name: "Unit Client", accounts: [{ id: "ULID-UNIT-1", clientId: "UNIT-C1", accountNumber: "UNIT-1", accountType: "Taxable", balance: 10 }] }]);
    await expect(run("createRequest", ops, { body: { ...liquidate, accountsData: undefined, selectedAccounts: ["UNIT-1", "UNIT-9"] } })).resolves.toEqual(
      failed(400, "Account(s) not found for the selected client(s): UNIT-9"),
    );
    expect(insertParams()).toBeUndefined();
  });

  it("with Warehouse configured, answers a source timeout as the delegated path shows the service's 502", async () => {
    g.configured.mockReturnValue(true);
    g.getCachedClients.mockRejectedValue(timeout());
    await expect(run("createRequest", ops, { body: { ...liquidate, accountsData: undefined } })).resolves.toEqual(failed(502, "Internal server error"));
    expect(insertParams()).toBeUndefined();
  });

  it("with Warehouse configured, stores the stable account id for listed accounts", async () => {
    g.configured.mockReturnValue(true);
    g.getCachedClients.mockResolvedValue([{ id: "UNIT-C1", name: "Unit Client", accounts: [{ id: "ULID-UNIT-1", clientId: "UNIT-C1", accountNumber: "UNIT-1", accountType: "Taxable", balance: 10 }] }]);
    expect(await run("createRequest", ops)).toMatchObject({ ok: true, status: 201 });
    expect(JSON.parse(String(insertParams()![11]))).toEqual([{ accountId: "ULID-UNIT-1", accountNumber: "UNIT-1", accountType: "Taxable", balance: 10 }]);
  });

  it("with Warehouse configured, still creates when the account-id enrichment fails and logs only a count", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    g.configured.mockReturnValue(true);
    g.getCachedClients.mockRejectedValue(timeout());
    expect(await run("createRequest", ops)).toMatchObject({ ok: true, status: 201 });
    expect(JSON.parse(String(insertParams()![11]))).toEqual([{ accountId: null, accountNumber: "UNIT-1", accountType: "Taxable", balance: 10 }]);
    expect(warned.mock.calls.map(([line]) => line)).toEqual([JSON.stringify({ event: "request_account_id_persistence_failed", accountCount: 1 })]);
  });
});
