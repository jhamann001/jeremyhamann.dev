import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/data/acat-status", () => ({ readAcatMachine: mocks.read, writeAcatBookRecord: mocks.write }));

import { postTransferFee, readTransferFee } from "@/lib/data/acat-fee";
import { FAILURE_COPY, feeFailureMessage, normalizeFailureCode, type FeeFailureCode } from "@/lib/data/acat-fee-view";

const SUITE = "acat-fee-data";
const PATH = "/api/machine/acats/by-record/rec%2F1/fees";
const FEE = {
  feeCharged: "Yes", feeAmount: "$50.00", feeMemo: "ACAT Transfer Fee: $50.00", feeRequestSubmitted: "2026-10-12",
  feeRequestCompleted: null, feeApexTicket: "APX-1", feeCreditRequestId: "77",
};
const ROW = { id: "77", status: "Pending", feeAmount: 50, feeType: "ACAT Transfer Fee", submissionDate: "2026-10-12" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("fee adapter", () => {
  it("adapter parses a stored fee and log", async () => {
    mocks.read.mockResolvedValue({ status: 200, data: { fee: FEE, log: [ROW] } });
    expect(await readTransferFee("rec/1")).toEqual({ ok: true, fee: FEE, log: [ROW] });
    expect(mocks.read).toHaveBeenCalledWith(PATH);
    mocks.write.mockResolvedValue({ status: 200, data: { fee: FEE, log: [] } });
    const body = { action: "save", fields: { feeAmount: "$50.00" } };
    expect(await postTransferFee("rec/1", body)).toEqual({ ok: true, fee: FEE, log: [] });
    expect(mocks.write).toHaveBeenCalledWith("POST", PATH, body);
    markCase(SUITE, "adapter parses a stored fee and log");
  });

  it("adapter accepts a 2xx with a null log", async () => {
    mocks.write.mockResolvedValue({ status: 201, data: { fee: FEE, log: null } });
    expect(await postTransferFee("rec/1", { action: "log" })).toEqual({ ok: true, fee: FEE, log: null });
    markCase(SUITE, "adapter accepts a 2xx with a null log");
  });

  it("adapter returns the unchanged fee and log on a refusal", async () => {
    mocks.write.mockResolvedValue({ status: 400, data: { error: "refused", fee: FEE, log: [ROW] } });
    expect(await postTransferFee("rec/1", { action: "save", fields: { feeAmount: "x" } }))
      .toEqual({ ok: false, code: "refused", fee: FEE, log: [ROW] });
    mocks.write.mockResolvedValue({ status: 502, data: { error: "log_row_retained", fee: FEE, log: [ROW] } });
    expect(await postTransferFee("rec/1", { action: "log" })).toEqual({ ok: false, code: "log_row_retained", fee: FEE, log: [ROW] });
    markCase(SUITE, "adapter returns the unchanged fee and log on a refusal");
  });

  it("adapter accepts null fee and log in a failure body", async () => {
    mocks.read.mockResolvedValue({ status: 404, data: { error: "not_found" } });
    expect(await readTransferFee("rec/1")).toEqual({ ok: false, code: "not_found", fee: null, log: null });
    mocks.read.mockResolvedValue({ status: 503, data: { error: "internal_error", fee: FEE, log: null } });
    expect(await readTransferFee("rec/1")).toEqual({ ok: false, code: "internal_error", fee: FEE, log: null });
    mocks.write.mockResolvedValue({ status: 500, data: { error: "internal_error", fee: null, log: null } });
    expect(await postTransferFee("rec/1", { action: "log" })).toEqual({ ok: false, code: "internal_error", fee: null, log: null });
    markCase(SUITE, "adapter accepts null fee and log in a failure body");
  });

  it("tkt349: adapter reads the fee when the tracker reimbursement log is not configured or unreadable", async () => {
    // Reimbursements live in Operations Tools; the tracker's log answer must not turn a good fee read into a failure.
    mocks.read.mockResolvedValue({ status: 503, data: { error: "log_not_configured", fee: FEE, log: null } });
    expect(await readTransferFee("rec/1")).toEqual({ ok: true, fee: FEE, log: null });
    mocks.read.mockResolvedValue({ status: 502, data: { error: "log_unavailable", fee: FEE, log: null } });
    expect(await readTransferFee("rec/1")).toEqual({ ok: true, fee: FEE, log: null });
    expect(console.error).not.toHaveBeenCalled();
    // Without a fee, or with a different code or status, it is still a failure and is still logged.
    mocks.read.mockResolvedValue({ status: 503, data: { error: "log_not_configured", fee: null, log: null } });
    expect(await readTransferFee("rec/1")).toEqual({ ok: false, code: "log_not_configured", fee: null, log: null });
    mocks.read.mockResolvedValue({ status: 500, data: { error: "log_not_configured", fee: FEE, log: null } });
    expect(await readTransferFee("rec/1")).toEqual({ ok: false, code: "log_not_configured", fee: FEE, log: null });
    mocks.read.mockResolvedValue({ status: 502, data: { error: "log_not_configured", fee: FEE, log: null } });
    expect(await readTransferFee("rec/1")).toMatchObject({ ok: false, code: "log_not_configured" });
    const calls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toEqual([["[acat-fee] read_status=503"], ["[acat-fee] read_status=500"], ["[acat-fee] read_status=502"]]);
    markCase(SUITE, "tkt349: adapter reads the fee when the tracker reimbursement log is not configured or unreadable");
  });

  it("adapter treats any 2xx as success", async () => {
    for (const status of [200, 201, 202, 299]) {
      mocks.write.mockResolvedValue({ status, data: { fee: FEE, log: [] } });
      expect((await postTransferFee("rec/1", { action: "log" })).ok).toBe(true);
    }
    for (const status of [199, 300, 400]) {
      mocks.write.mockResolvedValue({ status, data: { fee: FEE, log: [] } });
      expect((await postTransferFee("rec/1", { action: "log" })).ok).toBe(false);
    }
    markCase(SUITE, "adapter treats any 2xx as success");
  });

  it("adapter reports transport failure when the tracker does not answer", async () => {
    mocks.read.mockResolvedValue({ status: null, data: null });
    expect(await readTransferFee("rec/1")).toEqual({ ok: false, code: "transport", fee: null, log: null });
    mocks.write.mockResolvedValue({ status: null, data: null });
    expect(await postTransferFee("rec/1", { action: "log" })).toEqual({ ok: false, code: "transport", fee: null, log: null });
    markCase(SUITE, "adapter reports transport failure when the tracker does not answer");
  });

  it("adapter rejects a body that does not match the contract", async () => {
    mocks.read.mockResolvedValue({ status: 200, data: { fee: { feeCharged: 5 }, log: [] } });
    expect(await readTransferFee("rec/1")).toMatchObject({ ok: false, code: "transport" });
    mocks.read.mockResolvedValue({ status: 200, data: { fee: FEE, log: [{ ...ROW, status: "Mystery" }] } });
    expect(await readTransferFee("rec/1")).toMatchObject({ ok: false, code: "transport" });
    mocks.read.mockResolvedValue({ status: 200, data: "<html>" });
    expect(await readTransferFee("rec/1")).toMatchObject({ ok: false, code: "transport" });
    mocks.write.mockResolvedValue({ status: 502, data: "<html>bad gateway</html>" });
    expect(await postTransferFee("rec/1", { action: "log" })).toEqual({ ok: false, code: "transport", fee: null, log: null });
    mocks.write.mockResolvedValue({ status: 401, data: "" });
    expect(await postTransferFee("rec/1", { action: "log" })).toMatchObject({ ok: false, code: "unauthorized" });
    // Only static markers and a status are logged: never a body, a URL, or a token.
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).toContain("[acat-fee] read_status_body_invalid");
    expect(logged).toContain("[acat-fee] write_status=502");
    expect(logged).not.toContain("html");
    expect(logged).not.toContain("rec%2F1");
    markCase(SUITE, "adapter rejects a body that does not match the contract");
  });

  it("every error code maps to fixed copy", () => {
    const expected: Record<string, string> = {
      refused: "The tracker refused this change.",
      no_rules: "No fee rules are available for this custodian.",
      log_not_configured: "The reimbursement log is not configured.",
      log_unavailable: "The reimbursement log could not be read.",
      log_failed: "The reimbursement could not be logged.",
      credit_request_id_not_stored: "The reimbursement was not logged because its request ID could not be stored on this ACAT.",
      log_row_retained: "Reimbursement logged, but the request ID could not be linked to this ACAT",
      rate_limited: "Too many changes at once — wait a minute and try again.",
      unauthorized: "AoA is not allowed to change fees in the tracker.",
      not_found: "The tracker could not find this transfer or fee route.",
      internal_error: "The tracker could not complete this change.",
      transport: "The tracker did not answer — try again.",
    };
    for (const [code, copy] of Object.entries(expected)) {
      expect(FAILURE_COPY[code as FeeFailureCode]).toBe(copy);
      expect(feeFailureMessage("log", code)).toEqual({ title: "Failed to Log Reimbursement", message: copy });
    }
    expect(feeFailureMessage("save", "refused")).toEqual({
      title: "Update Failed", message: "Could not save changes. The tracker refused this change.",
    });
    expect(feeFailureMessage("apply", "no_rules")).toEqual({
      title: "Update Failed", message: "Could not apply fee schedule. No fee rules are available for this custodian.",
    });
    // A server-supplied string outside the contract never reaches the screen.
    expect(normalizeFailureCode("secret stack trace")).toBe("transport");
    expect(feeFailureMessage("log", "secret stack trace").message).toBe(expected.transport);
    markCase(SUITE, "every error code maps to fixed copy");
  });
});
