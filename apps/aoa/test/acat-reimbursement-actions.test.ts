import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), prefill: vi.fn(), pending: vi.fn(), create: vi.fn(), revalidate: vi.fn(), trackerRead: vi.fn(), trackerPost: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/data/acat-reimbursement", () => ({
  readReimbursementPrefill: mocks.prefill,
  readPendingReimbursements: mocks.pending,
  createReimbursementRequest: mocks.create,
}));
// The tracker adapter is mocked only to prove no reimbursement action reaches it.
vi.mock("@/lib/data/acat-fee", () => ({ readTransferFee: mocks.trackerRead, postTransferFee: mocks.trackerPost }));

import {
  lookupPendingReimbursements,
  previewTransferReimbursement,
  submitTransferReimbursement,
} from "@/app/(authenticated)/acat-tracking/reimbursement-actions";
import type { ReimbursementSubmitInput } from "@/lib/data/acat-reimbursement-view";

const SUITE = "acat-reimbursement-actions";
const CLIENT = "003BLO191836131AAA";
const KEY = "6fc31a81-ae16-4a1d-849b-7c69cb575a4d";

const ON: Record<string, string> = {
  EPIC_ACAT_OPS_WORKSPACE_TKT290: "1", SHOW_ACAT_OPS_BOOK_TKT293: "1", ALLOW_ACAT_OPS_EDITS_TKT294: "1",
  EPIC_ACAT_FEE_REIMBURSEMENT_TKT318: "1", SHOW_ACAT_FEE_REIMBURSEMENT_TKT333: "1", SHOW_ACAT_FEE_REQUEST_CREATE_TKT350: "1",
  APP_ENV: "prod", OPERATIONS_TOOLS: "1", OPERATIONS_FEE_REQUESTS: "1", OPERATIONS_PRODUCTION_ENABLED: "1",
};
const INPUT: ReimbursementSubmitInput = {
  submissionKey: KEY, clientSfId: CLIENT, accountId: "acct-1", feeAmount: "50.00", feeTypes: ["ACAT out"], reason: "Reason", tickets: "APX-1",
};
const HINTS = { cedarRidgeUserId: "user-1", maskedAccount: "********ZHLK" };
const REQUEST = { id: "req_000000000000001", status: "PENDING", clientName: "Pat Example", accountLabel: "IRA · ••••ZHLK", feeAmount: "50.00", feeTypes: ["ACAT out"], submittedAt: "2026-10-15T12:00:00.000Z" };

function stubOn() { for (const [key, value] of Object.entries(ON)) vi.stubEnv(key, value); }
function session(role: string | null) {
  mocks.auth.mockResolvedValue(role === null ? null : { user: { role, email: "synthetic@example.test" } });
}
function noReads() {
  expect(mocks.prefill).not.toHaveBeenCalled();
  expect(mocks.pending).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.revalidate).not.toHaveBeenCalled();
}

const ALL: Record<string, () => Promise<unknown>> = {
  preview: () => previewTransferReimbursement("rec-1", HINTS),
  pending: () => lookupPendingReimbursements(CLIENT, "acct-1"),
  submit: () => submitTransferReimbursement(INPUT),
};

