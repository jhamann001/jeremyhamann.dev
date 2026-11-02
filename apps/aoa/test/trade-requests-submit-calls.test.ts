import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ call: vi.fn(), auth: vi.fn(), flag: vi.fn() }));
vi.mock("@/lib/trade-requests/client", () => ({ callTradeRequestService: m.call }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.flag }));

import { resubmitRequest, submitNewRequest } from "@/app/(authenticated)/trade-requests/new/submit-actions";
import { createTradeRequest, loadSourceRequest, resubmitTradeRequest } from "@/lib/trade-requests/submit";
import type { NewRequestPayload } from "@/lib/trade-requests/new-request-submit";

// ticket: create (body idempotencyKey, not retried) and resubmit
// (expectedUpdatedAt required, ruling A2) through the delegated client; the
// source read for edit and clone; the server actions' flag, role and shape
// checks. The service itself is mocked here and exercised in the browser spec.

const KEY = "3f0c6a52-9b1e-4c3a-8d2f-5e6a7b8c9d0e";
const payload = { clientId: "c-alex", clientName: "Maeve Brennan", selectedAccounts: ["SYN00001"], tradeType: "Raise Cash" } as unknown as NewRequestPayload;
const request = (over: Record<string, unknown> = {}) => ({
  id: "REQ-SYN1", clientName: "Maeve Brennan", status: "Pending Review", auditLog: [], selectedAccounts: ["SYN00001"], ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.flag.mockReturnValue(true);
  m.auth.mockResolvedValue({ user: { role: "ADVISOR" } });
});

describe("delegated calls", () => {
  it("create posts the payload with the idempotency key in the body under the createRequest policy", async () => {
    m.call.mockResolvedValue({ ok: true, status: 201, data: { data: request() } });
    expect(await createTradeRequest(payload, KEY)).toEqual({ ok: true, id: "REQ-SYN1" });
    expect(m.call).toHaveBeenCalledWith({
      operation: "createRequest", method: "POST", path: "/requests", body: { ...payload, idempotencyKey: KEY },
      defaultMessage: "Failed to submit request. Please try again.",
    });
  });

  it("a repeat that the service answers with the existing request (200) is a success", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: request() } });
    expect(await createTradeRequest(payload, KEY)).toEqual({ ok: true, id: "REQ-SYN1" });
  });

  it("failures carry the client's text: service error, failure description or not-set-up", async () => {
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 400, message: "Validation failed: advisorNotes: String must contain at most 5000 character(s)" });
    expect(await createTradeRequest(payload, KEY)).toEqual({ ok: false, message: "Validation failed: advisorNotes: String must contain at most 5000 character(s)" });
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: null, message: "timeout of 120000ms exceeded" });
    expect(await createTradeRequest(payload, KEY)).toEqual({ ok: false, message: "timeout of 120000ms exceeded" });
    m.call.mockResolvedValueOnce({ ok: false, outcome: "not_set_up", message: "Your account is not set up for Trade Requests — contact Operations." });
    expect(await createTradeRequest(payload, KEY)).toEqual({ ok: false, message: "Your account is not set up for Trade Requests — contact Operations." });
  });

  it("resubmit puts the payload with expectedUpdatedAt under the resubmitRequest policy", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: request() } });
    expect(await resubmitTradeRequest("REQ-SYN1", payload, "2026-10-11T08:30:00.000Z")).toEqual({ ok: true, id: "REQ-SYN1" });
    expect(m.call).toHaveBeenCalledWith({
      operation: "resubmitRequest", method: "PUT", path: "/requests/REQ-SYN1",
      body: { ...payload, existingId: "REQ-SYN1", expectedUpdatedAt: "2026-10-11T08:30:00.000Z" },
      defaultMessage: "Failed to submit request. Please try again.",
    });
  });

  it("a stale resubmission shows the service's message (AC-44 text)", async () => {
    m.call.mockResolvedValue({ ok: false, outcome: "failed", status: 409, message: "Request was modified by another user. Please refresh and try again." });
    expect(await resubmitTradeRequest("REQ-SYN1", payload, "2026-10-11T08:30:00.000Z"))
      .toEqual({ ok: false, message: "Request was modified by another user. Please refresh and try again." });
  });

  it("the source read: found, not found, not set up, failed", async () => {
    m.call.mockResolvedValueOnce({ ok: true, status: 200, data: { data: request({ status: "Needs Info" }) } });
    expect(await loadSourceRequest("REQ-SYN1")).toMatchObject({ kind: "found", request: { id: "REQ-SYN1", status: "Needs Info" } });
    expect(m.call).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "requestDetail", method: "GET", path: "/requests/REQ-SYN1" }));
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 404, message: "Request REQ-X not found" });
    expect(await loadSourceRequest("REQ-X")).toEqual({ kind: "not_found" });
    m.call.mockResolvedValueOnce({ ok: false, outcome: "not_set_up", message: "x" });
    expect(await loadSourceRequest("REQ-X")).toEqual({ kind: "not_set_up" });
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: 502, message: "Request failed with status code 502" });
    expect(await loadSourceRequest("REQ-X")).toEqual({ kind: "failed", message: "Request failed with status code 502" });
    m.call.mockResolvedValueOnce({ ok: true, status: 200, data: { data: { id: 1 } } });
    expect(await loadSourceRequest("REQ-X")).toEqual({ kind: "failed", message: "Failed to load request. Please try again." });
    expect(await loadSourceRequest("..")).toEqual({ kind: "not_found" });
    expect(m.call).toHaveBeenCalledTimes(5);
  });
});

