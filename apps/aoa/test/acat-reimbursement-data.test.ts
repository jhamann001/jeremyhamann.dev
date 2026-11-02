import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

type Sql = { sql: string; values: unknown[] };
const mocks = vi.hoisted(() => ({
  create: vi.fn(), detail: vi.fn(), transfers: vi.fn(), pendingRows: vi.fn(), raw: vi.fn(), scope: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({
  withUserScope: async (identity: unknown, run: (tx: unknown) => Promise<unknown>) => {
    mocks.scope(identity);
    return run({
      transfer: { findMany: mocks.transfers },
      operationsFeeRequest: { findMany: mocks.pendingRows },
      $queryRaw: mocks.raw,
    });
  },
}));
vi.mock("@/lib/data/operations-fee-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/operations-fee-requests")>()),
  createOperationsFeeRequest: mocks.create,
  operationsFeeRequestDetail: mocks.detail,
}));

import {
  createReimbursementRequest,
  readPendingReimbursements,
  readReimbursementPrefill,
} from "@/lib/data/acat-reimbursement";

const SUITE = "acat-reimbursement-data";
const IDENTITY = { role: "OPERATIONS", email: "synthetic@example.test" };
const PAT = "003BLO191836131AAA";
const SAM = "003MLO108774638AAA";
const KEY = "6fc31a81-ae16-4a1d-849b-7c69cb575a4d";

