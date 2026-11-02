import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  library: vi.fn(), tracker: vi.fn(), fee: vi.fn(), requests: vi.fn(),
  bookEnabled: vi.fn(), editsEnabled: vi.fn(), feeEnabled: vi.fn(), requestsEnabled: vi.fn(),
}));
vi.mock("@/lib/data/custodian-library", () => ({ getCustodianLibrary: mocks.library }));
vi.mock("@/lib/data/acat-status", () => ({ readAcatMachine: mocks.tracker }));
vi.mock("@/lib/data/acat-fee", () => ({ readTransferFee: mocks.fee }));
vi.mock("@/lib/data/acat-reimbursement", () => ({ readTransferFeeRequests: mocks.requests }));
vi.mock("@/lib/flags", () => ({
  acatOpsBookEnabled: mocks.bookEnabled,
  acatOpsEditsEnabled: mocks.editsEnabled,
  acatFeeReimbursementEnabled: mocks.feeEnabled,
  operationsFeeRequestsPreviewEnabled: mocks.requestsEnabled,
}));

import { readTransferFeeReview } from "@/lib/data/transfer-fee-review";
import type { CustodianProfile } from "@/lib/data/custodian-library-contract";
import { FEE_FIELD_KEYS, type TransferFee } from "@/lib/data/acat-fee-view";

const IDENTITY = { role: "OPERATIONS", email: "operator@example.test" };
const TRANSFER = { id: "transfer-1", acat_record_id: "record/1", transferring_firm: "Example Custodian" };
const FEE: TransferFee = {
  feeCharged: "Yes", feeAmount: "75.00", feeMemo: "Transfer charge",
  feeRequestSubmitted: "2026-10-27", feeRequestCompleted: null,
  feeApexTicket: "ticket-1", feeCreditRequestId: "request-1",
};
const RAW = {
  id: TRANSFER.acat_record_id, clientName: "Synthetic Client", direction: "In", type: "Full",
  status: "Completed", transferringContra: "Example Custodian", custodianId: "custodian-1",
  controlNumber: "control-1", apexAccountId: "APEXACCOUNT1234", cedarRidgeUserId: "cedar-ridge-user-1",
  transferWorkflow: "ACAT", unrelatedPrivateField: "must-not-leave-server",
};
const REQUEST = {
  id: "request-1", kind: "FEE_CREDIT", status: "PENDING", feeAmount: "75.00",
  feeTypes: ["TRANSFER_FEE"], submittedAt: "2026-10-27T00:00:00.000Z", creditedAt: null,
};
const RETRIEVED_AT = "2026-10-28T00:00:00.000Z";

function custodian(overrides: Partial<CustodianProfile> = {}): CustodianProfile {
  return {
    id: "custodian-1", name: "Example Custodian", reviewStatus: "Reviewed", acatFeeAmount: 75,
    transferType: "ACAT", documentationStatus: "Current", dtcNumber: "1234", receivingAccountNumber: "PRIVATE-ACCOUNT",
    signature: null, letterOfAcceptance: null, medallionRequired: null, liquidationMethod: null,
    returnMethod: null, watchouts: null, paperworkOnFile: null, transfersToDate: null,
    contactEmail: "private-contact@example.test", configuredExpectedProcessingDays: null,
    observedAvgProcessingBusinessDays: null, observedCompletedTransfers: 0,
    fees: [{
      id: "fee-1", feeType: "Transfer fee", accountType: "IRA", transferType: "FULL", direction: "OUT",
      amount: 75, amountText: "See exceptions", notes: "Applies to full transfers", documentation: "Statement required",
      createdAt: RETRIEVED_AT, updatedAt: RETRIEVED_AT,
    }],
    feeSchedules: [{
      id: "schedule-1", filename: "fees.pdf", contentType: "application/pdf", byteSize: 100,
      sha256: "a".repeat(64), createdAt: RETRIEVED_AT,
    }],
    ...overrides,
  };
}

function library(custodians: CustodianProfile[] = [custodian()]) {
  mocks.library.mockResolvedValue({ schemaVersion: 1, retrievedAt: RETRIEVED_AT, custodians });
}
function tracker(overrides: Record<string, unknown> = {}) {
  mocks.tracker.mockResolvedValue({ status: 200, data: { ...RAW, ...overrides } });
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const flag of [mocks.bookEnabled, mocks.editsEnabled, mocks.feeEnabled, mocks.requestsEnabled]) flag.mockReturnValue(true);
  library();
  tracker();
  mocks.fee.mockResolvedValue({ ok: true, fee: FEE, log: [{ id: "legacy-log-not-authoritative" }] });
  mocks.requests.mockResolvedValue({ identity: "resolved", clientName: "Synthetic Client", accountLabel: "Brokerage · ****1234", requests: [REQUEST], truncated: false });
});

