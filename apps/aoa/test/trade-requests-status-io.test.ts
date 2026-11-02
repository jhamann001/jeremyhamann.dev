import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ call: vi.fn(), enabled: vi.fn() }));
vi.mock("@/lib/trade-requests/client", () => ({ callTradeRequestService: m.call }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.enabled }));

import { changeRequestStatus } from "@/lib/trade-requests/status";
import { changeTradeRequestStatus } from "@/app/(authenticated)/trade-requests/status-actions";

// ticket: the delegated status change (AC-11, AC-101, AC-106) and the server
// action's flag and input checks. Synthetic data.

const STAMP = "2026-10-15T15:00:00.123Z";
const FAILED = { ok: false, message: "Action failed. Please try again." };

beforeEach(() => {
  vi.resetAllMocks();
  m.enabled.mockReturnValue(true);
});

describe("changeRequestStatus (ticket)", () => {
  it("sends PUT /requests/:id/status with the status, note and stale-change stamp (AC-11)", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: { id: "REQ SYN/1" } } });
    await expect(changeRequestStatus("REQ SYN/1", { status: "Approved", note: "Synthetic note", expectedUpdatedAt: STAMP }))
      .resolves.toEqual({ ok: true });
    expect(m.call).toHaveBeenCalledWith({
      operation: "statusChange", method: "PUT", path: "/requests/REQ%20SYN%2F1/status",
      body: { status: "Approved", note: "Synthetic note", expectedUpdatedAt: STAMP },
      defaultMessage: "Action failed. Please try again.",
    });
  });

  it("sends an empty note unchanged, for the service's \"No additional notes.\" (AC-106)", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: null });
    await changeRequestStatus("REQ-SYN1", { status: "Needs Info", note: "", expectedUpdatedAt: STAMP });
    expect(m.call.mock.calls[0][0].body).toEqual({ status: "Needs Info", note: "", expectedUpdatedAt: STAMP });
  });

  it("returns the client's failure text: service error, description or default (AC-101)", async () => {
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 409, message: "Request was modified by another user. Please refresh and try again." });
    await expect(changeRequestStatus("REQ-SYN1", { status: "Rejected", note: "", expectedUpdatedAt: STAMP }))
      .resolves.toEqual({ ok: false, message: "Request was modified by another user. Please refresh and try again." });
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: null, message: "Action failed. Please try again." });
    await expect(changeRequestStatus("REQ-SYN1", { status: "Rejected", note: "", expectedUpdatedAt: STAMP })).resolves.toEqual(FAILED);
  });

  it("never calls the service for an id that cannot be a request", async () => {
    await expect(changeRequestStatus("..", { status: "Approved", note: "", expectedUpdatedAt: STAMP })).resolves.toEqual(FAILED);
    await expect(changeRequestStatus("queue", { status: "Approved", note: "", expectedUpdatedAt: STAMP })).resolves.toEqual(FAILED);
    expect(m.call).not.toHaveBeenCalled();
  });
});

describe("changeTradeRequestStatus server action (ticket)", () => {
  it("passes a valid change through", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: null });
    await expect(changeTradeRequestStatus("REQ-SYN1", { status: "Pending Current Asset Liquidation", note: "n", expectedUpdatedAt: STAMP }))
      .resolves.toEqual({ ok: true });
    expect(m.call).toHaveBeenCalledTimes(1);
  });

  it("refuses with the flag off before anything else", async () => {
    m.enabled.mockReturnValue(false);
    await expect(changeTradeRequestStatus("REQ-SYN1", { status: "Approved", note: "", expectedUpdatedAt: STAMP })).resolves.toEqual(FAILED);
    expect(m.call).not.toHaveBeenCalled();
  });

  it("refuses malformed input", async () => {
    const valid = { status: "Approved", note: "", expectedUpdatedAt: STAMP };
    for (const [id, change] of [
      ["", valid], [7, valid], ["x".repeat(101), valid], ["REQ-SYN1", null], ["REQ-SYN1", "Approved"],
      ["REQ-SYN1", { ...valid, status: "Completed" }], ["REQ-SYN1", { ...valid, status: "Pending Review" }],
      ["REQ-SYN1", { ...valid, note: undefined }], ["REQ-SYN1", { ...valid, note: "x".repeat(2001) }],
      ["REQ-SYN1", { ...valid, expectedUpdatedAt: undefined }], ["REQ-SYN1", { ...valid, expectedUpdatedAt: "not a date" }],
      ["REQ-SYN1", { ...valid, expectedUpdatedAt: "" }],
    ] as const) {
      await expect(changeTradeRequestStatus(id, change)).resolves.toEqual(FAILED);
    }
    expect(m.call).not.toHaveBeenCalled();
  });
});
