import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  auth: vi.fn(),
  scope: vi.fn(),
  workspace: vi.fn(() => true),
  paperwork: vi.fn(() => true),
  feeRequests: vi.fn(),
  linkedUser: vi.fn(),
  trades: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: spies.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: spies.scope }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findMany: vi.fn(async () => []) } } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn(() => true) }));
vi.mock("@/lib/flags", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  assetTransferWorkspaceEnabled: spies.workspace,
  paperworkRecordsEnabled: spies.paperwork,
}));
vi.mock("@/lib/data/acat-reimbursement", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  readClientFeeRequests: spies.feeRequests,
}));
vi.mock("@/lib/data/clients", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getCedarRidgeUserIdForLinkedReads: spies.linkedUser,
}));
vi.mock("@/lib/data/trade-requests", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  readTradeRequestsForUserCached: spies.trades,
}));

import { connectedIdentity, controlNumberCheck, accountTypeFromLabel } from "@/lib/transfers/connections";
import { openApexReceivingOptions, reconcileReceivingAccounts, suggestedCustodian } from "@/lib/data/transfer-connections";
import {
  linkTransferClient,
  linkTransferDeal,
  searchTransferClients,
  setDeliveringCustodian,
} from "@/app/(authenticated)/asset-transfer/connection-actions";
import { saveFeeReimbursement, saveInvestmentLink, setAccountStatus, updateTransfer } from "@/app/(authenticated)/asset-transfer/actions";
import { transferToFormValues } from "@/components/transfers/transfer-form";

const STORED = { client_first_name: "Typed", client_last_name: "Name", household_name: "Typed Household", household_sf_id: "HH-TYPED" };
const CLIENT = { sfId: "SF-CLIENT-1", name: "Directory Person", householdSfId: "HH-DIR", householdName: "Directory Household" };
const DEAL = { clientFirstName: "Deal", clientLastName: "Person", householdName: "Deal Household", householdSfId: "HH-DEAL" };

const OPS = { user: { email: "ops@example.test", role: "OPERATIONS" } };
const CS = { user: { email: "cs@example.test", role: "CLIENT_SERVICE" } };

type Tx = Record<string, unknown>;

function scope(tx: Tx) {
  spies.scope.mockImplementation(async (_identity: unknown, fn: (t: Tx) => Promise<unknown>) => fn(tx));
}

function directoryRow() {
  return { sf_id: "SF-CLIENT-1", first_name: "Directory", last_name: "Person", household_sf_id: "HH-DIR", household_name: "Directory Household" };
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.workspace.mockReturnValue(true);
  spies.paperwork.mockReturnValue(true);
  spies.auth.mockResolvedValue(OPS);
});

describe("connected records, pure rules", () => {
  it("prefers the directory client, then the deal, then the recorded fields", () => {
    expect(connectedIdentity(STORED, CLIENT, DEAL)).toMatchObject({ name: "Directory Person", householdName: "Directory Household", source: "directory" });
    expect(connectedIdentity(STORED, null, DEAL)).toMatchObject({ name: "Deal Person", householdName: "Deal Household", source: "deal" });
    expect(connectedIdentity(STORED, null, null)).toMatchObject({ name: "Typed Name", householdName: "Typed Household", source: "recorded" });
  });

  it("compares a typed control number with the tracker's", () => {
    expect(controlNumberCheck("abc 123", null)).toEqual({ state: "none" });
    expect(controlNumberCheck("", "IOP812")).toEqual({ state: "tracker-only", tracker: "IOP812" });
    expect(controlNumberCheck("iop 812", "IOP812")).toEqual({ state: "match", tracker: "IOP812" });
    expect(controlNumberCheck("XYZ999", "IOP812")).toEqual({ state: "mismatch", tracker: "IOP812", typed: "XYZ999" });
  });

  it("lets a same-type Apex account decide the receiving status, and labels a manual one", () => {
    expect(accountTypeFromLabel("Roth IRA · Directory Person")).toBe("Roth IRA");
    const apex = [{ account_type: "Roth IRA", account_status: "Open", apex_account_number: "2MC713363" }];
    const accounts = [
      { id: "a1", label: "Roth IRA · Directory Person", status: "TO_OPEN" },
      { id: "a2", label: "Individual · Directory Person", status: "OPEN" },
    ];
    expect(reconcileReceivingAccounts(accounts, apex, null)).toEqual([
      { id: "a1", label: accounts[0].label, status: "OPEN", source: "apex", apexMasked: "••••3363" },
      { id: "a2", label: accounts[1].label, status: "OPEN", source: "manual", apexMasked: null },
    ]);
  });

  it("offers open Apex accounts once each, masked", () => {
    const options = openApexReceivingOptions([
      { account_type: "Roth IRA", account_status: "Open", apex_account_number: "2MC713363" },
      { account_type: "Roth IRA", account_status: "Open", apex_account_number: "2MC713363" },
      { account_type: "Individual", account_status: "Closed", apex_account_number: "3ZZ963082" },
    ]);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ type: "Roth IRA", masked: "••••3363" });
    expect(JSON.stringify(options)).not.toContain("2MC713363");
  });

  it("suggests a custodian profile only on one exact name match", () => {
    const options = [{ id: "c1", name: "Sample Custodian" }, { id: "c2", name: "Other Custodian" }];
    expect(suggestedCustodian(options, " sample  custodian ")).toEqual(options[0]);
    expect(suggestedCustodian(options, "Sample")).toBeNull();
    expect(suggestedCustodian([...options, { id: "c3", name: "Sample Custodian" }], "Sample Custodian")).toBeNull();
  });
});