describe("asset-transfer Fee review data", () => {
  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER", "OPS", "admin", "", null, undefined])("restricts %s before every source read", async role => {
    const result = await readTransferFeeReview({ ...IDENTITY, role }, TRANSFER);
    expect(result).toEqual({
      library: { state: "restricted" }, actual: { state: "restricted" }, requests: { state: "restricted" }, record: null, recordId: null,
    });
    for (const read of [mocks.library, mocks.tracker, mocks.fee, mocks.requests]) expect(read).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "OPERATIONS"])("projects every fee rule and schedule field for one exact custodian for %s", async role => {
    library([custodian(), custodian({ id: "unrelated", name: "Unrelated Custodian" })]);
    const result = await readTransferFeeReview({ ...IDENTITY, role }, TRANSFER);
    expect(mocks.library).toHaveBeenCalledWith(role);
    expect(result.library).toEqual({
      state: "ready", matchedBy: "id", retrievedAt: RETRIEVED_AT,
      custodian: {
        id: "custodian-1", name: "Example Custodian", reviewStatus: "Reviewed", acatFeeAmount: 75,
        documentationStatus: "Current", fees: custodian().fees, feeSchedules: custodian().feeSchedules,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-ACCOUNT|private-contact|must-not-leave-server|legacy-log-not-authoritative|Unrelated Custodian/);
    expect(result.actual).toEqual({ state: "ready", fee: FEE });
    expect(result.record?.apexAccountId).toBe("********1234");
    expect(JSON.stringify(result)).not.toContain(RAW.apexAccountId);
  });

  it("routes the exact stored record id and only validated masked identity hints", async () => {
    const result = await readTransferFeeReview(IDENTITY, TRANSFER);
    expect(mocks.tracker).toHaveBeenCalledWith("/api/machine/acats/by-record/record%2F1");
    expect(mocks.fee).toHaveBeenCalledWith("record/1");
    expect(mocks.requests).toHaveBeenCalledWith(IDENTITY, {
      recordId: "record/1", cedarRidgeUserId: "cedar-ridge-user-1", maskedAccount: "********1234",
    });
    expect(result.requests).toEqual({
      state: "ready", scope: "account", accountLabel: "Brokerage · ****1234", requests: [REQUEST], truncated: false,
    });
    expect(result.requests).not.toHaveProperty("clientName");
  });

  it("uses the account link resolver with no guessed user id on the current tracker contract", async () => {
    tracker({ custodianId: undefined, cedarRidgeUserId: undefined });
    const result = await readTransferFeeReview(IDENTITY, { ...TRANSFER, delivering_custodian_id: "custodian-1" });
    expect(result.library).toMatchObject({ state: "ready", matchedBy: "id" });
    expect(mocks.requests).toHaveBeenCalledWith(IDENTITY, {
      recordId: "record/1", cedarRidgeUserId: null, maskedAccount: "********1234",
    });
  });

  it("rejects a response for another tracker record before using any of its hints", async () => {
    tracker({ id: "another-record", ...FEE });
    const result = await readTransferFeeReview(IDENTITY, TRANSFER);
    expect(result).toEqual({ library: { state: "unavailable" }, actual: { state: "unavailable" }, requests: { state: "unavailable" }, record: null, recordId: TRANSFER.acat_record_id });
    expect(mocks.fee).not.toHaveBeenCalled();
    expect(mocks.requests).not.toHaveBeenCalled();
  });

  it.each([null, ""]) ("reads the canonical library by the custodian profile id for an unlinked transfer (%s)", async acat_record_id => {
    const result = await readTransferFeeReview(IDENTITY, { ...TRANSFER, acat_record_id, delivering_custodian_id: "custodian-1" });
    expect(result.library).toMatchObject({ state: "ready", matchedBy: "id" });
    expect((await readTransferFeeReview(IDENTITY, { ...TRANSFER, acat_record_id })).library)
      .toEqual({ state: "unmatched", reason: "missing_custodian" });
    expect(result.actual).toEqual({ state: "not_linked" });
    expect(result.requests).toEqual({ state: "not_linked" });
    expect(result.record).toBeNull();
    for (const read of [mocks.tracker, mocks.fee, mocks.requests]) expect(read).not.toHaveBeenCalled();
  });

  it("reports no link when neither a tracker record nor a custodian name is stored", async () => {
    const result = await readTransferFeeReview(IDENTITY, { ...TRANSFER, acat_record_id: null, transferring_firm: null });
    expect(result.library).toEqual({ state: "not_linked" });
  });

  it("never picks a library entry by a custodian name, even an exact one", async () => {
    tracker({ custodianId: null, transferringContra: " example  CUSTODIAN " });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).library).toEqual({ state: "unmatched", reason: "missing_custodian" });
    library([custodian(), custodian({ id: "custodian-2", name: " example  custodian " })]);
    expect((await readTransferFeeReview(IDENTITY, { ...TRANSFER, delivering_custodian_id: "custodian-2" })).library)
      .toMatchObject({ state: "ready", custodian: { id: "custodian-2" } });
  });

  it("does not fall back to a matching name when the linked immutable id is unknown", async () => {
    tracker({ custodianId: "unknown-id" });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).library).toEqual({ state: "unmatched", reason: "not_found" });
  });

  it("prefers the exact linked custodian id over a different stored name", async () => {
    const result = await readTransferFeeReview(IDENTITY, { ...TRANSFER, transferring_firm: "Another Name" });
    expect(result.library).toMatchObject({ state: "ready", matchedBy: "id", custodian: { id: "custodian-1" } });
  });

  it("uses the transfer's custodian profile id when the tracker names no custodian id", async () => {
    tracker({ custodianId: null, transferringContra: "Another Custodian" });
    const result = await readTransferFeeReview(IDENTITY, { ...TRANSFER, transferring_firm: "Another Name", delivering_custodian_id: "custodian-1" });
    expect(result.library).toMatchObject({ state: "ready", matchedBy: "id", custodian: { id: "custodian-1" } });
    const unlinked = await readTransferFeeReview(IDENTITY, { ...TRANSFER, acat_record_id: null, transferring_firm: null, delivering_custodian_id: "custodian-1" });
    expect(unlinked.library).toMatchObject({ state: "ready", matchedBy: "id" });
    tracker({ custodianId: "custodian-1" });
    expect((await readTransferFeeReview(IDENTITY, { ...TRANSFER, delivering_custodian_id: "custodian-2" })).library)
      .toEqual({ state: "unmatched", reason: "conflict" });
  });

  it("asks for the custodian profile when only differing names are known", async () => {
    tracker({ custodianId: null, transferringContra: "Another Custodian" });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).library).toEqual({ state: "unmatched", reason: "missing_custodian" });
  });

  it("treats a malformed custodian id as unavailable rather than missing", async () => {
    tracker({ custodianId: 123 });
    const result = await readTransferFeeReview(IDENTITY, TRANSFER);
    expect(result.library).toEqual({ state: "unavailable" });
    expect(result.actual.state).toBe("ready");
  });

  it("keeps library amounts and stored fee nulls distinct from explicit zero", async () => {
    const emptyFee = Object.fromEntries(FEE_FIELD_KEYS.map(key => [key, null])) as TransferFee;
    library([custodian({ acatFeeAmount: null, fees: [
      { ...custodian().fees[0], id: "unknown", amount: null, amountText: "Varies" },
      { ...custodian().fees[0], id: "waived", amount: 0, amountText: null },
    ] })]);
    mocks.fee.mockResolvedValue({ ok: true, fee: emptyFee, log: null });
    const unknown = await readTransferFeeReview(IDENTITY, TRANSFER);
    expect(unknown.actual).toEqual({ state: "ready", fee: emptyFee });
    expect(unknown.library).toMatchObject({ custodian: { acatFeeAmount: null, fees: [{ amount: null }, { amount: 0 }] } });
    mocks.fee.mockResolvedValue({ ok: true, fee: { ...emptyFee, feeAmount: "0", feeCharged: "No" }, log: null });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).actual).toEqual({ state: "ready", fee: { ...emptyFee, feeAmount: "0", feeCharged: "No" } });
  });

  it("retains actual fee and requests when the canonical library is unavailable", async () => {
    mocks.library.mockRejectedValue(new Error("unavailable"));
    const result = await readTransferFeeReview(IDENTITY, TRANSFER);
    expect(result.library).toEqual({ state: "unavailable" });
    expect(result.actual).toEqual({ state: "ready", fee: FEE });
    expect(result.requests.state).toBe("ready");
  });

  it("retains library and actual fee when account requests fail", async () => {
    mocks.requests.mockRejectedValue(new Error("unavailable"));
    const result = await readTransferFeeReview(IDENTITY, TRANSFER);
    expect(result.library.state).toBe("ready");
    expect(result.actual).toEqual({ state: "ready", fee: FEE });
    expect(result.requests).toEqual({ state: "unavailable" });
  });

  it("retains library and account requests when fee data is unavailable", async () => {
    mocks.fee.mockResolvedValue({ ok: false, code: "transport", fee: null, log: null });
    const result = await readTransferFeeReview(IDENTITY, TRANSFER);
    expect(result.library.state).toBe("ready");
    expect(result.actual).toEqual({ state: "unavailable" });
    expect(result.requests.state).toBe("ready");
  });

  it("preserves stored fee values from a partial response without reporting a complete read", async () => {
    mocks.fee.mockResolvedValue({ ok: false, code: "internal_error", fee: FEE, log: null });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).actual).toEqual({ state: "partial", fee: FEE, code: "internal_error" });
  });

  it("uses all seven validated raw fields as a partial read if the fee route is unavailable", async () => {
    tracker(FEE);
    mocks.fee.mockResolvedValue({ ok: false, code: "not_found", fee: null, log: null });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).actual).toEqual({ state: "partial", fee: FEE, code: "not_found" });
    tracker({ ...FEE, feeAmount: 75 });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).actual).toEqual({ state: "unavailable" });
    tracker({ ...FEE, feeMemo: undefined });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).actual).toEqual({ state: "unavailable" });
  });

  it.each(["bookEnabled", "editsEnabled", "feeEnabled"] as const)("preserves the %s rollout gate before fees and requests", async flag => {
    mocks[flag].mockReturnValue(false);
    tracker(FEE);
    const result = await readTransferFeeReview(IDENTITY, TRANSFER);
    expect(result.library.state).toBe("ready");
    expect(result.actual).toEqual({ state: "off" });
    expect(result.requests).toEqual({ state: "off" });
    expect(mocks.fee).not.toHaveBeenCalled();
    expect(mocks.requests).not.toHaveBeenCalled();
  });

  it("preserves the Operations preview gate independently of stored fee reads", async () => {
    mocks.requestsEnabled.mockReturnValue(false);
    const result = await readTransferFeeReview(IDENTITY, TRANSFER);
    expect(result.actual.state).toBe("ready");
    expect(result.requests).toEqual({ state: "off" });
    expect(mocks.requests).not.toHaveBeenCalled();
  });

  it("does not read account requests without an authenticated email", async () => {
    const result = await readTransferFeeReview({ role: "ADMIN", email: null }, TRANSFER);
    expect(result.requests).toEqual({ state: "restricted" });
    expect(mocks.requests).not.toHaveBeenCalled();
  });

  it.each(["client", "account"] as const)("keeps unresolved %s separate from no requests on file", async reason => {
    mocks.requests.mockResolvedValue({ identity: "unresolved", reason });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).requests).toEqual({ state: "unmatched", reason });
  });

  it("preserves empty verified requests, truncation and uncredited status without inventing a credit", async () => {
    mocks.requests.mockResolvedValue({ identity: "resolved", accountLabel: "****1234", clientName: "Synthetic Client", requests: [], truncated: false });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).requests).toEqual({ state: "ready", scope: "account", accountLabel: "****1234", requests: [], truncated: false });
    mocks.requests.mockResolvedValue({ identity: "resolved", accountLabel: "****1234", clientName: "Synthetic Client", requests: [REQUEST], truncated: true });
    expect((await readTransferFeeReview(IDENTITY, TRANSFER)).requests).toMatchObject({ state: "ready", truncated: true, requests: [{ status: "PENDING", creditedAt: null }] });
  });

  it("does not fall back to a stored name or leak unvalidated hints on tracker transport failure", async () => {
    mocks.tracker.mockRejectedValue(new Error("failed"));
    const result = await readTransferFeeReview(IDENTITY, TRANSFER);
    expect(result.library).toEqual({ state: "unavailable" });
    expect(result.record).toBeNull();
    expect(mocks.requests).not.toHaveBeenCalled();
  });
});
