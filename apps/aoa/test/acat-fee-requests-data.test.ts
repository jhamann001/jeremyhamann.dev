import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

type Sql = { sql: string; values: unknown[] };
const mocks = vi.hoisted(() => ({ transfers: vi.fn(), requestRows: vi.fn(), raw: vi.fn(), scope: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({
  withUserScope: async (identity: unknown, run: (tx: unknown) => Promise<unknown>) => {
    mocks.scope(identity);
    return run({
      transfer: { findMany: mocks.transfers },
      operationsFeeRequest: { findMany: mocks.requestRows },
      $queryRaw: mocks.raw,
    });
  },
}));

import { readReimbursementPrefill, readTransferFeeRequests } from "@/lib/data/acat-reimbursement";
import { TRANSFER_FEE_REQUESTS_LIMIT } from "@/lib/data/acat-fee-requests-view";

const SUITE = "acat-fee-requests-data";
const IDENTITY = { role: "OPERATIONS", email: "synthetic@example.test" };
const PAT = "003BLO191836131AAA";
const SAM = "003MLO108774638AAA";

type Client = { sf_id: string; name: string; household_name: string | null };
type Account = { custodian_account_id: string; apex_account_number: string | null; account_type: string | null; account_status: string | null; client_sf_id: string };
const CLIENTS: Record<string, Client> = {
  "003BLO191836131": { sf_id: PAT, name: "Pat Example", household_name: "Example Household" },
  "003MLO108774638": { sf_id: SAM, name: "Sam Example", household_name: null },
};
const ACCOUNTS: Record<string, Account[]> = {
  "003BLO191836131": [
    { custodian_account_id: "acct-1", apex_account_number: "5YA01ZHLK", account_type: "IRA", account_status: "OPEN", client_sf_id: PAT },
    { custodian_account_id: "acct-2", apex_account_number: "9TZ68SGRH", account_type: "Brokerage", account_status: "OPEN", client_sf_id: PAT },
  ],
  "003MLO108774638": [],
};
let bridged: string[] = [];

function install() {
  mocks.raw.mockImplementation(async (query: Sql) => {
    if (query.sql.includes("btrim(cedar_ridge_user_id)")) return bridged.map((sf_id) => ({ sf_id }));
    if (query.sql.includes("FROM mirror.client_account_aum")) return ACCOUNTS[String(query.values[0])] ?? [];
    if (query.sql.includes("FROM mirror.client c")) return query.values.flatMap((value) => (CLIENTS[String(value)] ? [CLIENTS[String(value)]] : []));
    throw new Error(`unexpected query: ${query.sql}`);
  });
}

const money = (value: string) => ({ toFixed: () => value });
const row = (id: string, status: string, amount: string | null, over: Record<string, unknown> = {}) => ({
  id, kind: "FEE_CREDIT", status, fee_amount: amount === null ? null : money(amount), fee_types: ["ACAT out"],
  submitted_at: new Date("2026-10-14T12:00:00Z"), credited_at: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  bridged = [];
  mocks.transfers.mockResolvedValue([]);
  mocks.requestRows.mockResolvedValue([]);
  install();
});

const INPUT = { recordId: "rec-1", cedarRidgeUserId: null, maskedAccount: "********ZHLK" };

describe("requests on file for a transfer (ticket)", () => {
  it("reads every request of every kind for the resolved client and account, in every status, and names them", async () => {
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    mocks.requestRows.mockResolvedValue([
      row("req_pending", "PENDING", "50.00"),
      row("req_approved", "APPROVED", "40.00"),
      row("req_rejected", "REJECTED", "30.00"),
      row("req_cancelled", "CANCELLED", "20.00"),
      row("req_credited", "CREDITED", "10.00", { credited_at: new Date("2026-10-10T00:00:00Z") }),
      row("req_blank", "CREDITED", null, { fee_types: [] }),
      row("req_waiver", "APPROVED", null, { kind: "SERVICE_GUARANTEE", fee_types: [] }),
    ]);
    const read = await readTransferFeeRequests(IDENTITY, INPUT);
    expect(read).toEqual({
      identity: "resolved", clientName: "Pat Example", accountLabel: "IRA · ••••ZHLK", truncated: false,
      requests: [
        { id: "req_pending", kind: "FEE_CREDIT", status: "PENDING", feeAmount: "50.00", feeTypes: ["ACAT out"], submittedAt: "2026-10-14T12:00:00.000Z", creditedAt: null },
        { id: "req_approved", kind: "FEE_CREDIT", status: "APPROVED", feeAmount: "40.00", feeTypes: ["ACAT out"], submittedAt: "2026-10-14T12:00:00.000Z", creditedAt: null },
        { id: "req_rejected", kind: "FEE_CREDIT", status: "REJECTED", feeAmount: "30.00", feeTypes: ["ACAT out"], submittedAt: "2026-10-14T12:00:00.000Z", creditedAt: null },
        { id: "req_cancelled", kind: "FEE_CREDIT", status: "CANCELLED", feeAmount: "20.00", feeTypes: ["ACAT out"], submittedAt: "2026-10-14T12:00:00.000Z", creditedAt: null },
        { id: "req_credited", kind: "FEE_CREDIT", status: "CREDITED", feeAmount: "10.00", feeTypes: ["ACAT out"], submittedAt: "2026-10-14T12:00:00.000Z", creditedAt: "2026-10-10T00:00:00.000Z" },
        { id: "req_blank", kind: "FEE_CREDIT", status: "CREDITED", feeAmount: null, feeTypes: [], submittedAt: "2026-10-14T12:00:00.000Z", creditedAt: null },
        { id: "req_waiver", kind: "SERVICE_GUARANTEE", status: "APPROVED", feeAmount: null, feeTypes: [], submittedAt: "2026-10-14T12:00:00.000Z", creditedAt: null },
      ],
    });
    expect(mocks.scope).toHaveBeenCalledWith(IDENTITY);
    markCase(SUITE, "reads every request of every kind for the resolved client and account, in every status, and names them");
  });

  it("queries requests of any kind and status for the account, matching the client by its 15 character id, newest first, one row past the limit", async () => {
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    await readTransferFeeRequests(IDENTITY, INPUT);
    const query = mocks.requestRows.mock.calls[0][0] as { where: Record<string, unknown>; take: number; orderBy: unknown; select: Record<string, boolean> };
    expect(query.where).toMatchObject({ account_ids: { has: "acct-1" } });
    expect(query.where).not.toHaveProperty("status");
    expect(query.where).not.toHaveProperty("kind");
    expect(query.where.OR).toEqual([{ client_sf_id: PAT }, { client_sf_id: { startsWith: PAT.slice(0, 15), mode: "insensitive" } }]);
    expect(query.take).toBe(TRANSFER_FEE_REQUESTS_LIMIT + 1);
    expect(query.orderBy).toEqual([{ submitted_at: "desc" }, { id: "desc" }]);
    markCase(SUITE, "queries requests of any kind and status for the account, matching the client by its 15 character id, newest first, one row past the limit");
  });

  it("selects only the trimmed fields: no submitter, reason, tickets, Apex request, legacy or event data", async () => {
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    await readTransferFeeRequests(IDENTITY, INPUT);
    const query = mocks.requestRows.mock.calls[0][0] as { select: Record<string, boolean>; include?: unknown };
    expect(Object.keys(query.select).sort()).toEqual(["credited_at", "fee_amount", "fee_types", "id", "kind", "status", "submitted_at"]);
    expect(query.include).toBeUndefined();
    markCase(SUITE, "selects only the trimmed fields: no submitter, reason, tickets, Apex request, legacy or event data");
  });

  it("is unresolved, and reads no requests, when no client resolves, the link and the directory disagree, or an unknown client is linked", async () => {
    expect(await readTransferFeeRequests(IDENTITY, INPUT)).toEqual({ identity: "unresolved", reason: "client" });
    bridged = [SAM];
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    expect(await readTransferFeeRequests(IDENTITY, { ...INPUT, cedarRidgeUserId: "user-1" })).toEqual({ identity: "unresolved", reason: "client" });
    bridged = [];
    mocks.transfers.mockResolvedValue([{ client_sf_id: "003QBSURLA45937" }]);
    expect(await readTransferFeeRequests(IDENTITY, INPUT)).toEqual({ identity: "unresolved", reason: "client" });
    expect(mocks.requestRows).not.toHaveBeenCalled();
    markCase(SUITE, "is unresolved, and reads no requests, when no client resolves, the link and the directory disagree, or an unknown client is linked");
  });

  it("is unresolved for the account when none or more than one account ends with the transfer's masked suffix", async () => {
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    expect(await readTransferFeeRequests(IDENTITY, { ...INPUT, maskedAccount: "********QQQQ" })).toEqual({ identity: "unresolved", reason: "account" });
    expect(await readTransferFeeRequests(IDENTITY, { ...INPUT, maskedAccount: null })).toEqual({ identity: "unresolved", reason: "account" });
    ACCOUNTS["003BLO191836131"].push({ custodian_account_id: "acct-3", apex_account_number: "1YI86ZHLK", account_type: "Roth", account_status: "OPEN", client_sf_id: PAT });
    try {
      expect(await readTransferFeeRequests(IDENTITY, INPUT)).toEqual({ identity: "unresolved", reason: "account" });
    } finally {
      ACCOUNTS["003BLO191836131"].pop();
    }
    expect(mocks.requestRows).not.toHaveBeenCalled();
    markCase(SUITE, "is unresolved for the account when none or more than one account ends with the transfer's masked suffix");
  });

  it("never looks a client up by name", async () => {
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    await readTransferFeeRequests(IDENTITY, INPUT);
    mocks.transfers.mockResolvedValue([]);
    await readTransferFeeRequests(IDENTITY, { ...INPUT, cedarRidgeUserId: "user-1" });
    expect(mocks.raw.mock.calls.length).toBeGreaterThan(0);
    for (const [query] of mocks.raw.mock.calls as Array<[Sql]>) expect(query.sql).not.toMatch(/first_name\s+(I?LIKE|=)|last_name\s+(I?LIKE|=)|\bname\b\s*(I?LIKE|=)/i);
    const query = mocks.requestRows.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(JSON.stringify(query.where)).not.toMatch(/name/i);
    markCase(SUITE, "never looks a client up by name");
  });

  it("uses the same client and account as the confirm flow's preview for the same transfer", async () => {
    const scenarios: Array<{ link: string[]; bridge: string[]; masked: string | null; user: string | null }> = [
      { link: [PAT], bridge: [], masked: "********ZHLK", user: null },
      { link: [], bridge: [PAT], masked: "********ZHLK", user: "user-1" },
      { link: [PAT.slice(0, 15)], bridge: [PAT], masked: "********ZHLK", user: "user-1" },
      { link: [PAT], bridge: [SAM], masked: "********ZHLK", user: "user-1" },
      { link: [PAT], bridge: [], masked: "********QQQQ", user: null },
      { link: [], bridge: [], masked: "********ZHLK", user: null },
    ];
    for (const scenario of scenarios) {
      mocks.requestRows.mockClear();
      bridged = scenario.bridge;
      mocks.transfers.mockResolvedValue(scenario.link.map((client_sf_id) => ({ client_sf_id })));
      const input = { recordId: "rec-1", cedarRidgeUserId: scenario.user, maskedAccount: scenario.masked };
      const prefill = await readReimbursementPrefill(IDENTITY, input);
      const read = await readTransferFeeRequests(IDENTITY, input);
      if (prefill.client && prefill.accountId) {
        const account = prefill.client.accounts.find((a) => a.id === prefill.accountId);
        expect(read).toMatchObject({ identity: "resolved", clientName: prefill.client.name, accountLabel: account?.label });
        const where = (mocks.requestRows.mock.calls.at(-1)?.[0] as { where: { account_ids: { has: string } } }).where;
        expect(where.account_ids.has).toBe(prefill.accountId);
      } else {
        expect(read).toMatchObject({ identity: "unresolved", reason: prefill.client ? "account" : "client" });
      }
    }
    markCase(SUITE, "uses the same client and account as the confirm flow's preview for the same transfer");
  });

  it("returns the 50 newest and says so when more exist, and says nothing when exactly 50 exist", async () => {
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    const many = (count: number) => Array.from({ length: count }, (_, index) => row(`req_${index}`, "CREDITED", "10.00"));
    mocks.requestRows.mockResolvedValue(many(TRANSFER_FEE_REQUESTS_LIMIT + 1));
    const cut = await readTransferFeeRequests(IDENTITY, INPUT);
    expect(cut).toMatchObject({ identity: "resolved", truncated: true });
    expect(cut.identity === "resolved" ? cut.requests : []).toHaveLength(TRANSFER_FEE_REQUESTS_LIMIT);
    mocks.requestRows.mockResolvedValue(many(TRANSFER_FEE_REQUESTS_LIMIT));
    const exact = await readTransferFeeRequests(IDENTITY, INPUT);
    expect(exact).toMatchObject({ identity: "resolved", truncated: false });
    expect(exact.identity === "resolved" ? exact.requests : []).toHaveLength(TRANSFER_FEE_REQUESTS_LIMIT);
    markCase(SUITE, "returns the 50 newest and says so when more exist, and says nothing when exactly 50 exist");
  });

  it("lets a failed query reject so the action can report a retryable failure", async () => {
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    mocks.requestRows.mockRejectedValue(new Error("db down"));
    await expect(readTransferFeeRequests(IDENTITY, INPUT)).rejects.toThrow("db down");
    markCase(SUITE, "lets a failed query reject so the action can report a retryable failure");
  });
});