type Client = { sf_id: string; name: string; household_name: string | null };
type Account = { custodian_account_id: string; apex_account_number: string | null; account_type: string | null; account_status: string | null; client_sf_id: string };
const CLIENTS: Record<string, Client> = {
  "003BLO191836131": { sf_id: PAT, name: "Pat Example", household_name: "Example Household" },
  "003MLO108774638": { sf_id: SAM, name: "Sam Example", household_name: null },
};
const ACCOUNTS: Record<string, Account[]> = {
  "003BLO191836131": [
    { custodian_account_id: "acct-1", apex_account_number: "5YA01ZHLK", account_type: "IRA", account_status: "OPEN", client_sf_id: PAT },
    { custodian_account_id: "acct-2", apex_account_number: "9TZ68ZZZZ", account_type: "Brokerage", account_status: "OPEN", client_sf_id: PAT },
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

beforeEach(() => {
  vi.clearAllMocks();
  bridged = [];
  mocks.transfers.mockResolvedValue([]);
  mocks.pendingRows.mockResolvedValue([]);
  install();
});

const INPUT = { recordId: "rec-1", cedarRidgeUserId: null, maskedAccount: "********ZHLK" };

describe("reimbursement preview reads (ticket)", () => {
  it("prefills the linked client and the one account that ends with the transfer's masked suffix", async () => {
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    mocks.pendingRows.mockResolvedValue([{ id: "req_1", fee_amount: { toFixed: () => "50.00" }, fee_types: ["ACAT out"], submitted_at: new Date("2026-10-14T12:00:00Z") }]);
    const prefill = await readReimbursementPrefill(IDENTITY, INPUT);
    expect(prefill.clientSource).toBe("transfer-link");
    expect(prefill.client).toMatchObject({ clientSfId: PAT, name: "Pat Example", householdName: "Example Household" });
    expect(prefill.accountId).toBe("acct-1");
    expect(prefill.client?.accounts.map((a) => [a.id, a.label, a.matchesTransfer])).toEqual([
      ["acct-1", "IRA · ••••ZHLK", true], ["acct-2", "Brokerage · ••••ZZZZ", false],
    ]);
    expect(prefill.pending).toEqual([{ id: "req_1", feeAmount: "50.00", feeTypes: ["ACAT out"], submittedAt: "2026-10-14T12:00:00.000Z" }]);
    expect(mocks.scope).toHaveBeenCalledWith(IDENTITY);
    expect(mocks.transfers).toHaveBeenCalledWith(expect.objectContaining({ where: { acat_record_id: "rec-1" } }));
    expect(mocks.create).not.toHaveBeenCalled();
    markCase(SUITE, "prefills the linked client and the one account that ends with the transfer's masked suffix");
  });

  it("falls back to the record's CedarRidge user id and treats an agreeing 18 and 15 character id as one client", async () => {
    bridged = [PAT];
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT.slice(0, 15) }]);
    expect((await readReimbursementPrefill(IDENTITY, { ...INPUT, cedarRidgeUserId: "user-1" })).clientSource).toBe("transfer-link");
    mocks.transfers.mockResolvedValue([]);
    const directory = await readReimbursementPrefill(IDENTITY, { ...INPUT, cedarRidgeUserId: "user-1" });
    expect(directory.clientSource).toBe("directory");
    expect(directory.client?.clientSfId).toBe(PAT);
    markCase(SUITE, "falls back to the record's CedarRidge user id and treats an agreeing 18 and 15 character id as one client");
  });

  it("chooses no client when the link and the directory disagree, or when nothing resolves, and never looks one up by name", async () => {
    bridged = [SAM];
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    expect(await readReimbursementPrefill(IDENTITY, { ...INPUT, cedarRidgeUserId: "user-1" }))
      .toEqual({ client: null, clientSource: "conflict", accountId: null, pending: [] });
    mocks.transfers.mockResolvedValue([]);
    bridged = [];
    expect(await readReimbursementPrefill(IDENTITY, INPUT)).toEqual({ client: null, clientSource: "none", accountId: null, pending: [] });
    mocks.transfers.mockResolvedValue([{ client_sf_id: "003QBSURLA45937" }]);
    expect((await readReimbursementPrefill(IDENTITY, INPUT)).client).toBeNull();
    for (const [query] of mocks.raw.mock.calls as Array<[Sql]>) expect(query.sql).not.toMatch(/first_name\s+(I?LIKE|=)|last_name\s+(I?LIKE|=)|\bname\b\s*(I?LIKE|=)/i);
    markCase(SUITE, "chooses no client when the link and the directory disagree, or when nothing resolves, and never looks one up by name");
  });

  it("leaves the account empty when no account or more than one account matches the suffix", async () => {
    mocks.transfers.mockResolvedValue([{ client_sf_id: PAT }]);
    expect((await readReimbursementPrefill(IDENTITY, { ...INPUT, maskedAccount: "********QQQQ" })).accountId).toBeNull();
    expect((await readReimbursementPrefill(IDENTITY, { ...INPUT, maskedAccount: null })).accountId).toBeNull();
    ACCOUNTS["003BLO191836131"].push({ custodian_account_id: "acct-3", apex_account_number: "1YI86ZHLK", account_type: "Roth", account_status: "OPEN", client_sf_id: PAT });
    try {
      const both = await readReimbursementPrefill(IDENTITY, INPUT);
      expect(both.accountId).toBeNull();
      expect(both.client?.accounts.filter((a) => a.matchesTransfer).map((a) => a.id)).toEqual(["acct-1", "acct-3"]);
      expect(both.pending).toEqual([]);
    } finally {
      ACCOUNTS["003BLO191836131"].pop();
    }
    markCase(SUITE, "leaves the account empty when no account or more than one account matches the suffix");
  });

  it("looks up Pending requests only for an account the client owns", async () => {
    expect(await readPendingReimbursements(IDENTITY, PAT, "acct-9")).toEqual([]);
    expect(mocks.pendingRows).not.toHaveBeenCalled();
    expect(await readPendingReimbursements(IDENTITY, "003QBSURLA45937", "acct-1")).toEqual([]);
    await readPendingReimbursements(IDENTITY, PAT, "acct-1");
    const query = mocks.pendingRows.mock.calls[0][0] as { where: Record<string, unknown>; take: number };
    expect(query.where).toMatchObject({ kind: "FEE_CREDIT", status: "PENDING", account_ids: { has: "acct-1" } });
    expect(query.take).toBe(10);
    expect((query.where.OR as unknown[])).toEqual([{ client_sf_id: PAT }, { client_sf_id: { startsWith: PAT.slice(0, 15), mode: "insensitive" } }]);
    markCase(SUITE, "looks up Pending requests only for an account the client owns");
  });
});