beforeEach(() => {
  vi.clearAllMocks();
  stubOn();
  session("OPERATIONS");
  mocks.prefill.mockResolvedValue({ client: null, clientSource: "none", accountId: null, pending: [] });
  mocks.pending.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ ok: true, request: REQUEST });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("reimbursement actions (ticket)", () => {
  it("every action refuses while any switch is off and touches nothing", async () => {
    const keys = [
      "EPIC_ACAT_OPS_WORKSPACE_TKT290", "SHOW_ACAT_OPS_BOOK_TKT293", "ALLOW_ACAT_OPS_EDITS_TKT294", "EPIC_ACAT_FEE_REIMBURSEMENT_TKT318",
      "SHOW_ACAT_FEE_REIMBURSEMENT_TKT333", "SHOW_ACAT_FEE_REQUEST_CREATE_TKT350", "OPERATIONS_TOOLS", "OPERATIONS_FEE_REQUESTS", "OPERATIONS_PRODUCTION_ENABLED",
    ];
    for (const key of keys) {
      for (const value of ["", "0", "true"]) {
        vi.unstubAllEnvs();
        stubOn();
        vi.stubEnv(key, value);
        for (const [name, run] of Object.entries(ALL)) {
          expect(await run(), `${key}=${value} ${name}`).toMatchObject({ ok: false, code: "off" });
        }
      }
    }
    noReads();
    markCase(SUITE, "every action refuses while any switch is off and touches nothing");
  });

  it("every action refuses a missing session and every role but ADMIN and OPERATIONS", async () => {
    session(null);
    for (const [name, run] of Object.entries(ALL)) expect(await run(), name).toMatchObject({ ok: false, code: "forbidden" });
    for (const role of ["ADVISOR", "VIEWER", "CLIENT_SERVICE", "OPS", ""]) {
      session(role);
      for (const [name, run] of Object.entries(ALL)) expect(await run(), `${role} ${name}`).toMatchObject({ ok: false, code: "forbidden" });
    }
    noReads();
    for (const role of ["ADMIN", "OPERATIONS"]) {
      session(role);
      for (const [name, run] of Object.entries(ALL)) expect(await run(), `${role} ${name}`).toMatchObject({ ok: true });
    }
    markCase(SUITE, "every action refuses a missing session and every role but ADMIN and OPERATIONS");
  });

  it("the preview and the pending lookup only read, and pass the caller's own identity", async () => {
    await previewTransferReimbursement("rec-1", HINTS);
    expect(mocks.prefill).toHaveBeenCalledWith({ role: "OPERATIONS", email: "synthetic@example.test" }, { recordId: "rec-1", cedarRidgeUserId: "user-1", maskedAccount: "********ZHLK" });
    await lookupPendingReimbursements(CLIENT, "acct-1");
    expect(mocks.pending).toHaveBeenCalledWith({ role: "OPERATIONS", email: "synthetic@example.test" }, CLIENT, "acct-1");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    markCase(SUITE, "the preview and the pending lookup only read, and pass the caller's own identity");
  });

  it("rejects malformed input before any read or write", async () => {
    for (const bad of [
      () => previewTransferReimbursement("", HINTS),
      () => previewTransferReimbursement("x".repeat(200), HINTS),
      () => previewTransferReimbursement("rec-1", { cedarRidgeUserId: 5 as never, maskedAccount: null }),
      () => previewTransferReimbursement("rec-1", { cedarRidgeUserId: null, maskedAccount: "x".repeat(65) }),
      () => lookupPendingReimbursements("Pat Example", "acct-1"),
      () => lookupPendingReimbursements(CLIENT, ""),
      () => submitTransferReimbursement({ ...INPUT, clientSfId: "Pat Example" }),
      () => submitTransferReimbursement({ ...INPUT, clientSfId: "" }),
      () => submitTransferReimbursement({ ...INPUT, accountId: "" }),
      () => submitTransferReimbursement({ ...INPUT, submissionKey: "nope" }),
      () => submitTransferReimbursement({ ...INPUT, feeTypes: [] }),
      () => submitTransferReimbursement({ ...INPUT, feeTypes: "ACAT out" as never }),
      () => submitTransferReimbursement({ ...INPUT, feeAmount: 50 as never }),
      () => submitTransferReimbursement({ ...INPUT, reason: "x".repeat(4001) }),
      () => submitTransferReimbursement(null as never),
    ]) {
      expect(await bad()).toMatchObject({ ok: false, code: "invalid" });
    }
    noReads();
    markCase(SUITE, "rejects malformed input before any read or write");
  });

  it("confirm creates exactly one request with the confirmed values and refreshes the Operations Tools page", async () => {
    const edited = { ...INPUT, clientSfId: "003MLO108774638AAA", accountId: "acct-9", feeAmount: "75.25", feeTypes: ["ACAT out", "Wire"], reason: "Edited", tickets: "APX-9" };
    const result = await submitTransferReimbursement(edited);
    expect(result).toEqual({ ok: true, request: REQUEST });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith({ role: "OPERATIONS", email: "synthetic@example.test" }, edited);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledWith("/operations/fee-requests");
    markCase(SUITE, "confirm creates exactly one request with the confirmed values and refreshes the Operations Tools page");
  });

  it("a failed create reports the code and refreshes nothing", async () => {
    for (const code of ["identity", "conflict", "failed", "invalid"] as const) {
      mocks.create.mockResolvedValueOnce({ ok: false, code, field: null });
      expect(await submitTransferReimbursement(INPUT)).toEqual({ ok: false, code, field: null });
    }
    expect(mocks.revalidate).not.toHaveBeenCalled();
    markCase(SUITE, "a failed create reports the code and refreshes nothing");
  });

  it("a read failure is reported as unavailable without leaking the error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.prefill.mockRejectedValueOnce(new Error("secret database detail"));
    mocks.pending.mockRejectedValueOnce(new Error("secret database detail"));
    expect(await previewTransferReimbursement("rec-1", HINTS)).toEqual({ ok: false, code: "unavailable" });
    expect(await lookupPendingReimbursements(CLIENT, "acct-1")).toEqual({ ok: false, code: "unavailable" });
    expect(spy.mock.calls.flat().join(" ")).not.toContain("secret");
    spy.mockRestore();
    markCase(SUITE, "a read failure is reported as unavailable without leaking the error");
  });

  it("no reimbursement action calls the tracker", async () => {
    for (const run of Object.values(ALL)) await run();
    expect(mocks.trackerRead).not.toHaveBeenCalled();
    expect(mocks.trackerPost).not.toHaveBeenCalled();
    markCase(SUITE, "no reimbursement action calls the tracker");
  });
});
