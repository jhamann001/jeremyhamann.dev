import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcatStatus } from "@/lib/data/acat-status";
import { libraryFixture } from "./fixtures/custodian-library";

const { authMock, recordMock, libraryMock } = vi.hoisted(() => ({
  authMock: vi.fn(), recordMock: vi.fn(), libraryMock: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/data/acat-status", () => ({ getAcatStatusByRecordId: recordMock }));
vi.mock("@/lib/data/custodian-library", () => ({ getCustodianLibrary: libraryMock }));

import { loadTransferPreparation } from "@/app/(authenticated)/acat-tracking/preparation-actions";

const record: AcatStatus = {
  acatTransferId: "N/A", direction: "Incoming", type: "Partial account transfer",
  accountType: "Brokerage", status: "WaitingForStatement",
  transferringContra: libraryFixture.custodians[0].name,
  controlNumber: "SYNTHETIC-CONTROL", statementAmount: 500000,
  methodRequested: null, feeCharged: null, feeAmount: null, acatDate: null,
  apexAccountId: "****1234", statementAccountNumber: "****5678", dtccNumber: "****9999",
  assets: [{ symbol: "SAMPLE", description: "Synthetic position", cusip: "****0000",
    expectedQty: 10, actualQty: 0, mapStatus: null, issue: null, amount: 100, assetClass: null }],
};
const session = (role?: string) => ({ user: { email: "synthetic@example.test", role } });

beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue(session("OPERATIONS"));
  recordMock.mockResolvedValue(record);
  libraryMock.mockResolvedValue(libraryFixture);
});

describe("transfer preparation source and authorization boundary", () => {
  it.each([null, { user: undefined }, session(), session("VIEWER"), session("ADVISOR"), session("CLIENT_SERVICE")])(
    "denies unsupported identity before reading either source: %j", async (identity) => {
      authMock.mockResolvedValue(identity);
      expect(await loadTransferPreparation("record-1")).toEqual({ ok: false, reason: "forbidden" });
      expect(recordMock).not.toHaveBeenCalled();
      expect(libraryMock).not.toHaveBeenCalled();
    },
  );

  it.each(["ADMIN", "OPERATIONS"])("reads fresh sources for authorized %s", async (role) => {
    authMock.mockResolvedValue(session(role));
    const result = await loadTransferPreparation("record-1");
    expect(result.ok).toBe(true);
    expect(recordMock).toHaveBeenCalledWith("record-1", { signal: expect.any(AbortSignal) });
    expect(libraryMock).toHaveBeenCalledWith(role);
    if (!result.ok) throw new Error("Expected success");
    expect(result.context.record).toEqual({
      direction: record.direction, type: record.type, accountType: record.accountType,
      transferringContra: record.transferringContra,
    });
    expect(result.context.recordId).toBe("record-1");
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
    for (const value of ["****1234", "****5678", "****9999", "SAMPLE", "SYNTHETIC-CONTROL"]) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
    await loadTransferPreparation("record-1");
    expect(recordMock).toHaveBeenCalledTimes(2);
    expect(libraryMock).toHaveBeenCalledTimes(2);
  });

  it.each(["", "../other", "record?x=1", " ", "r".repeat(129)])("rejects invalid record key %s without reads", async (key) => {
    expect(await loadTransferPreparation(key)).toEqual({ ok: false, reason: "invalid" });
    expect(recordMock).not.toHaveBeenCalled();
    expect(libraryMock).not.toHaveBeenCalled();
  });

  it("rejects injected/unknown choice fields before source reads", async () => {
    expect(await loadTransferPreparation("record-1", { role: "ADMIN" } as never))
      .toEqual({ ok: false, reason: "invalid" });
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("returns not found instead of applying reference rules to a missing record", async () => {
    recordMock.mockResolvedValue(null);
    expect(await loadTransferPreparation("missing-record")).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects a custodian absent from the fresh library and a workflow outside its candidates", async () => {
    expect(await loadTransferPreparation("record-1", { custodianId: "missing" }))
      .toEqual({ ok: false, reason: "invalid" });
    expect(await loadTransferPreparation("record-1", { workflowId: "missing" }))
      .toEqual({ ok: false, reason: "invalid" });
  });

  it("does not merge different records sharing a placeholder ACAT identifier", async () => {
    recordMock.mockResolvedValueOnce({ ...record, accountType: "Joint" });
    recordMock.mockResolvedValueOnce({ ...record, accountType: "Inherited IRA" });
    const first = await loadTransferPreparation("record-a");
    const second = await loadTransferPreparation("record-b");
    expect(first.ok && first.context.record.accountType).toBe("Joint");
    expect(second.ok && second.context.record.accountType).toBe("Inherited IRA");
    expect(recordMock.mock.calls.map((call) => call[0])).toEqual(["record-a", "record-b"]);
  });

  it.each(["record", "library", "auth"])("fails closed without leaking %s source errors", async (source) => {
    const dependency = source === "record" ? recordMock : source === "library" ? libraryMock : authMock;
    dependency.mockRejectedValue(new Error("sensitive-source-text"));
    expect(await loadTransferPreparation("record-1")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("does not fall back to a prior successful result when a fresh source fails", async () => {
    expect((await loadTransferPreparation("record-1")).ok).toBe(true);
    libraryMock.mockRejectedValue(new Error("offline"));
    expect(await loadTransferPreparation("record-1")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("bounds a stalled record read and cancels its source request", async () => {
    vi.useFakeTimers();
    try {
      recordMock.mockImplementation(() => new Promise(() => {}));
      const result = loadTransferPreparation("record-1");
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await result).toEqual({ ok: false, reason: "unavailable" });
      expect(recordMock.mock.calls[0][1].signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