describe("reimbursement create (ticket)", () => {
  const SAVED = {
    id: "req_000000000000001", status: "PENDING", clientName: "Pat Example", feeAmount: "50.00", feeTypes: ["ACAT out"],
    submittedAt: "2026-10-15T12:00:00.000Z", accounts: [{ id: "acct-1", label: "IRA · ••••ZHLK", ownerName: "Pat Example" }],
  };
  const CONFIRMED = { submissionKey: KEY, clientSfId: PAT, accountId: "acct-1", feeAmount: "50.00", feeTypes: ["ACAT out"], reason: "Reason", tickets: "APX-1, APX-2" };

  it("creates one FEE_CREDIT request through the intake's create path with the confirmed ids and key", async () => {
    mocks.create.mockResolvedValue(SAVED.id);
    mocks.detail.mockResolvedValue(SAVED);
    const result = await createReimbursementRequest(IDENTITY, CONFIRMED);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(IDENTITY, {
      kind: "FEE_CREDIT", clientSfId: PAT, accountIds: ["acct-1"], feeTypes: ["ACAT out"], feeAmount: "50.00",
      waiverStart: null, waiverDurationMonths: null, indefiniteDuration: false, reason: "Reason", relevantTicketRefs: ["APX-1", "APX-2"],
    }, KEY);
    expect(result).toEqual({ ok: true, request: { id: SAVED.id, status: "PENDING", clientName: "Pat Example", accountLabel: "IRA · ••••ZHLK", feeAmount: "50.00", feeTypes: ["ACAT out"], submittedAt: SAVED.submittedAt } });
    markCase(SUITE, "creates one FEE_CREDIT request through the intake's create path with the confirmed ids and key");
  });

  it("still reports success with the confirmed values when the read-back fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.create.mockResolvedValue(SAVED.id);
    mocks.detail.mockRejectedValue(new Error("read failed"));
    const result = await createReimbursementRequest(IDENTITY, CONFIRMED);
    expect(result).toMatchObject({ ok: true, request: { id: SAVED.id, status: "PENDING", clientName: null, accountLabel: null, feeAmount: "50.00", feeTypes: ["ACAT out"] } });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    markCase(SUITE, "still reports success with the confirmed values when the read-back fails");
  });

  it("refuses an invalid form before any write and names the field", async () => {
    const cases: Array<[Partial<typeof CONFIRMED>, string]> = [
      [{ accountId: "" }, "account"], [{ clientSfId: "Pat Example" }, "client"], [{ feeAmount: "0" }, "amount"],
      [{ feeTypes: [] }, "feeTypes"], [{ feeTypes: ["Made up"] }, "feeTypes"], [{ reason: "x".repeat(2001) }, "reason"],
      [{ tickets: "x".repeat(81) }, "tickets"],
    ];
    for (const [patch, field] of cases) {
      expect(await createReimbursementRequest(IDENTITY, { ...CONFIRMED, ...patch }), JSON.stringify(patch)).toEqual({ ok: false, code: "invalid", field });
    }
    expect(mocks.create).not.toHaveBeenCalled();
    markCase(SUITE, "refuses an invalid form before any write and names the field");
  });

  it("maps the create path's refusals to fixed codes and never forwards their text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: Array<[string, string]> = [
      ["client_unavailable", "identity"], ["account_unavailable", "identity"], ["submission_conflict", "conflict"],
      ["actor_unavailable", "forbidden"], ["connection reset by peer 10.0.0.1", "failed"],
    ];
    for (const [message, code] of cases) {
      mocks.create.mockRejectedValueOnce(new Error(message));
      expect(await createReimbursementRequest(IDENTITY, CONFIRMED), message).toEqual({ ok: false, code, field: null });
    }
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(" ")).not.toContain("10.0.0.1");
    spy.mockRestore();
    markCase(SUITE, "maps the create path's refusals to fixed codes and never forwards their text");
  });

  it("is the Operations Tools create path only: no tracker adapter and no Fee Store in the data layer", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("lib/data/acat-reimbursement.ts", "utf8");
    expect(source).not.toMatch(/acat-fee"|acat-status|readAcatMachine|writeAcatBookRecord|postTransferFee|feeStore|action:\s*"log"/i);
    markCase(SUITE, "is the Operations Tools create path only: no tracker adapter and no Fee Store in the data layer");
  });
});
