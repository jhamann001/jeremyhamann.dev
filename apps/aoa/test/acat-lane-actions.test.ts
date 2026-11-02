import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcatStatus } from "@/lib/data/acat-status";

// Locks the ACAT-detail by-RECORD-id action's GATE WIRING (not just the
// canSeeUnlinkedAcats predicate, which is covered elsewhere). The ACAT Tracking
// page's detail drawer loads through loadUnlinkedAcatDetail, and that action
// RE-GATES server-side to the firm-wide roles — a caller who shouldn't see the
// list must not be able to pull a record by id either. Here `@/auth` and the
// server-only `getAcatStatusByRecordId` are mocked (so the action imports
// cleanly in the node env), but the REAL canSeeUnlinkedAcats runs — this
// exercises the actual role check + the role default path, then the 200 / throw
// outcomes. The action keys on the RECORD id (not acatTransferId), so two rows
// sharing a placeholder acatTransferId still resolve to DISTINCT records.

const { authSpy, getAcatStatusByRecordIdSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  getAcatStatusByRecordIdSpy: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/data/acat-status", () => ({
  getAcatOpsStatusByRecordId: getAcatStatusByRecordIdSpy,
}));

import { loadUnlinkedAcatDetail } from "@/app/(authenticated)/asset-transfer/acat-lane-actions";

const STATUS: AcatStatus = {
  acatTransferId: "A1",
  controlNumber: null,
  direction: "Incoming",
  type: null,
  accountType: null,
  status: "Accepted",
  transferringContra: null,
  statementAmount: null,
  methodRequested: null,
  feeCharged: null,
  feeAmount: null,
  acatDate: null,
  apexAccountId: null,
  statementAccountNumber: null,
  dtccNumber: null,
  assets: [],
};

const sessionFor = (role: string | undefined) => ({
  user: { email: "u@example.com", ...(role !== undefined ? { role } : {}) },
});

beforeEach(() => {
  authSpy.mockReset();
  getAcatStatusByRecordIdSpy.mockReset();
  getAcatStatusByRecordIdSpy.mockResolvedValue(STATUS);
});
afterEach(() => vi.clearAllMocks());

describe("loadUnlinkedAcatDetail — gate wiring", () => {
  it("forbids when there is no session (never fetches)", async () => {
    authSpy.mockResolvedValue(null);
    const res = await loadUnlinkedAcatDetail("rec-1");
    expect(res).toEqual({ ok: false, reason: "forbidden" });
    expect(getAcatStatusByRecordIdSpy).not.toHaveBeenCalled();
  });

  it("forbids non-firm roles ADVISOR / CLIENT_SERVICE / VIEWER (never fetches)", async () => {
    for (const role of ["ADVISOR", "CLIENT_SERVICE", "VIEWER"]) {
      authSpy.mockResolvedValue(sessionFor(role));
      const res = await loadUnlinkedAcatDetail("rec-1");
      expect(res).toEqual({ ok: false, reason: "forbidden" });
    }
    expect(getAcatStatusByRecordIdSpy).not.toHaveBeenCalled();
  });

  it("forbids the role-default path (a session with no role field → deny)", async () => {
    // Mirrors the page's `role ?? "VIEWER"` fail-closed default: a user object
    // that carries no role must not reach a firm-wide record.
    authSpy.mockResolvedValue(sessionFor(undefined));
    const res = await loadUnlinkedAcatDetail("rec-1");
    expect(res).toEqual({ ok: false, reason: "forbidden" });
    expect(getAcatStatusByRecordIdSpy).not.toHaveBeenCalled();
  });

  it("allows ADMIN and OPERATIONS and fetches by the RECORD id", async () => {
    for (const role of ["ADMIN", "OPERATIONS"]) {
      getAcatStatusByRecordIdSpy.mockClear();
      authSpy.mockResolvedValue(sessionFor(role));
      const res = await loadUnlinkedAcatDetail("rec-abc");
      expect(res).toEqual({ ok: true, status: STATUS });
      // Keyed on the record id passed in — NOT an acatTransferId.
      expect(getAcatStatusByRecordIdSpy).toHaveBeenCalledWith("rec-abc");
    }
  });

  it("resolves DISTINCT records for two rows that share a placeholder acatTransferId", async () => {
    // The core fix: both rows carry acatTransferId "N/A" upstream, but the
    // action is handed their DISTINCT record ids and returns each row's OWN
    // record — never the same one for both.
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));

    const recA: AcatStatus = { ...STATUS, acatTransferId: "N/A", statementAmount: 742900 };
    const recB: AcatStatus = { ...STATUS, acatTransferId: "N/A", statementAmount: 218400 };
    getAcatStatusByRecordIdSpy.mockResolvedValueOnce(recA);
    getAcatStatusByRecordIdSpy.mockResolvedValueOnce(recB);

    const resA = await loadUnlinkedAcatDetail("rec-manual-hayes");
    const resB = await loadUnlinkedAcatDetail("rec-manual-armstrong");

    expect(getAcatStatusByRecordIdSpy).toHaveBeenNthCalledWith(1, "rec-manual-hayes");
    expect(getAcatStatusByRecordIdSpy).toHaveBeenNthCalledWith(2, "rec-manual-armstrong");
    expect(resA).toEqual({ ok: true, status: recA });
    expect(resB).toEqual({ ok: true, status: recB });
    // Same placeholder acatTransferId, DIFFERENT resolved records.
    expect(resA).not.toEqual(resB);
  });

  it("passes through a 404/null (permitted role, no such record)", async () => {
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    getAcatStatusByRecordIdSpy.mockResolvedValue(null);
    const res = await loadUnlinkedAcatDetail("nope");
    expect(res).toEqual({ ok: true, status: null });
  });

  it("degrades a fetch throw to a quiet error result (permitted role)", async () => {
    authSpy.mockResolvedValue(sessionFor("OPERATIONS"));
    getAcatStatusByRecordIdSpy.mockRejectedValue(new Error("tracker 500"));
    const res = await loadUnlinkedAcatDetail("rec-1");
    expect(res).toEqual({ ok: false, reason: "error" });
  });
});
