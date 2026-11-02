import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Native write safeguards against Postgres as the AOA runtime role (ticket): refusal while standalone-served,
// attribution and channel, plan preservation, one side effect after commit, optimistic concurrency, idempotency
// and the serving-switch lock. Opt-in: TRADE_REQUEST_COPY_TEST_DB=1; scratch database; synthetic rows only.

const DB = "trb_wnative_tgt";
const g = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://app_rw@localhost:5432/trb_wnative_tgt?schema=app";
  return { emit: vi.fn() };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/trade-requests/native/side-effects", () => ({ emitTradeRequestEvent: g.emit }));
vi.mock("@/lib/trade-requests/native/reads/sources", () => ({
  ActiveAccountsLoadError: class extends Error {},
  tradeRequestWarehouseConfigured: () => false,
  getCachedClients: vi.fn(async () => []),
  loadMeridianActiveAccounts: vi.fn(),
  toHouseholdConfig: vi.fn(),
  machineAccountIdentityConfigured: () => false,
  getMachineAccountIdMap: vi.fn(async () => ({})),
}));

import { prisma } from "@/lib/db";
import type { TradeRequestCall, TradeRequestOperation, TradeRequestResult } from "@/lib/trade-requests/client";
import { checklistSave } from "@/lib/trade-requests/native/writes/checklist";
import { exclusionSave } from "@/lib/trade-requests/native/writes/exclusions";
import { markAllNotificationsRead, markNotificationRead } from "@/lib/trade-requests/native/writes/notifications";
import { createRequest, resubmitRequest, statusChange } from "@/lib/trade-requests/native/writes/requests";

const suite = process.env.TRADE_REQUEST_COPY_TEST_DB === "1" ? describe : describe.skip;
const OWNER_URL = `postgresql://aoa@localhost:5432/${DB}`;
const SEED_VERSION = "2026-10-01T12:00:00.000Z";
const ADVISOR_ID = "00000000-0000-4000-8000-000000000a01";
const OPS_ID = "00000000-0000-4000-8000-000000000a03";
const TABLES = ["users", "clients", "accounts", "trade_requests", "audit_logs", "notifications", "client_exclusions", "account_exclusions"];
const LOCK = "SELECT pg_advisory_xact_lock(hashtext('trade_request.serving_state'))";

const advisor = { aoaUserId: "aoa-advisor", email: "parity.advisor@example.test", name: "Avery AOA", role: "ADVISOR" as const };
const ops = { aoaUserId: "aoa-ops", email: "parity.ops@example.test", name: "Orin AOA", role: "OPERATIONS" as const };
const admin = { aoaUserId: "aoa-admin", email: "parity.admin@example.test", name: "Ada Admin", role: "ADMIN" as const };
const REFUSED = { ok: false, outcome: "failed", status: 503, message: "Native write failed" };

const sh = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { stdio: "pipe", env: { ...process.env, ...env } });
const owner = new PrismaClient({ datasourceUrl: `${OWNER_URL}?schema=app` });
const call = (operation: TradeRequestOperation, method: TradeRequestCall["method"], path: `/${string}`, body?: unknown): TradeRequestCall => ({
  operation, method, path, body, defaultMessage: "Native write failed",
  ...(operation === "markNotificationRead" || operation === "markAllNotificationsRead" ? { channel: "bell" as const } : {}),
});
const account = { accountNumber: "PAR-ACCT-1", accountType: "Taxable", balance: 250000.5 };
const raiseCash = (over: Record<string, unknown> = {}) => ({
  clientId: "PARITY-C1", clientName: "Parity Client One", tradeType: "Raise Cash", tradeAmount: "2500", raiseCashReason: "Tuition",
  selectedAccounts: ["PAR-ACCT-1"], accountsData: [account], priority: "Standard", ...over,
});
const liquidate = { ...raiseCash({ tradeType: "Liquidate", tradeAmount: "", raiseCashReason: "", liquidateOption: "Entire Account" }) };
const allocation = (tradeType: string) => ({
  ...raiseCash({ tradeType, tradeAmount: "", raiseCashReason: "" }), residence: "Other", liquidationApproval: "No", riskProfile: 12,
  equityStrategies: [{ id: 1, benchmark: "SPY", allocation: 100, rationale: "core" }],
});
const statusOf = (r: TradeRequestResult<unknown>) => (r.ok ? r.status : r.outcome === "failed" ? r.status : null);
const requestId = (r: TradeRequestResult<unknown>) => (r as { data: { data: { id: string } } }).data.data.id;