describe("connection actions", () => {
  it("refuse with the workspace flag off", async () => {
    spies.workspace.mockReturnValue(false);
    expect(await searchTransferClients("Directory")).toEqual({ ok: false });
    expect((await linkTransferDeal("T1", "deal-1")).ok).toBe(false);
    expect((await linkTransferClient("T1", "SF-CLIENT-1")).ok).toBe(false);
    expect((await setDeliveringCustodian("T1", "c1")).ok).toBe(false);
    expect(spies.scope).not.toHaveBeenCalled();
  });

  it("link a deal only when the transfer has none and the deal is free and the client's", async () => {
    const update = vi.fn(async () => ({}));
    const audit = vi.fn(async () => ({}));
    const transfer = { archived_at: null, client_sf_id: "SF-CLIENT-1", household_sf_id: "HH-DIR", deal_id: null as string | null };
    const deals = [{ id: "deal-1", sf_deal_id: "SF-DEAL-1", name: "Synthetic", amount: 100, stage: "OPEN", client_sf_id: "SF-CLIENT-1",
      account_last4: "1234", transferring_firm: "Sample", linked_transfer_id: null as string | null }];
    scope({
      $queryRaw: vi.fn(async (sql: { strings?: string[] }) => (String(sql?.strings ?? "").includes("FOR UPDATE") ? [{ id: "T1" }] : deals)),
      transfer: { findUnique: vi.fn(async () => transfer), update },
      auditLog: { create: audit },
    });
    expect(await linkTransferDeal("T1", "deal-1")).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith({ where: { id: "T1" }, data: expect.objectContaining({ deal_id: "deal-1", deal_sf_id: "SF-DEAL-1" }) });
    expect(audit).toHaveBeenCalledTimes(1);

    update.mockClear();
    expect(await linkTransferDeal("T1", "deal-missing")).toMatchObject({ ok: false });
    deals[0].linked_transfer_id = "T-OTHER";
    expect(await linkTransferDeal("T1", "deal-1")).toMatchObject({ ok: false, error: expect.stringContaining("T-OTHER") });
    deals[0].linked_transfer_id = null;
    deals[0].client_sf_id = "SF-SOMEONE-ELSE";
    expect(await linkTransferDeal("T1", "deal-1")).toMatchObject({ ok: false, error: expect.stringContaining("different client") });
    transfer.deal_id = "deal-0";
    expect(await linkTransferDeal("T1", "deal-1")).toMatchObject({ ok: false, error: expect.stringContaining("already has") });
    expect(update).not.toHaveBeenCalled();
  });

  it("link a directory client and rewrite the client and household from it", async () => {
    const update = vi.fn(async () => ({}));
    scope({
      $queryRaw: vi.fn(async (sql: { strings?: string[] }) => (String(sql?.strings ?? "").includes("FOR UPDATE") ? [{ id: "T1" }] : [directoryRow()])),
      transfer: { findUnique: vi.fn(async () => ({ archived_at: null, client_sf_id: null, deal_id: null })), update },
      auditLog: { create: vi.fn(async () => ({})) },
    });
    spies.auth.mockResolvedValue(CS);
    expect(await linkTransferClient("T1", "SF-CLIENT-1")).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith({ where: { id: "T1" }, data: expect.objectContaining({
      client_sf_id: "SF-CLIENT-1", client_first_name: "Directory", client_last_name: "Person",
      household_sf_id: "HH-DIR", household_name: "Directory Household",
    }) });
  });

  it("set the delivering firm from an active profile, Operations only, in Preparation", async () => {
    const update = vi.fn(async () => ({}));
    const transfer = { archived_at: null, stage: "DECISION", delivering_custodian_id: null };
    const findFirst = vi.fn(async () => ({ id: "c1", name: "Sample Custodian" }));
    scope({
      $queryRaw: vi.fn(async () => [{ id: "T1" }]),
      transfer: { findUnique: vi.fn(async () => transfer), update },
      custodianProfile: { findFirst },
      auditLog: { create: vi.fn(async () => ({})) },
    });
    expect(await setDeliveringCustodian("T1", "c1")).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith({ where: { id: "T1" }, data: expect.objectContaining({
      delivering_custodian_id: "c1", transferring_firm: "Sample Custodian", funding_plan_approved_at: null,
    }) });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", retired_at: null, merged_into_id: null } }));

    update.mockClear();
    transfer.stage = "IN_TRANSFER";
    expect(await setDeliveringCustodian("T1", "c1")).toMatchObject({ ok: false });
    spies.auth.mockResolvedValue(CS);
    expect(await setDeliveringCustodian("T1", "c1")).toMatchObject({ ok: false });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("follow-up records tied to AOA records", () => {
  function followUpScope(create: ReturnType<typeof vi.fn>) {
    scope({
      $queryRaw: vi.fn(async () => [{ id: "T1" }]),
      transfer: { findUnique: vi.fn(async () => ({ id: "T1", funding_type: "ACAT_FULL", archived_at: null, client_sf_id: "SF-CLIENT-1" })) },
      transferFeeReimbursement: { create },
      transferInvestmentLink: { create },
      auditLog: { create: vi.fn(async () => ({})) },
    });
  }

  it("records a reimbursement only against one of the client's fee requests", async () => {
    const create = vi.fn(async () => ({ id: "r1" }));
    followUpScope(create);
    spies.feeRequests.mockResolvedValue({ client: true, requests: [{ id: "fee-1" }], truncated: false });
    expect(await saveFeeReimbursement("T1", { evidenced: true, feeRequestId: "fee-forged" })).toEqual({
      ok: false, errors: [expect.objectContaining({ field: "feeRequestId" })],
    });
    expect(create).not.toHaveBeenCalled();
    expect(await saveFeeReimbursement("T1", { evidenced: true, feeRequestId: "fee-1" })).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({
      data: { transfer_id: "T1", evidenced: true, operations_fee_request_id: "fee-1" }, select: { id: true },
    });
  });

  it("links only one of the client's Trade Requests", async () => {
    const create = vi.fn(async () => ({ id: "l1" }));
    followUpScope(create);
    spies.linkedUser.mockResolvedValue("user-synthetic");
    spies.trades.mockResolvedValue([{ id: "tr-1", status: "APPROVED", tradeType: "Initial", createdAt: "2026-10-01" }]);
    expect(await saveInvestmentLink("T1", { requestId: "tr-forged" })).toEqual({
      ok: false, errors: [expect.objectContaining({ field: "requestId" })],
    });
    expect(create).not.toHaveBeenCalled();
    expect(await saveInvestmentLink("T1", { requestId: "tr-1" })).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({ data: { transfer_id: "T1", linked_investment_request: "tr-1" }, select: { id: true } });
    spies.linkedUser.mockResolvedValue(null);
    expect(await saveInvestmentLink("T1", { requestId: "tr-1" })).toMatchObject({ ok: false });
  });
});

describe("receiving account status", () => {
  it("cannot be toggled when a same-type Apex account governs it, with the workspace on", async () => {
    const update = vi.fn(async () => ({}));
    scope({
      $queryRaw: vi.fn(async () => [{ account_type: "Roth IRA", account_status: "Open", apex_account_number: "2MC713363" }]),
      transfer: { findUnique: vi.fn(async () => ({ client_sf_id: "SF-CLIENT-1", receiving_account_type: "Roth IRA" })) },
      transferAccount: { findUnique: vi.fn(async () => ({ id: "a1", transfer_id: "T1", label: "Roth IRA · Directory Person", status: "OPEN" })), update },
      auditLog: { create: vi.fn(async () => ({})) },
    });
    expect(await setAccountStatus("T1", "a1", "TO_OPEN")).toMatchObject({ ok: false });
    expect(update).not.toHaveBeenCalled();
    spies.workspace.mockReturnValue(false);
    expect(await setAccountStatus("T1", "a1", "TO_OPEN")).toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("record edits in the workspace", () => {
  it("refuse typed client and household changes; those come from the directory link", async () => {
    const row = {
      id: "T1", source: "APP", stage: "DECISION", owner_kind: "CLIENT_SERVICE", value: 1000,
      client_first_name: "Directory", client_last_name: "Person", client_sf_id: "SF-CLIENT-1",
      household_name: "Directory Household", household_sf_id: "HH-DIR", owner_name: null, next_step: null,
      next_step_owner: null, pending_nudge: null, acat_record_id: null, acat_transfer_id: null, acat_link_version: 0,
    };
    const update = vi.fn(async () => ({}));
    scope({ $queryRaw: vi.fn(async () => [{ id: "T1" }]), transfer: { findUnique: vi.fn(async () => row), update } });
    const values = transferToFormValues(row as never);
    const result = await updateTransfer("T1", { ...values, client_first_name: "Typed", household_name: "Typed Household" });
    expect(result).toMatchObject({ ok: false, errors: [{ field: "client_first_name" }, { field: "household_name" }] });
    expect(update).not.toHaveBeenCalled();
  });
});
