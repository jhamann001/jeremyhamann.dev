import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "../acat-book-flywheel";

const { listSpy, confirmSpy, requestSpy, clientSpy } = vi.hoisted(() => ({
  listSpy: vi.fn(),
  confirmSpy: vi.fn(),
  requestSpy: vi.fn(),
  clientSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data/custodian-authority", () => ({
  listCustodianAuthorityRevisions: listSpy,
  confirmCustodianAuthorityRevision: confirmSpy,
}));
vi.mock("@/lib/data/custodian-library", () => ({
  custodianTrackerClient: clientSpy,
}));

import {
  custodianRevisionChecksum,
  deliverCustodianRevisions,
  runCustodianProjectionDelivery,
  type ProjectionAttempt,
  type ProjectionRequest,
} from "@/lib/data/custodian-projection-dispatch";

const HASH_A = "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862";

function accepted(revision: number): ProjectionAttempt {
  return { outcome: "accepted", revision };
}

beforeEach(() => {
  vi.resetAllMocks();
  confirmSpy.mockResolvedValue(undefined);
  clientSpy.mockResolvedValue({ client: { request: requestSpy }, origin: "https://tracker.example" });
});

describe("custodian projection dispatch", () => {
  it("delivers unsorted revisions in order", async () => {
    const receiver = vi.fn(async (input: ProjectionRequest) => accepted(input.revision));
    const result = await deliverCustodianRevisions(
      [{ revision: 2, body: { b: 1 } }, { revision: 1, body: { a: 1 } }],
      receiver,
    );
    expect(receiver).toHaveBeenCalledTimes(2);
    expect(receiver.mock.calls[0][0]).toMatchObject({
      revision: 1,
      previousRevision: null,
      checksum: HASH_A,
      body: { a: 1 },
    });
    expect(receiver.mock.calls[1][0]).toMatchObject({
      revision: 2,
      previousRevision: 1,
      body: { b: 1 },
    });
    expect(result).toEqual({ delivered: [1, 2], stoppedRevision: null, reason: "complete" });
    markCase("custodian-projection-dispatch", "delivers unsorted revisions in order");
  });

  it("continues after a duplicate", async () => {
    const receiver = vi.fn(async (input: ProjectionRequest): Promise<ProjectionAttempt> =>
      input.revision === 1 ? { outcome: "duplicate", revision: 1 } : accepted(input.revision));
    const result = await deliverCustodianRevisions(
      [{ revision: 1, body: { a: 1 } }, { revision: 2, body: { b: 1 } }],
      receiver,
    );
    expect(result).toEqual({ delivered: [1, 2], stoppedRevision: null, reason: "complete" });
    markCase("custodian-projection-dispatch", "continues after a duplicate");
  });

  it("stops at the missing revision and does not send the later row", async () => {
    const receiver = vi.fn(async (input: ProjectionRequest) => accepted(input.revision));
    const result = await deliverCustodianRevisions(
      [{ revision: 1, body: { a: 1 } }, { revision: 3, body: { c: 1 } }],
      receiver,
    );
    expect(receiver).toHaveBeenCalledTimes(1);
    expect(receiver.mock.calls[0][0].revision).toBe(1);
    expect(result).toEqual({ delivered: [1], stoppedRevision: 2, reason: "gap" });
    markCase("custodian-projection-dispatch", "stops at the missing revision and does not send the later row");
  });

  it("stops on mismatch and does not send the next revision", async () => {
    const receiver = vi.fn(async (input: ProjectionRequest): Promise<ProjectionAttempt> =>
      input.revision === 2
        ? { outcome: "rejected", revision: 2, reason: "mismatch" }
        : accepted(input.revision));
    const result = await deliverCustodianRevisions(
      [{ revision: 1, body: { a: 1 } }, { revision: 2, body: { b: 1 } }, { revision: 3, body: { c: 1 } }],
      receiver,
    );
    expect(receiver.mock.calls.map((call) => call[0].revision)).toEqual([1, 2]);
    expect(result).toEqual({ delivered: [1], stoppedRevision: 2, reason: "mismatch" });
    markCase("custodian-projection-dispatch", "stops on mismatch and does not send the next revision");
  });

  it("retries the failed revision on the next walk", async () => {
    const rows = [
      { revision: 1, body: { a: 1 } },
      { revision: 2, body: { b: 1 } },
      { revision: 3, body: { c: 1 } },
    ];
    let walk = 0;
    const receiver = vi.fn(async (input: ProjectionRequest): Promise<ProjectionAttempt> => {
      if (walk === 0 && input.revision === 2) return { outcome: "retry", revision: 2 };
      if (walk === 1 && input.revision === 1) return { outcome: "duplicate", revision: 1 };
      return accepted(input.revision);
    });
    const first = await deliverCustodianRevisions(rows, receiver);
    expect(first).toEqual({ delivered: [1], stoppedRevision: 2, reason: "retry" });
    expect(receiver.mock.calls.map((call) => call[0].revision)).toEqual([1, 2]);
    walk = 1;
    receiver.mockClear();
    const second = await deliverCustodianRevisions(rows, receiver);
    expect(receiver.mock.calls.map((call) => call[0].revision)).toEqual([1, 2, 3]);
    expect(second).toEqual({ delivered: [1, 2, 3], stoppedRevision: null, reason: "complete" });
    markCase("custodian-projection-dispatch", "retries the failed revision on the next walk");
  });

  it("hashes object keys in canonical order", () => {
    expect(custodianRevisionChecksum({ a: 1 })).toBe(HASH_A);
    expect(custodianRevisionChecksum({ b: 1, a: 1 })).toBe(custodianRevisionChecksum({ a: 1, b: 1 }));
    markCase("custodian-projection-dispatch", "hashes object keys in canonical order");
  });

  it("confirms an accepted revision and retries the next failed post", async () => {
    listSpy.mockResolvedValue([{ revision: 1, body: { a: 1 } }, { revision: 2, body: { b: 1 } }]);
    requestSpy
      .mockResolvedValueOnce({ status: 200, data: { outcome: "accepted", revision: 1 } })
      .mockResolvedValueOnce({ status: 503, data: null });
    const result = await runCustodianProjectionDelivery();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith(1);
    expect(result.reason).toBe("retry");
    expect(result.stoppedRevision).toBe(2);
    markCase("custodian-projection-dispatch", "confirms an accepted revision and retries the next failed post");
  });

  it("does not advance when confirm fails", async () => {
    listSpy.mockResolvedValue([{ revision: 1, body: { a: 1 } }]);
    requestSpy.mockResolvedValue({ status: 200, data: { outcome: "accepted", revision: 1 } });
    confirmSpy.mockRejectedValue(new Error("confirm failed"));
    const result = await runCustodianProjectionDelivery();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ delivered: [], stoppedRevision: 1, reason: "retry" });
    markCase("custodian-projection-dispatch", "does not advance when confirm fails");
  });

  it("stops a repeated revision with the same checksum as a gap", async () => {
    const receiver = vi.fn(async (input: ProjectionRequest) => accepted(input.revision));
    const result = await deliverCustodianRevisions(
      [{ revision: 1, body: { a: 1 } }, { revision: 1, body: { a: 1 } }],
      receiver,
    );
    expect(receiver).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ delivered: [1], stoppedRevision: 1, reason: "gap" });
    markCase("custodian-projection-dispatch", "stops a repeated revision with the same checksum as a gap");
  });

  it("stops a repeated revision with a different checksum as a mismatch", async () => {
    const receiver = vi.fn(async (input: ProjectionRequest) => accepted(input.revision));
    const result = await deliverCustodianRevisions(
      [{ revision: 1, body: { a: 1 } }, { revision: 1, body: { a: 2 } }],
      receiver,
    );
    expect(receiver).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ delivered: [1], stoppedRevision: 1, reason: "mismatch" });
    markCase("custodian-projection-dispatch", "stops a repeated revision with a different checksum as a mismatch");
  });

  it("parses an HTTP 409 gap without confirming", async () => {
    listSpy.mockResolvedValue([{ revision: 1, body: { a: 1 } }]);
    requestSpy.mockResolvedValue({ status: 409, data: { outcome: "rejected", revision: 1, reason: "gap" } });
    const result = await runCustodianProjectionDelivery();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: [], stoppedRevision: 1, reason: "gap" });
    markCase("custodian-projection-dispatch", "parses an HTTP 409 gap without confirming");
  });

  it("parses an HTTP 409 mismatch without confirming", async () => {
    listSpy.mockResolvedValue([{ revision: 1, body: { a: 1 } }]);
    requestSpy.mockResolvedValue({ status: 409, data: { outcome: "rejected", revision: 1, reason: "mismatch" } });
    const result = await runCustodianProjectionDelivery();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: [], stoppedRevision: 1, reason: "mismatch" });
    markCase("custodian-projection-dispatch", "parses an HTTP 409 mismatch without confirming");
  });

  it("parses HTTP 401 without confirming", async () => {
    listSpy.mockResolvedValue([{ revision: 1, body: { a: 1 } }]);
    requestSpy.mockResolvedValue({ status: 401, data: { error: "unauthorized" } });
    const result = await runCustodianProjectionDelivery();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: [], stoppedRevision: 1, reason: "unauthorized" });
    markCase("custodian-projection-dispatch", "parses HTTP 401 without confirming");
  });
});
