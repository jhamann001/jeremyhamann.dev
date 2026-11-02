import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), trackerRead: vi.fn(), trackerPost: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/data/acat-reimbursement", () => ({ readTransferFeeRequests: mocks.read }));
// The tracker adapter is mocked only to prove the read never reaches it.
vi.mock("@/lib/data/acat-fee", () => ({ readTransferFee: mocks.trackerRead, postTransferFee: mocks.trackerPost }));

import { loadTransferFeeRequests } from "@/app/(authenticated)/acat-tracking/fee-requests-actions";
import { acatFeeRequestsReadEnabled } from "@/lib/operations/fee-request-link";

const SUITE = "acat-fee-requests-actions";
const ON: Record<string, string> = {
  EPIC_ACAT_OPS_WORKSPACE_TKT290: "1", SHOW_ACAT_OPS_BOOK_TKT293: "1", ALLOW_ACAT_OPS_EDITS_TKT294: "1",
  EPIC_ACAT_FEE_REIMBURSEMENT_TKT318: "1", SHOW_ACAT_FEE_REIMBURSEMENT_TKT333: "1",
  APP_ENV: "prod", OPERATIONS_TOOLS: "1", OPERATIONS_FEE_REQUESTS: "1", OPERATIONS_PRODUCTION_ENABLED: "1",
};
const HINTS = { cedarRidgeUserId: "user-1", maskedAccount: "********ZHLK" };
const READ = { identity: "resolved", clientName: "Pat Example", accountLabel: "IRA · ••••ZHLK", requests: [], truncated: false };

