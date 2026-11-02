import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Native read handlers with Warehouse and the Meridian feed configured (ticket), against stubbed feeds and a
// stubbed database. The local copied-record path is covered by the recorded parity replay. Synthetic data only.
vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({ $queryRaw: vi.fn(), $queryRawUnsafe: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: db }));
const src = vi.hoisted(() => {
  class ActiveAccountsLoadError extends Error {}
  return {
    ActiveAccountsLoadError,
    configured: vi.fn(() => true),
    getCachedClients: vi.fn(),
    loadMeridianActiveAccounts: vi.fn(),
    toHouseholdConfig: vi.fn(),
    machineConfigured: vi.fn(() => true),
    getMachineAccountIdMap: vi.fn(),
  };
});
vi.mock("@/lib/trade-requests/native/reads/sources", () => ({
  ActiveAccountsLoadError: src.ActiveAccountsLoadError,
  tradeRequestWarehouseConfigured: src.configured,
  getCachedClients: src.getCachedClients,
  loadMeridianActiveAccounts: src.loadMeridianActiveAccounts,
  toHouseholdConfig: src.toHouseholdConfig,
  machineAccountIdentityConfigured: src.machineConfigured,
  getMachineAccountIdMap: src.getMachineAccountIdMap,
  localFeedFallbackAllowed: () => process.env.TRADE_REQUESTS_LOCAL_SOURCES === "1",
  logFeedUnconfigured: (operation: string) => console.error(JSON.stringify({ event: "trade_request_native_feed_unconfigured", operation })),
}));

import type { TradeRequestCall } from "@/lib/trade-requests/client";
import { registeredNativeOperations, type NativeActor } from "@/lib/trade-requests/native/registry";
import "@/lib/trade-requests/native/reads";
import { clientListHandler } from "@/lib/trade-requests/native/reads/clients";
import { exportExclusionsHandler } from "@/lib/trade-requests/native/reads/exclusions";
import { householdResolveHandler, resetHouseholdConfigCache } from "@/lib/trade-requests/native/reads/households";
import { readNativeTradeRequestProjection } from "@/lib/trade-requests/native/reads/portrait";
import { NativeHttpError, nativeRoutes, route } from "@/lib/trade-requests/native/reads/http";
import { mapRowToRequest, requestCountsHandler, type RequestRow } from "@/lib/trade-requests/native/reads/requests";
import { CASES, CLIENTS, householdConfig } from "../scripts/trade-requests/household-resolution-cases.mjs";

const ACTOR: NativeActor = { aoaUserId: "aoa-user-1", email: "pat.person@example.test", name: "Synthetic Person", role: "OPERATIONS" };
const RESOLVED = JSON.parse(readFileSync("test/fixtures/trade-request-household-resolution.json", "utf8")) as Record<string, unknown>;
const call = (over: Partial<TradeRequestCall>): TradeRequestCall => ({ operation: "listRequests", method: "GET", path: "/", defaultMessage: "synthetic_default", ...over });
const READ_OPERATIONS = [
  "accountExclusionsLookup", "checklistRead", "clientExclusions", "clientList", "clientsExclusionsLookup", "exportExclusions",
  "householdResolve", "lastAllocation", "listRequests", "notificationsList", "requestCounts", "requestDetail",
];

