import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/data/acat-status", () => ({ readAcatMachine: mocks.read }));

import { loadTransferHistory } from "@/app/(authenticated)/acat-tracking/history-actions";
import { acatFieldHistoryEnabled, epicAcatFieldHistoryEnabled } from "@/lib/flags";

const SUITE = "acat-history-actions";
const KEYS = ["EPIC_ACAT_OPS_WORKSPACE_TKT290", "SHOW_ACAT_OPS_BOOK_TKT293", "EPIC_ACAT_FIELD_HISTORY_TKT322", "SHOW_ACAT_FIELD_HISTORY_TKT336"] as const;
const ROW = { id: "h1", action: "update", field: "notes", oldValue: null, newValue: "called", performedBy: null, timestamp: "2026-10-13T14:32:00.000Z" };

function historyOn() { for (const k of KEYS) vi.stubEnv(k, "1"); }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "synthetic@example.test" } });
  mocks.read.mockResolvedValue({ status: 200, data: [ROW] });
});
afterEach(() => vi.unstubAllEnvs());

describe("field history flags (ticket)", () => {
  it('turn on only for the exact value "1", and the epic switch is the prerequisite', () => {
    expect(epicAcatFieldHistoryEnabled()).toBe(false);
    expect(acatFieldHistoryEnabled()).toBe(false);
    for (const v of ["", "0", "true", "yes", " 1", "1 "]) {
      vi.stubEnv("EPIC_ACAT_FIELD_HISTORY_TKT322", v);
      vi.stubEnv("SHOW_ACAT_FIELD_HISTORY_TKT336", "1");
      expect(acatFieldHistoryEnabled()).toBe(false);
    }
    vi.stubEnv("EPIC_ACAT_FIELD_HISTORY_TKT322", "1");
    vi.stubEnv("SHOW_ACAT_FIELD_HISTORY_TKT336", "0");
    expect(acatFieldHistoryEnabled()).toBe(false);
    vi.stubEnv("SHOW_ACAT_FIELD_HISTORY_TKT336", "1");
    expect(acatFieldHistoryEnabled()).toBe(true);
    markCase(SUITE, 'flags turn on only for the exact value "1", and the epic switch is the prerequisite');
  });
});

describe("loadTransferHistory (ticket)", () => {
  it("makes no tracker call while the release is off", async () => {
    expect(await loadTransferHistory("rec-1")).toEqual({ ok: false, reason: "off" });
    for (const off of KEYS) {
      historyOn();
      vi.stubEnv(off, "0");
      expect(await loadTransferHistory("rec-1")).toEqual({ ok: false, reason: "off" });
    }
    expect(mocks.read).not.toHaveBeenCalled();
    markCase(SUITE, "makes no tracker call while the release is off");
  });

  it("refuses a signed-out user and a role that cannot see the book, without a tracker call", async () => {
    historyOn();
    mocks.auth.mockResolvedValueOnce(null);
    expect(await loadTransferHistory("rec-1")).toEqual({ ok: false, reason: "forbidden" });
    mocks.auth.mockResolvedValueOnce({ user: { role: "ADVISOR" } });
    expect(await loadTransferHistory("rec-1")).toEqual({ ok: false, reason: "forbidden" });
    expect(mocks.read).not.toHaveBeenCalled();
    markCase(SUITE, "refuses a signed-out user and a role that cannot see the book, without a tracker call");
  });

  it("rejects a blank, oversized, dotted, slashed or spaced record id without a tracker call", async () => {
    historyOn();
    for (const bad of ["", "x".repeat(129), ".", "..", "a/b", "rec 1", "rec%2F1", "a.b"]) {
      expect(await loadTransferHistory(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(mocks.read).not.toHaveBeenCalled();
    markCase(SUITE, "rejects a blank, oversized, dotted, slashed or spaced record id without a tracker call");
  });

  it("reads the tracker history for the record id and returns the entries", async () => {
    historyOn();
    expect(await loadTransferHistory("rec-1_A")).toEqual({ ok: true, entries: [ROW] });
    expect(await loadTransferHistory("x".repeat(128))).toEqual({ ok: true, entries: [ROW] });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenNthCalledWith(1, "/api/machine/acats/by-record/rec-1_A/history");
    markCase(SUITE, "reads the tracker history for the record id and returns the entries");
  });

  it("returns an empty list for a transfer with no history", async () => {
    historyOn();
    mocks.read.mockResolvedValueOnce({ status: 200, data: [] });
    expect(await loadTransferHistory("rec-1")).toEqual({ ok: true, entries: [] });
    markCase(SUITE, "returns an empty list for a transfer with no history");
  });

  it("returns a failure, never an empty list, when the tracker refuses or does not answer", async () => {
    historyOn();
    for (const answer of [{ status: 404, data: { error: "not_found" } }, { status: 401, data: { error: "unauthorized" } }, { status: 429, data: { error: "rate_limited" } }, { status: 500, data: { error: "internal_error" } }, { status: null, data: null }]) {
      mocks.read.mockResolvedValueOnce(answer);
      expect(await loadTransferHistory("rec-1")).toEqual({ ok: false, reason: "unavailable" });
    }
    markCase(SUITE, "returns a failure, never an empty list, when the tracker refuses or does not answer");
  });

  it("logs a failed read with its status and no record data", async () => {
    historyOn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.read.mockResolvedValueOnce({ status: 404, data: { error: "not_found" } });
    await loadTransferHistory("rec-secret-1");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("[acat-history] history_read_failed", { status: 404 });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("rec-secret-1");
    spy.mockClear();
    mocks.read.mockResolvedValueOnce({ status: 200, data: [ROW] });
    await loadTransferHistory("rec-1");
    vi.stubEnv("SHOW_ACAT_FIELD_HISTORY_TKT336", "0");
    await loadTransferHistory("rec-1");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    markCase(SUITE, "logs a failed read with its status and no record data");
  });
});