function stubOn() { for (const [key, value] of Object.entries(ON)) vi.stubEnv(key, value); }
function session(role: string | null) {
  mocks.auth.mockResolvedValue(role === null ? null : { user: { role, email: "synthetic@example.test" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubOn();
  session("OPERATIONS");
  mocks.read.mockResolvedValue(READ);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("requests-on-file action (ticket)", () => {
  it("reads once for an ADMIN or OPERATIONS user and passes the session identity and the hints", async () => {
    for (const role of ["ADMIN", "OPERATIONS"]) {
      mocks.read.mockClear();
      session(role);
      expect(await loadTransferFeeRequests("rec-1", HINTS)).toEqual({ ok: true, read: READ });
      expect(mocks.read).toHaveBeenCalledTimes(1);
      expect(mocks.read).toHaveBeenCalledWith({ role, email: "synthetic@example.test" }, { recordId: "rec-1", cedarRidgeUserId: "user-1", maskedAccount: "********ZHLK" });
    }
    markCase(SUITE, "reads once for an ADMIN or OPERATIONS user and passes the session identity and the hints");
  });

  it("refuses while any switch it depends on is off, and reads nothing", async () => {
    const keys = Object.keys(ON);
    for (const key of keys) {
      for (const value of ["", "0", "true"]) {
        vi.unstubAllEnvs();
        stubOn();
        vi.stubEnv(key, value);
        if (key === "APP_ENV") continue;
        expect(await loadTransferFeeRequests("rec-1", HINTS), `${key}=${value}`).toEqual({ ok: false, code: "off" });
      }
    }
    expect(mocks.read).not.toHaveBeenCalled();
    markCase(SUITE, "refuses while any switch it depends on is off, and reads nothing");
  });

  it("does not need the reimbursement create switch", async () => {
    vi.stubEnv("SHOW_ACAT_FEE_REQUEST_CREATE_TKT350", "0");
    expect(await loadTransferFeeRequests("rec-1", HINTS)).toEqual({ ok: true, read: READ });
    markCase(SUITE, "does not need the reimbursement create switch");
  });

  it("refuses an unauthenticated caller and every role except ADMIN and OPERATIONS, and reads nothing", async () => {
    session(null);
    expect(await loadTransferFeeRequests("rec-1", HINTS)).toEqual({ ok: false, code: "forbidden" });
    mocks.auth.mockResolvedValue({ user: { role: "ADMIN" } });
    expect(await loadTransferFeeRequests("rec-1", HINTS)).toEqual({ ok: false, code: "forbidden" });
    for (const role of ["OPS", "ADVISOR", "CLIENT_SERVICE", "VIEWER", "", "SOMETHING_ELSE"]) {
      session(role);
      expect(await loadTransferFeeRequests("rec-1", HINTS), role).toEqual({ ok: false, code: "forbidden" });
    }
    expect(mocks.read).not.toHaveBeenCalled();
    markCase(SUITE, "refuses an unauthenticated caller and every role except ADMIN and OPERATIONS, and reads nothing");
  });

  it("rejects malformed input before reading", async () => {
    for (const recordId of ["", "x".repeat(200), 5 as unknown as string]) {
      expect(await loadTransferFeeRequests(recordId, HINTS)).toEqual({ ok: false, code: "invalid" });
    }
    expect(await loadTransferFeeRequests("rec-1", { cedarRidgeUserId: "", maskedAccount: null })).toEqual({ ok: false, code: "invalid" });
    expect(await loadTransferFeeRequests("rec-1", { cedarRidgeUserId: null, maskedAccount: "x".repeat(65) })).toEqual({ ok: false, code: "invalid" });
    expect(await loadTransferFeeRequests("rec-1", undefined as unknown as typeof HINTS)).toEqual({ ok: false, code: "invalid" });
    expect(await loadTransferFeeRequests("rec-1", { cedarRidgeUserId: null, maskedAccount: null })).toEqual({ ok: true, read: READ });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    markCase(SUITE, "rejects malformed input before reading");
  });

  it("turns a failed read into a retryable code and logs only a fixed marker", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.read.mockRejectedValue(new Error("db down for 003BLO191836131AAA"));
    expect(await loadTransferFeeRequests("rec-1", HINTS)).toEqual({ ok: false, code: "unavailable" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[acat-fee-requests] read_failed");
    markCase(SUITE, "turns a failed read into a retryable code and logs only a fixed marker");
  });

  it("never reaches the tracker, Fee Store or a write: source and runtime guards", async () => {
    await loadTransferFeeRequests("rec-1", HINTS);
    expect(mocks.trackerRead).not.toHaveBeenCalled();
    expect(mocks.trackerPost).not.toHaveBeenCalled();
    const actionSource = readFileSync("app/(authenticated)/acat-tracking/fee-requests-actions.ts", "utf8");
    expect(actionSource).not.toMatch(/from "@\/lib\/data\/acat-fee"|postTransferFee|readTransferFee\b|createReimbursementRequest|createOperationsFeeRequest|transitionOperationsFeeRequest|revalidatePath/);
    const listSource = readFileSync("components/transfers/TransferFeeRequestsList.tsx", "utf8");
    expect(listSource).not.toMatch(/EXTERNAL_APPS|acatTracking|transfer-tracker|FEE_STORE/i);
    markCase(SUITE, "never reaches the tracker, Fee Store or a write: source and runtime guards");
  });

  it("the server-side availability needs the fee release, the Operations Tools requests and an ADMIN or OPERATIONS role", () => {
    for (const role of ["ADMIN", "OPERATIONS"]) expect(acatFeeRequestsReadEnabled(role), role).toBe(true);
    for (const role of ["OPS", "ADVISOR", "VIEWER", "CLIENT_SERVICE", "", null, undefined]) expect(acatFeeRequestsReadEnabled(role), String(role)).toBe(false);
    for (const key of ["EPIC_ACAT_FEE_REIMBURSEMENT_TKT318", "SHOW_ACAT_FEE_REIMBURSEMENT_TKT333", "OPERATIONS_TOOLS", "OPERATIONS_FEE_REQUESTS", "OPERATIONS_PRODUCTION_ENABLED"]) {
      vi.unstubAllEnvs();
      stubOn();
      vi.stubEnv(key, "0");
      expect(acatFeeRequestsReadEnabled("OPERATIONS"), key).toBe(false);
    }
    vi.unstubAllEnvs();
    stubOn();
    vi.stubEnv("SHOW_ACAT_FEE_REQUEST_CREATE_TKT350", "0");
    expect(acatFeeRequestsReadEnabled("OPERATIONS")).toBe(true);
    markCase(SUITE, "the server-side availability needs the fee release, the Operations Tools requests and an ADMIN or OPERATIONS role");
  });
});