function row(over: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "REQ-UNIT0001", client_id: "user-30000000-0000-4000-8000-000000000001", client_name: "Unit Client", client_ids: null, client_names: null,
    advisor_name: "Unit Advisor", trade_type: "Initial Funding", trade_amount: "", deposit_account: "", rebalance_all: false,
    status: "Approved", created_at: new Date("2025-01-01T00:00:00Z"), updated_at: new Date("2025-01-02T00:00:00Z"),
    selected_accounts: ["UNIT00001"], total_value: "250000.50", priority: "Standard", advisor_notes: "", residence: "CA",
    liquidation_approval: true, advisor_exclusions: "XOM", client_exclusions: "", esg_filters: null, risk_profile: 12,
    base_allocation: { equity: 60, fixed: 35, cash: 5 }, equity_strategies: [{ id: 1, benchmark: "S&P 500", allocation: 100, rationale: "" }],
    raise_cash_reason: "", liquidity_deadline: "2025-09-15", liquidate_option: "Liquidate_Entire_Account", liquidate_positions: "",
    execution_plan: [{ accountNumber: "UNIT00001", accountValue: 1, postTradeHoldings: { cash: 1, fixed: 0, equity: 0 } }],
    account_metadata: null, asset_location_mode: null, household_id: "9001", household_name: "Unit Household", ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHouseholdConfigCache();
  src.configured.mockReturnValue(true);
  src.machineConfigured.mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("native read handlers", () => {
  it("registers exactly the 12 workspace reads", () => {
    expect(registeredNativeOperations()).toEqual(READ_OPERATIONS);
  });

  it("maps a request row as the service does, without a plan validation", () => {
    const mapped = mapRowToRequest(row(), []);
    expect(mapped).toMatchObject({
      totalValue: 250000.5, householdId: 9001, liquidityDeadline: "2025-09-15", liquidateOption: "Entire Account",
      clientIds: ["user-30000000-0000-4000-8000-000000000001"], clientNames: ["Unit Client"], advisor: "Rachel Moss",
      submittedBy: "Unit Advisor", liquidationApproval: "Yes", assetLocationMode: "priority", date: "2025-01-01T00:00:00.000Z",
    });
    expect(mapped.executionPlan).toHaveLength(1);
    expect("validation" in mapped).toBe(false);
  });

  it("serves the cached Warehouse client list when configured", async () => {
    src.getCachedClients.mockResolvedValue(CLIENTS);
    expect(await clientListHandler(call({ operation: "clientList", path: "/clients" }), ACTOR)).toEqual({ ok: true, status: 200, data: { data: CLIENTS } });
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("answers 502 with the service's text when the Warehouse list fails", async () => {
    src.getCachedClients.mockRejectedValue(new Error("synthetic"));
    expect(await clientListHandler(call({ operation: "clientList", path: "/clients" }), ACTOR)).toEqual({
      ok: false, outcome: "failed", status: 502, message: "Account data source is temporarily unavailable. Please try again.",
    });
  });

  it("resolves households exactly as the standalone resolver did for every recorded case", async () => {
    src.getCachedClients.mockResolvedValue(CLIENTS);
    src.loadMeridianActiveAccounts.mockResolvedValue({});
    src.toHouseholdConfig.mockReturnValue(householdConfig());
    for (const [name, input] of Object.entries(CASES as Record<string, { clientIds: string[]; accountIds: string[] }>)) {
      const result = await householdResolveHandler(call({
        operation: "householdResolve", path: "/households/resolve",
        query: { clientIds: input.clientIds.join(",") || undefined, accountIds: input.accountIds.join(",") || undefined },
      }), ACTOR);
      expect([name, result]).toEqual([name, { ok: true, status: 200, data: { data: RESOLVED[name] } }]);
    }
    expect(src.loadMeridianActiveAccounts).toHaveBeenCalledTimes(1);
  });

  it("without the local-sources switch answers an unconfigured feed as unavailable instead of serving the copied records", async () => {
    vi.stubEnv("TRADE_REQUESTS_LOCAL_SOURCES", "");
    src.configured.mockReturnValue(false);
    expect(await clientListHandler(call({ operation: "clientList", path: "/clients" }), ACTOR)).toEqual({
      ok: false, outcome: "failed", status: 502, message: "Account data source is temporarily unavailable. Please try again.",
    });
    expect(await householdResolveHandler(call({ operation: "householdResolve", path: "/households/resolve" }), ACTOR)).toEqual({
      ok: false, outcome: "failed", status: 503, message: "household_data_unavailable",
    });
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("answers 503 household_data_unavailable when the feed cannot load", async () => {
    src.loadMeridianActiveAccounts.mockRejectedValue(new src.ActiveAccountsLoadError("synthetic"));
    expect(await householdResolveHandler(call({ operation: "householdResolve", path: "/households/resolve", query: { clientIds: "C-1" } }), ACTOR)).toEqual({
      ok: false, outcome: "failed", status: 503, message: "household_data_unavailable",
    });
  });

  it("enriches the firm-wide exclusion export with names, and exports ids only when the list fails", async () => {
    const created = new Date("2025-04-01T10:00:00Z");
    db.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: "e1", client_id: "C-1", ticker: "XOM", kind: "advisor", reason: "", no_buy: true, no_sell: false, created_by_name: "Unit", created_at: created }])
      .mockResolvedValueOnce([{ id: "e2", account_id: CLIENTS[0].accounts[0].id, ticker: "NVDA", kind: "client", reason: "", no_buy: true, no_sell: true, created_by_name: "Unit", created_at: created }]);
    src.getCachedClients.mockResolvedValueOnce(CLIENTS);
    const named = await exportExclusionsHandler(call({ operation: "exportExclusions", path: "/clients/exclusions/export" }), ACTOR);
    expect(named.ok && (named.data as { data: Array<Record<string, string>> }).data.map((r) => [r.scope, r.clientName, r.accountNumber])).toEqual([
      ["client", "Alder Family", ""], ["account", "Alder Family", "VOV4750"],
    ]);
    db.$queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "e2", account_id: CLIENTS[0].accounts[0].id, ticker: "NVDA", kind: "client", reason: "", no_buy: true, no_sell: true, created_by_name: "Unit", created_at: created },
    ]);
    src.getCachedClients.mockRejectedValueOnce(new Error("synthetic"));
    const bare = await exportExclusionsHandler(call({ operation: "exportExclusions", path: "/clients/exclusions/export" }), ACTOR);
    expect(bare.ok && (bare.data as { data: Array<Record<string, string>> }).data.map((r) => [r.clientName, r.accountNumber, r.accountId])).toEqual([
      ["", "", CLIENTS[0].accounts[0].id],
    ]);
  });

  it("answers an unexpected database error as the service's internal error and logs only a code", async () => {
    db.$queryRawUnsafe.mockRejectedValueOnce(Object.assign(new Error("relation pat.person@example.test"), { code: "P2010" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await requestCountsHandler(call({ operation: "requestCounts", path: "/requests/counts" }), ACTOR)).toEqual({
      ok: false, outcome: "failed", status: 500, message: "Internal server error",
    });
    expect(error.mock.calls.map((c) => String(c[0]))).toEqual(['{"event":"trade_request_native_failed","operation":"requestCounts","code":"P2010"}']);
  });

  it("answers a 5xx service error with the fixed internal-error text, as the standalone error handler does", async () => {
    const handler = nativeRoutes(route("GET", "/requests/counts", async () => {
      throw new NativeHttpError(503, "synthetic detail never shown");
    }));
    expect(await handler(call({ operation: "requestCounts", path: "/requests/counts" }), ACTOR)).toEqual({
      ok: false, outcome: "failed", status: 503, message: "Internal server error",
    });
  });

  it("answers a path its operation does not serve with the service's Not found", async () => {
    expect(await requestCountsHandler(call({ operation: "requestCounts", path: "/requests/run-engine" }), ACTOR)).toEqual({
      ok: false, outcome: "failed", status: 404, message: "Not found",
    });
  });

  it("builds the Client Portrait projection: id validation, masking, approved profile and account ids", async () => {
    expect((await readNativeTradeRequestProjection(new URLSearchParams({ cedar_ridge_user_id: "C-1" }))).status).toBe(400);
    db.$queryRawUnsafe.mockResolvedValueOnce([row()]).mockResolvedValueOnce([]);
    src.getMachineAccountIdMap.mockResolvedValueOnce({ UNIT00001: "01UNIT0000000000000000001A" });
    const answer = await readNativeTradeRequestProjection(new URLSearchParams({ cedar_ridge_user_id: "user-30000000-0000-4000-8000-000000000001" }));
    const [projected] = (answer.body as { data: Array<Record<string, unknown>> }).data;
    expect(answer.status).toBe(200);
    expect(projected).toMatchObject({
      selectedAccounts: ["****0001"], accounts: [{ accountId: "01UNIT0000000000000000001A", accountNumber: "****0001", accountType: null, balance: 0 }],
      profile: { riskScore: 12, decidedAt: "2025-01-02T00:00:00.000Z" },
    });
    expect(projected).not.toHaveProperty("clientName");
    expect(projected).not.toHaveProperty("auditLog");
  });
});