async function row<T>(sql: string, ...args: unknown[]): Promise<T> {
  return (await owner.$queryRawUnsafe<T[]>(sql, ...args))[0];
}
async function digest(): Promise<string> {
  const parts = TABLES.map((t) => `coalesce((SELECT string_agg(to_jsonb(x)::text, '' ORDER BY to_jsonb(x)::text) FROM trade_request.${t} x), '')`);
  return (await row<{ d: string }>(`SELECT md5(${parts.join(" || ")}) AS d`)).d;
}
const setServing = (source: "aoa" | "standalone") =>
  owner.$executeRawUnsafe("UPDATE trade_request.serving_state SET serving_source = $1, updated_by = 'ticket-test'", source);

suite("native Trade Request writes against Postgres (ticket)", () => {
  beforeAll(() => {
    sh("dropdb", ["--if-exists", DB]);
    sh("createdb", ["-O", "aoa", DB]);
    sh("npx", ["prisma", "migrate", "deploy"], { DIRECT_DATABASE_URL: `${OWNER_URL}?schema=app`, DATABASE_URL: `${OWNER_URL}?schema=app` });
  }, 180_000);

  beforeEach(async () => {
    await owner.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `trade_request.${t}`).join(", ")} CASCADE`);
    sh("psql", ["-q", "-v", "ON_ERROR_STOP=1", "-d", OWNER_URL, "-f", "test/fixtures/trade-request-write-parity-seed.sql"], {
      PGOPTIONS: "-c search_path=trade_request",
    });
    await setServing("aoa");
    g.emit.mockReset();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await owner.$disconnect();
    sh("dropdb", ["--if-exists", DB]);
  });

  it("refuses all seven writes while standalone-served and changes nothing, not even a first-time identity", async () => {
    await setServing("standalone");
    const before = await digest();
    const results = [
      await createRequest(call("createRequest", "POST", "/requests", raiseCash()), admin),
      await resubmitRequest(call("resubmitRequest", "PUT", "/requests/REQ-PARNI001", { ...liquidate, expectedUpdatedAt: SEED_VERSION }), advisor),
      await statusChange(call("statusChange", "PUT", "/requests/REQ-PARPR001/status", { status: "Approved", note: "", expectedUpdatedAt: SEED_VERSION }), ops),
      await checklistSave(call("checklistSave", "PUT", "/requests/REQ-PARPR001/checklist", { key: "templates", checked: true }), ops),
      await exclusionSave(call("exclusionSave", "POST", "/clients/PARITY-C1/exclusions/batch", { add: [{ ticker: "AAPL", kind: "client" }] }), advisor),
      await markNotificationRead(call("markNotificationRead", "PATCH", "/notifications/00000000-0000-4000-8000-000000000e01/read"), advisor),
      await markAllNotificationsRead(call("markAllNotificationsRead", "POST", "/notifications/read-all"), advisor),
    ];
    expect(results).toEqual(Array(7).fill(REFUSED));
    expect(await digest()).toBe(before);
    expect((await row<{ n: number }>("SELECT count(*)::int AS n FROM trade_request.users WHERE email = $1", admin.email)).n).toBe(0);
    expect(g.emit).not.toHaveBeenCalled();
  });

  it("records the acting identity and the aoa channel on every audited write", async () => {
    const audit = (where: string, ...args: unknown[]) =>
      row(`SELECT user_id::text AS user_id, user_name, channel, action FROM trade_request.audit_logs WHERE ${where}`, ...args);
    const created = await createRequest(call("createRequest", "POST", "/requests", raiseCash()), advisor);
    expect(statusOf(created)).toBe(201);
    expect(await audit("request_id = $1", requestId(created))).toEqual({ user_id: ADVISOR_ID, user_name: "Avery Parity", channel: "aoa", action: "Created Request" });
    await statusChange(call("statusChange", "PUT", "/requests/REQ-PARPR001/status", { status: "Needs Info", note: "", expectedUpdatedAt: SEED_VERSION }), ops);
    expect(await audit("request_id = 'REQ-PARPR001'")).toEqual({ user_id: OPS_ID, user_name: "Orin Parity", channel: "aoa", action: "Status changed to Needs Info" });
    await resubmitRequest(call("resubmitRequest", "PUT", "/requests/REQ-PARNI001", { ...liquidate, expectedUpdatedAt: SEED_VERSION }), advisor);
    expect(await audit("request_id = 'REQ-PARNI001' AND action = 'Request Resubmitted'")).toEqual({
      user_id: ADVISOR_ID, user_name: "Avery Parity", channel: "aoa", action: "Request Resubmitted",
    });
    const first = await createRequest(call("createRequest", "POST", "/requests", raiseCash({ tradeAmount: "3100" })), admin);
    const identity = await row<{ id: string; name: string; role: string; is_active: boolean }>(
      "SELECT id::text AS id, name, role, is_active FROM trade_request.users WHERE email = $1", admin.email);
    expect(identity).toMatchObject({ name: "Ada Admin", role: "advisor", is_active: false });
    expect(await audit("request_id = $1", requestId(first))).toMatchObject({ user_id: identity.id, channel: "aoa" });
  });

  it("keeps a stored execution plan through a resubmission and stores none on a new request", async () => {
    const plan = '[{"accountNumber": "PAR-ACCT-1", "trades": [{"asset": "SPY", "amount": 12345678901234567890.25}]}]';
    await owner.$executeRawUnsafe(
      `UPDATE trade_request.trade_requests SET trade_type = 'Rebalance', liquidate_option = NULL, risk_profile = 12,
         base_allocation = '{"equity": 61, "fixed": 34.5, "cash": 4.5}',
         equity_strategies = '[{"id": 1, "benchmark": "SPY", "allocation": 100, "rationale": "core"}]', execution_plan = $1::jsonb
       WHERE id = 'REQ-PARNI001'`, plan);
    const stored = () => row<{ p: string | null; status: string }>("SELECT execution_plan::text AS p, status FROM trade_request.trade_requests WHERE id = $1", "REQ-PARNI001");
    const before = (await stored()).p;
    const resubmitted = await resubmitRequest(
      call("resubmitRequest", "PUT", "/requests/REQ-PARNI001", { ...allocation("Rebalance"), expectedUpdatedAt: SEED_VERSION }), advisor);
    expect(statusOf(resubmitted)).toBe(200);
    expect(await stored()).toEqual({ p: before, status: "Pending Review" });
    const created = await createRequest(call("createRequest", "POST", "/requests", allocation("Initial Funding")), advisor);
    expect(statusOf(created)).toBe(201);
    expect((await row<{ p: string | null }>("SELECT execution_plan::text AS p FROM trade_request.trade_requests WHERE id = $1", requestId(created))).p).toBeNull();
    expect((created as { data: { data: { executionPlan: unknown } } }).data.data.executionPlan).toEqual([]);
  });

  it("triggers each matching side effect exactly once, after the write has committed", async () => {
    const committed: Promise<number>[] = [];
    g.emit.mockImplementation((event: { kind: string; request?: { requestId: string } }) => {
      if (event.kind === "submitted") {
        committed.push(row<{ n: number }>("SELECT count(*)::int AS n FROM trade_request.trade_requests WHERE id = $1", event.request!.requestId).then((r) => r.n));
      }
    });
    const key = "00000000-0000-4000-8000-0000000000b9";
    await createRequest(call("createRequest", "POST", "/requests", raiseCash({ idempotencyKey: key })), advisor);
    await createRequest(call("createRequest", "POST", "/requests", raiseCash({ idempotencyKey: key })), advisor);
    await statusChange(call("statusChange", "PUT", "/requests/REQ-PARPR001/status", { status: "Approved", note: "", expectedUpdatedAt: SEED_VERSION }), ops);
    await statusChange(call("statusChange", "PUT", "/requests/REQ-PARPR001/status", { status: "Completed", note: "", expectedUpdatedAt: SEED_VERSION }), ops);
    await exclusionSave(call("exclusionSave", "POST", "/clients/PARITY-C1/exclusions/batch", { add: [{ ticker: "NVDA", kind: "client" }] }), advisor);
    await exclusionSave(call("exclusionSave", "POST", "/clients/account-exclusions/PAR-ULID-1/batch", { add: [{ ticker: "MSFT", kind: "advisor" }] }), ops);
    await checklistSave(call("checklistSave", "PUT", "/requests/REQ-PARNI002/checklist", { key: "templates", checked: true }), ops);
    await markAllNotificationsRead(call("markAllNotificationsRead", "POST", "/notifications/read-all"), advisor);
    expect(g.emit.mock.calls.map(([e]) => e.kind)).toEqual(["submitted", "status_changed", "exclusion_batch_changed"]);
    expect(g.emit.mock.calls[0][0]).toMatchObject({ request: { clientName: "Parity Client One", submittedBy: "Avery Parity", totalValue: 250000.5, accounts: ["PAR-ACCT-1"] } });
    expect(g.emit.mock.calls[1][0]).toMatchObject({ requestId: "REQ-PARPR001", newStatus: "Approved", changedBy: "Orin Parity", submitterId: ADVISOR_ID, submitterSlackId: null });
    expect(g.emit.mock.calls[2][0]).toMatchObject({ batch: { clientName: "Parity Client One", added: [{ ticker: "NVDA", kind: "client", noBuy: true, noSell: true }], removed: [], changed: [] } });
    expect(await Promise.all(committed)).toEqual([1]);
  });

  it("lets exactly one of two concurrent status changes on the same version through", async () => {
    const body = { status: "Approved", note: "", expectedUpdatedAt: SEED_VERSION };
    const results = await Promise.all([1, 2].map(() => statusChange(call("statusChange", "PUT", "/requests/REQ-PARPR001/status", body), ops)));
    expect(results.map(statusOf).sort()).toEqual([200, 409]);
    expect((await row<{ n: number }>("SELECT count(*)::int AS n FROM trade_request.audit_logs WHERE request_id = 'REQ-PARPR001'")).n).toBe(1);
  });

  it("creates one request for two concurrent submissions with the same idempotency key", async () => {
    const key = "00000000-0000-4000-8000-0000000000b8";
    const results = await Promise.all([1, 2].map(() => createRequest(call("createRequest", "POST", "/requests", raiseCash({ idempotencyKey: key })), advisor)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map(statusOf).sort()).toEqual([200, 201]);
    expect((await row<{ n: number }>("SELECT count(*)::int AS n FROM trade_request.trade_requests WHERE idempotency_key = $1::uuid", key)).n).toBe(1);
  });

  it("holds a write while the serving state switches and then refuses it", async () => {
    const before = await digest();
    let settled = false;
    let write: Promise<TradeRequestResult<unknown>> | null = null;
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(LOCK);
      write = statusChange(call("statusChange", "PUT", "/requests/REQ-PARPR001/status", { status: "Approved", note: "", expectedUpdatedAt: SEED_VERSION }), ops)
        .then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      await tx.$executeRawUnsafe("UPDATE trade_request.serving_state SET serving_source = 'standalone', updated_by = 'ticket-test'");
    }, { timeout: 10_000 });
    expect(await write).toEqual(REFUSED);
    expect(await digest()).toBe(before);
  });
});