describe("server actions", () => {
  it("submit: flag, workspace role, payload shape and key checked before any call", async () => {
    m.call.mockResolvedValue({ ok: true, status: 201, data: { data: request() } });
    m.flag.mockReturnValue(false);
    expect(await submitNewRequest(payload, KEY)).toEqual({ ok: false, message: "Failed to submit request. Please try again." });
    m.flag.mockReturnValue(true);
    for (const role of ["CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY"]) {
      m.auth.mockResolvedValue({ user: { role } });
      expect((await submitNewRequest(payload, KEY)).ok).toBe(false);
    }
    m.auth.mockResolvedValue(null);
    expect((await submitNewRequest(payload, KEY)).ok).toBe(false);
    m.auth.mockResolvedValue({ user: { role: "ADVISOR" } });
    expect((await submitNewRequest(payload, "not-a-uuid")).ok).toBe(false);
    expect((await submitNewRequest(null, KEY)).ok).toBe(false);
    expect((await submitNewRequest([payload], KEY)).ok).toBe(false);
    expect(m.call).not.toHaveBeenCalled();
    for (const role of ["ADMIN", "OPERATIONS", "ADVISOR"]) {
      m.auth.mockResolvedValue({ user: { role } });
      expect(await submitNewRequest(payload, KEY)).toEqual({ ok: true, id: "REQ-SYN1" });
    }
    expect(m.call).toHaveBeenCalledTimes(3);
  });

  it("the action's own key wins over one in the payload", async () => {
    m.call.mockResolvedValue({ ok: true, status: 201, data: { data: request() } });
    await submitNewRequest({ ...payload, idempotencyKey: "00000000-0000-0000-0000-000000000000" }, KEY);
    expect(m.call.mock.lastCall![0].body.idempotencyKey).toBe(KEY);
  });

  it("resubmit: id, version and payload checked; then the PUT", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: request() } });
    for (const [id, version] of [["", "2026-10-11T08:30:00.000Z"], ["queue", "2026-10-11T08:30:00.000Z"], ["x".repeat(51), "2026-10-11T08:30:00.000Z"], ["REQ-1", ""], ["REQ-1", "not a date"], ["REQ-1", undefined]]) {
      expect((await resubmitRequest(id, payload, version)).ok).toBe(false);
    }
    m.flag.mockReturnValue(false);
    expect((await resubmitRequest("REQ-1", payload, "2026-10-11T08:30:00.000Z")).ok).toBe(false);
    expect(m.call).not.toHaveBeenCalled();
    m.flag.mockReturnValue(true);
    expect(await resubmitRequest("REQ-1", payload, "2026-10-11T08:30:00.000Z")).toEqual({ ok: true, id: "REQ-SYN1" });
    expect(m.call.mock.lastCall![0]).toMatchObject({ method: "PUT", path: "/requests/REQ-1", body: { expectedUpdatedAt: "2026-10-11T08:30:00.000Z" } });
  });
});
