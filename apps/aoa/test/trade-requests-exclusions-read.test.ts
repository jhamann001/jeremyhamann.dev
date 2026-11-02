import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ call: vi.fn(), auth: vi.fn(), flag: vi.fn() }));
vi.mock("@/lib/trade-requests/client", () => ({ callTradeRequestService: m.call }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({ tradeRequestsWorkspaceEnabled: m.flag }));

import { readAccountExclusions, readClientExclusions, saveExclusionBatch } from "@/lib/trade-requests/exclusions";
import { applyExclusionBatch, loadAccountExclusions, loadClientExclusions } from "@/app/(authenticated)/trade-requests/new/actions";

const ROW = { id: "0b4b1e5c-0000-4000-8000-000000000001", clientId: "c1", ticker: "TSLA", kind: "advisor", reason: "Concentration", noBuy: true, noSell: false, createdByName: "Avery Stone", createdAt: "2026-10-01T12:00:00.000Z" };
const ENTRY = { id: ROW.id, ticker: "TSLA", kind: "advisor", reason: "Concentration", noBuy: true, noSell: false, createdByName: "Avery Stone", createdAt: "2026-10-01T12:00:00.000Z" };
const BATCH = {
  add: [{ ticker: "NVDA", kind: "client" as const, reason: "", noBuy: true, noSell: false }], remove: [ROW.id], edit: [{ id: ROW.id, noBuy: true, noSell: true }],
};

beforeEach(() => {
  m.call.mockReset();
  m.auth.mockResolvedValue({ user: { email: "avery@example.com", role: "ADVISOR" } });
  m.flag.mockReturnValue(true);
});

describe("standing-list reads", () => {
  it("reads one client's list on the retried single-client operation", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: [ROW] } });
    await expect(readClientExclusions(["trw11 alex/1", "trw11 alex/1"])).resolves.toEqual({ ok: true, data: { "trw11 alex/1": [ENTRY] } });
    expect(m.call).toHaveBeenCalledWith({
      operation: "clientExclusions", method: "GET", path: "/clients/trw11%20alex%2F1/exclusions", defaultMessage: "Failed to load exclusions",
    });
  });

  it("reads several clients in one lookup that is not retried", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: { c1: [ROW], c2: [] } } });
    await expect(readClientExclusions(["c1", "c2"])).resolves.toEqual({ ok: true, data: { c1: [ENTRY], c2: [] } });
    expect(m.call).toHaveBeenCalledWith({
      operation: "clientsExclusionsLookup", method: "POST", path: "/clients/exclusions/bulk", body: { clientIds: ["c1", "c2"] },
      defaultMessage: "Failed to load exclusions",
    });
  });

  it("reads account lists in one lookup that is not retried (AC-92)", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: { a1: [{ ...ROW, accountId: "a1" }] } } });
    await expect(readAccountExclusions(["a1"])).resolves.toEqual({ ok: true, data: { a1: [ENTRY] } });
    expect(m.call).toHaveBeenCalledWith({
      operation: "accountExclusionsLookup", method: "POST", path: "/clients/account-exclusions/bulk", body: { accountIds: ["a1"] },
      defaultMessage: "Failed to load account exclusions",
    });
    await expect(readAccountExclusions([])).resolves.toEqual({ ok: true, data: {} });
    expect(m.call).toHaveBeenCalledTimes(1);
  });

  it("returns the failure message, or the default for an unreadable body (AC-111)", async () => {
    m.call.mockResolvedValueOnce({ ok: false, outcome: "failed", status: null, message: "timeout of 30000ms exceeded" });
    await expect(readAccountExclusions(["a1"])).resolves.toEqual({ ok: false, message: "timeout of 30000ms exceeded" });
    m.call.mockResolvedValueOnce({ ok: true, status: 200, data: { data: { a1: [{ ...ROW, kind: "other" }] } } });
    await expect(readAccountExclusions(["a1"])).resolves.toEqual({ ok: false, message: "Failed to load account exclusions" });
    m.call.mockResolvedValueOnce({ ok: true, status: 200, data: { data: [ROW] } });
    await expect(readClientExclusions(["c1", "c2"])).resolves.toEqual({ ok: false, message: "Failed to load exclusions" });
  });
});

describe("batch saves (AC-118, AC-121)", () => {
  it("posts one batch per client or account on the not-retried save operation", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: { exclusions: [ROW], added: 1, removed: 1, edited: 1 } } });
    await expect(saveExclusionBatch("client", "c 1", BATCH)).resolves.toEqual({ ok: true, data: { exclusions: [ENTRY], added: 1, removed: 1, edited: 1 } });
    expect(m.call).toHaveBeenLastCalledWith({
      operation: "exclusionSave", method: "POST", path: "/clients/c%201/exclusions/batch", body: BATCH, defaultMessage: "Failed to apply changes",
    });
    await saveExclusionBatch("account", "01TRW", BATCH);
    expect(m.call).toHaveBeenLastCalledWith(expect.objectContaining({ path: "/clients/account-exclusions/01TRW/batch" }));
  });

  it("returns the service's text for a refused batch", async () => {
    m.call.mockResolvedValue({ ok: false, outcome: "failed", status: 409, message: "NVDA is already on the client exclusion list for this client." });
    await expect(saveExclusionBatch("client", "c1", BATCH)).resolves.toEqual({
      ok: false, message: "NVDA is already on the client exclusion list for this client.",
    });
  });
});

describe("exclusion actions", () => {
  it("call the service for a workspace role with the flag on", async () => {
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: [ROW] } });
    await expect(loadClientExclusions(["c1"])).resolves.toMatchObject({ ok: true });
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: { a1: [] } } });
    await expect(loadAccountExclusions(["a1"])).resolves.toEqual({ ok: true, data: { a1: [] } });
    m.call.mockResolvedValue({ ok: true, status: 200, data: { data: { exclusions: [], added: 1, removed: 0, edited: 0 } } });
    await expect(applyExclusionBatch("account", "a1", BATCH)).resolves.toMatchObject({ ok: true });
    expect(m.call).toHaveBeenCalledTimes(3);
  });

  it("make no call when the flag is off or the role has no workspace access", async () => {
    m.flag.mockReturnValue(false);
    await expect(loadClientExclusions(["c1"])).resolves.toEqual({ ok: false, message: "Failed to load exclusions" });
    m.flag.mockReturnValue(true);
    for (const role of ["CLIENT_SERVICE", "VIEWER", "HEAD_OF_ADVISORY"]) {
      m.auth.mockResolvedValue({ user: { email: "x@example.com", role } });
      await expect(loadAccountExclusions(["a1"])).resolves.toEqual({ ok: false, message: "Failed to load account exclusions" });
      await expect(applyExclusionBatch("client", "c1", BATCH)).resolves.toEqual({ ok: false, message: "Failed to apply changes" });
    }
    expect(m.call).not.toHaveBeenCalled();
  });

  it("refuse malformed ids and batches without a call", async () => {
    const bad: unknown[] = [
      null, { add: [], remove: [], edit: [] }, { ...BATCH, add: [{ ...BATCH.add[0], noBuy: false }] },
      { ...BATCH, add: [{ ...BATCH.add[0], ticker: "X".repeat(21) }] }, { ...BATCH, add: [{ ...BATCH.add[0], kind: "other" }] },
      { ...BATCH, add: [{ ...BATCH.add[0], reason: "r".repeat(501) }] }, { ...BATCH, edit: [{ id: ROW.id, noBuy: false, noSell: false }] },
      { ...BATCH, remove: Array.from({ length: 101 }, (_, i) => `id-${i}`) }, { add: BATCH.add, remove: [] },
    ];
    for (const batch of bad) await expect(applyExclusionBatch("client", "c1", batch)).resolves.toEqual({ ok: false, message: "Failed to apply changes" });
    await expect(applyExclusionBatch("household", "c1", BATCH)).resolves.toMatchObject({ ok: false });
    await expect(applyExclusionBatch("client", "", BATCH)).resolves.toMatchObject({ ok: false });
    await expect(loadClientExclusions("c1")).resolves.toMatchObject({ ok: false });
    await expect(loadAccountExclusions(Array.from({ length: 1_001 }, (_, i) => `a${i}`))).resolves.toMatchObject({ ok: false });
    await expect(loadAccountExclusions(["x".repeat(101)])).resolves.toMatchObject({ ok: false });
    expect(m.call).not.toHaveBeenCalled();
  });
});
