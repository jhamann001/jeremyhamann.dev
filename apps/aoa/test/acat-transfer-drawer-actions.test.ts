import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => {
  class CustodianLibraryError extends Error {}
  return {
    auth: vi.fn(), write: vi.fn(), read: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(),
    CustodianLibraryError,
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/data/acat-status", () => ({ writeAcatBookRecord: mocks.write, readAcatMachine: mocks.read }));
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: mocks.stale }));
vi.mock("@/lib/data/custodian-library", () => ({
  getCustodianLibrary: mocks.library,
  CustodianLibraryError: mocks.CustodianLibraryError,
}));

import {
  changeTransferField,
  changeTransferStatus,
  completeTransfer,
  deleteTransfer,
  listTransferContras,
  loadDtccSuggestion,
  loadTransferDrawer,
  rejectTransfer,
  replaceTransferClient,
  saveTransferText,
  searchTransferClients,
} from "@/app/(authenticated)/acat-tracking/transfer-drawer-actions";
import {
  ACAT_DRAWER_ADMIN_ONLY,
  ACAT_DRAWER_BLANK,
  ACAT_DRAWER_LOAD_FAILURE,
  ACAT_DRAWER_MASKED,
  ACAT_DRAWER_OFF,
  ACAT_DRAWER_REASON_SHORT,
  ACAT_DRAWER_SEARCH_FAILURE,
  ACAT_EDIT_FORBIDDEN,
  ACAT_WRITE_UNAVAILABLE,
} from "@/lib/data/acat-drawer-contract";
import { ACAT_EDITS_OFF } from "@/lib/data/acat-book-edit";

const SUITE = "acat-transfer-drawer-actions";
const BOOK_EPIC = "EPIC_ACAT_OPS_WORKSPACE_TKT290";
const BOOK_SHOW = "SHOW_ACAT_OPS_BOOK_TKT293";
const EDITS = "ALLOW_ACAT_OPS_EDITS_TKT294";
const EPIC = "EPIC_ACAT_TRANSFER_DRAWER_TKT319";
const SHOW = "SHOW_ACAT_TRANSFER_DRAWER_TKT332";
const USER = "user-11111111-1111-1111-1111-111111111111";
const BY_RECORD = "/api/machine/acats/by-record/rec-1";
const DRAWER = `${BY_RECORD}/drawer`;
const OPS_DRAWER = "/api/machine/acats/ops-drawer/rec-1";

function drawerOn() {
  vi.stubEnv(BOOK_EPIC, "1");
  vi.stubEnv(BOOK_SHOW, "1");
  vi.stubEnv(EDITS, "1");
  vi.stubEnv(EPIC, "1");
  vi.stubEnv(SHOW, "1");
}

function raw(over: Record<string, unknown> = {}) {
  return {
    id: "rec-1", identityVersion: 4, clientName: "Pat Example", status: "Submitted", controlNumber: "CTRL-9",
    direction: "In", dtccNumber: "0443", apexAccountId: "****3402", assets: [], ...over,
  };
}

function session(role: string | null) {
  mocks.auth.mockResolvedValue(role === null ? null : { user: { role, email: "synthetic@example.test" } });
}

type Call = () => Promise<unknown>;
const ALL_ACTIONS: Record<string, Call> = {
  load: () => loadTransferDrawer("rec-1"),
  change: () => changeTransferField("rec-1", "direction", "Out"),
  complete: () => completeTransfer("rec-1", { apexCompletionDate: "2026-10-12", controlNumber: "CTRL-9" }),
  reject: () => rejectTransfer("rec-1", "Wrong custodian"),
  status: () => changeTransferStatus("rec-1", "Accepted"),
  text: () => saveTransferText("rec-1", "notes", "hello"),
  delete: () => deleteTransfer("rec-1", "Wrong client"),
  replace: () => replaceTransferClient("rec-1", {
    cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: "Name fixed", apexAccountId: "", acknowledgeMappingInvalidation: false,
  }),
  search: () => searchTransferClients("Pat Example"),
  contras: () => listTransferContras(),
  suggestion: () => loadDtccSuggestion("Fidelity"),
};

function noTrackerCall() {
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.library).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ status: 401, data: { error: "unauthorized" } });
  session("OPERATIONS");
  drawerOn();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("transfer drawer actions", () => {
  it("tkt332 actions: every action is refused while the drawer is off and makes no tracker call", async () => {
    vi.stubEnv(EPIC, "0");
    for (const [name, call] of Object.entries(ALL_ACTIONS)) {
      expect(await call(), name).toMatchObject({ ok: false, reason: ACAT_DRAWER_OFF });
    }
    vi.stubEnv(EPIC, "1");
    vi.stubEnv(SHOW, "");
    expect(await loadTransferDrawer("rec-1")).toMatchObject({ reason: ACAT_DRAWER_OFF });
    vi.stubEnv(SHOW, "1");
    vi.stubEnv(BOOK_SHOW, "0");
    expect(await loadTransferDrawer("rec-1")).toMatchObject({ reason: ACAT_DRAWER_OFF });
    noTrackerCall();
    markCase(SUITE, "tkt332 actions: every action is refused while the drawer is off and makes no tracker call");
  });

  it("tkt332 actions: every action is refused for a viewer and makes no tracker call", async () => {
    session("VIEWER");
    for (const [name, call] of Object.entries(ALL_ACTIONS)) {
      expect(await call(), name).toMatchObject({ ok: false, reason: ACAT_EDIT_FORBIDDEN });
    }
    session(null);
    for (const [name, call] of Object.entries(ALL_ACTIONS)) {
      expect(await call(), name).toMatchObject({ ok: false, reason: ACAT_EDIT_FORBIDDEN });
    }
    noTrackerCall();
    markCase(SUITE, "tkt332 actions: every action is refused for a viewer and makes no tracker call");
  });

  it("tkt332 actions: loading returns the tracker projection with its identity version", async () => {
    mocks.read.mockResolvedValue({ status: 200, data: raw() });
    const result = await loadTransferDrawer("rec-1");
    expect(mocks.read).toHaveBeenCalledWith(OPS_DRAWER);
    expect(result).toMatchObject({ ok: true, transfer: { id: "rec-1", identityVersion: 4, dtccNumber: "0443" } });
    expect(mocks.write).not.toHaveBeenCalled();
    expect(await loadTransferDrawer("../etc")).toMatchObject({ ok: false, reason: ACAT_DRAWER_LOAD_FAILURE });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt332 actions: loading returns the tracker projection with its identity version");
  });

  it("tkt426 drawer: loading shows the full account numbers from the operations read", async () => {
    mocks.read.mockResolvedValue({ status: 200, data: raw({ apexAccountId: "IQQJRXDW3402", statementAccountNumber: "EHHWFABW8819" }) });
    const result = await loadTransferDrawer("rec-1");
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledWith(OPS_DRAWER);
    expect(result).toMatchObject({ ok: true, transfer: { apexAccountId: "IQQJRXDW3402", statementAccountNumber: "EHHWFABW8819" } });
  });

  it("tkt426 drawer: a refused operations read falls back to the masked drawer read", async () => {
    mocks.read
      .mockResolvedValueOnce({ status: 401, data: { error: "unauthorized" } })
      .mockResolvedValueOnce({ status: 200, data: raw({ statementAccountNumber: "****8819" }) });
    const result = await loadTransferDrawer("rec-1");
    expect(mocks.read.mock.calls).toEqual([[OPS_DRAWER], [BY_RECORD]]);
    expect(result).toMatchObject({ ok: true, transfer: { apexAccountId: "****3402", statementAccountNumber: "****8819" } });

    mocks.read.mockClear();
    mocks.read
      .mockResolvedValueOnce({ status: 404, data: { error: "not_found" } })
      .mockResolvedValueOnce({ status: 200, data: raw() });
    expect(await loadTransferDrawer("rec-1")).toMatchObject({ ok: true, transfer: { apexAccountId: "****3402" } });
    expect(mocks.read.mock.calls).toEqual([[OPS_DRAWER], [BY_RECORD]]);
  });

  it("tkt426 drawer: a stored write keeps the full account numbers from the operations read", async () => {
    mocks.write.mockResolvedValue({ status: 200, data: { transfer: raw({ direction: "Out", statementAccountNumber: "****8819" }) } });
    mocks.read.mockResolvedValue({ status: 200, data: raw({ apexAccountId: "IQQJRXDW3402", statementAccountNumber: "EHHWFABW8819" }) });
    const result = await changeTransferField("rec-1", "direction", "Out");
    expect(mocks.read).toHaveBeenCalledWith(OPS_DRAWER);
    expect(result).toMatchObject({ ok: true, transfer: { direction: "Out", apexAccountId: "IQQJRXDW3402", statementAccountNumber: "EHHWFABW8819" } });
  });

  it("tkt426 drawer: a stored write stays masked when the operations read refuses", async () => {
    mocks.write.mockResolvedValue({ status: 200, data: { transfer: raw({ direction: "Out", statementAccountNumber: "****8819" }) } });
    const result = await changeTransferField("rec-1", "direction", "Out");
    expect(result).toMatchObject({ ok: true, transfer: { direction: "Out", apexAccountId: "****3402", statementAccountNumber: "****8819" } });
  });

  it("tkt332 actions: loading failure is retryable when the tracker gives no answer or 500 and final on 404", async () => {
    mocks.read.mockResolvedValueOnce({ status: null, data: null });
    expect(await loadTransferDrawer("rec-1")).toEqual({ ok: false, reason: ACAT_DRAWER_LOAD_FAILURE, retryable: true });
    mocks.read.mockResolvedValueOnce({ status: 500, data: { error: "internal_error" } });
    expect(await loadTransferDrawer("rec-1")).toMatchObject({ retryable: true });
    mocks.read
      .mockResolvedValueOnce({ status: 404, data: { error: "not_found" } })
      .mockResolvedValueOnce({ status: 404, data: { error: "not_found" } });
    expect(await loadTransferDrawer("rec-1")).toEqual({ ok: false, reason: ACAT_DRAWER_LOAD_FAILURE, retryable: false });
    mocks.read.mockResolvedValueOnce({ status: 200, data: { clientName: "no id" } });
    expect(await loadTransferDrawer("rec-1")).toMatchObject({ ok: false, retryable: true });
    markCase(SUITE, "tkt332 actions: loading failure is retryable when the tracker gives no answer or 500 and final on 404");
  });

  it("tkt332 actions: a field change sends one change request to the drawer route and returns the stored value", async () => {
    mocks.write.mockResolvedValue({ status: 200, data: { transfer: raw({ direction: "Out" }) } });
    const result = await changeTransferField("rec-1", "direction", " Out ");
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write).toHaveBeenCalledWith("PATCH", DRAWER, { action: "change", field: "direction", value: "Out" });
    expect(result).toMatchObject({ ok: true, transfer: { direction: "Out" } });
    markCase(SUITE, "tkt332 actions: a field change sends one change request to the drawer route and returns the stored value");
  });

  it("tkt332 actions: a field change forwards the identity version for Apex account and transfer id", async () => {
    mocks.write.mockResolvedValue({ status: 200, data: { transfer: raw() } });
    await changeTransferField("rec-1", "apexAccountId", "12345678", { identityVersion: 4 });
    await changeTransferField("rec-1", "acatTransferId", "ACAT-9", { identityVersion: 4 });
    await changeTransferField("rec-1", "wealthAdvisor", "Rachel", { identityVersion: 4 });
    expect(mocks.write.mock.calls.map((c) => c[2])).toEqual([
      { action: "change", field: "apexAccountId", value: "12345678", expectedIdentityVersion: 4 },
      { action: "change", field: "acatTransferId", value: "ACAT-9", expectedIdentityVersion: 4 },
      { action: "change", field: "wealthAdvisor", value: "Rachel" },
    ]);
    markCase(SUITE, "tkt332 actions: a field change forwards the identity version for Apex account and transfer id");
  });

  it("tkt332 actions: a refused field change returns the tracker reason and the unchanged transfer", async () => {
    mocks.write.mockResolvedValue({ status: 400, data: { error: "Invalid direction", transfer: raw({ direction: "In" }) } });
    const result = await changeTransferField("rec-1", "direction", "Sideways");
    expect(result).toMatchObject({ ok: false, reason: "Invalid direction", retryable: false, current: { direction: "In" } });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.stale).not.toHaveBeenCalled();
    markCase(SUITE, "tkt332 actions: a refused field change returns the tracker reason and the unchanged transfer");
  });

  it("tkt332 actions: a blank value, a masked placeholder, and an unknown field are refused without a call", async () => {
    expect(await changeTransferField("rec-1", "direction", "  ")).toMatchObject({ ok: false, reason: ACAT_DRAWER_BLANK });
    expect(await changeTransferField("rec-1", "apexAccountId", "****3402")).toMatchObject({ ok: false, reason: ACAT_DRAWER_MASKED });
    expect(await changeTransferField("rec-1", "statementAccountNumber", "•••• 8819")).toMatchObject({ reason: ACAT_DRAWER_MASKED });
    expect(await changeTransferField("rec-1", "dtccNumber", "*443")).toMatchObject({ reason: ACAT_DRAWER_MASKED });
    expect(await changeTransferField("rec-1", "feeCharged", "Yes")).toMatchObject({ ok: false });
    expect(await changeTransferField("rec-1", "status", "Completed")).toMatchObject({ ok: false });
    noTrackerCall();
    markCase(SUITE, "tkt332 actions: a blank value, a masked placeholder, and an unknown field are refused without a call");
  });

  it("tkt332 actions: complete sends the date and control number and returns the stored Completed transfer", async () => {
    mocks.write.mockResolvedValue({
      status: 200,
      data: { transfer: raw({ status: "Completed", controlNumber: "CTRL-9", apexCompletionDate: "2026-10-12" }) },
    });
    const result = await completeTransfer("rec-1", { apexCompletionDate: "2026-10-12", controlNumber: " CTRL-9 " });
    expect(mocks.write).toHaveBeenCalledWith("PATCH", DRAWER, {
      action: "complete", apexCompletionDate: "2026-10-12", controlNumber: "CTRL-9",
    });
    expect(result).toMatchObject({ ok: true, transfer: { status: "Completed", apexCompletionDate: "2026-10-12", controlNumber: "CTRL-9" } });
    markCase(SUITE, "tkt332 actions: complete sends the date and control number and returns the stored Completed transfer");
  });

  it("tkt332 actions: complete without a date is refused without a call", async () => {
    const result = await completeTransfer("rec-1", { apexCompletionDate: "", controlNumber: "CTRL-9" });
    expect(result).toMatchObject({ ok: false, reason: "Apex Completion Date is required to complete a transfer" });
    noTrackerCall();
    markCase(SUITE, "tkt332 actions: complete without a date is refused without a call");
  });

  it("tkt332 actions: a failed complete returns a retryable failure and no Completed transfer", async () => {
    mocks.write.mockResolvedValue({ status: 500, data: { error: "internal_error" } });
    const result = await completeTransfer("rec-1", { apexCompletionDate: "2026-10-12", controlNumber: "" });
    expect(result).toEqual({ ok: false, reason: ACAT_WRITE_UNAVAILABLE, retryable: true });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    markCase(SUITE, "tkt332 actions: a failed complete returns a retryable failure and no Completed transfer");
  });

  it("tkt332 actions: reject sends the trimmed reason and returns the stored Rejected transfer", async () => {
    mocks.write.mockResolvedValue({
      status: 200, data: { transfer: raw({ status: "Rejected", rejectionReason: "Wrong custodian" }) },
    });
    const result = await rejectTransfer("rec-1", "  Wrong custodian ");
    expect(mocks.write).toHaveBeenCalledWith("PATCH", DRAWER, { action: "reject", reason: "Wrong custodian" });
    expect(result).toMatchObject({ ok: true, transfer: { status: "Rejected", rejectionReason: "Wrong custodian" } });
    markCase(SUITE, "tkt332 actions: reject sends the trimmed reason and returns the stored Rejected transfer");
  });

  it("tkt332 actions: reject with a blank reason is refused without a call", async () => {
    expect(await rejectTransfer("rec-1", "   ")).toMatchObject({ ok: false, reason: "A rejection reason is required" });
    noTrackerCall();
    markCase(SUITE, "tkt332 actions: reject with a blank reason is refused without a call");
  });

  it("tkt332 actions: a failed reject returns a retryable failure and no Rejected transfer", async () => {
    mocks.write.mockResolvedValue({ status: null, data: null });
    const result = await rejectTransfer("rec-1", "Wrong custodian");
    expect(result).toEqual({ ok: false, reason: ACAT_WRITE_UNAVAILABLE, retryable: true });
    expect(mocks.stale).not.toHaveBeenCalled();
    markCase(SUITE, "tkt332 actions: a failed reject returns a retryable failure and no Rejected transfer");
  });

  it("tkt332 actions: another status change uses the general PATCH with a lifecycle status only", async () => {
    mocks.write.mockResolvedValue({ status: 200, data: raw({ status: "Accepted" }) });
    const result = await changeTransferStatus("rec-1", "Accepted");
    expect(mocks.write).toHaveBeenCalledWith("PATCH", BY_RECORD, { status: "Accepted" });
    expect(result).toMatchObject({ ok: true, transfer: { status: "Accepted" } });
    markCase(SUITE, "tkt332 actions: another status change uses the general PATCH with a lifecycle status only");
  });

  it("tkt332 actions: Completed, Rejected, and recon statuses are refused on the general status path", async () => {
    for (const status of ["Completed", "Rejected", "Matched", "Mismatch", "Pending", "Bogus", ""]) {
      expect(await changeTransferStatus("rec-1", status), status).toMatchObject({ ok: false });
    }
    noTrackerCall();
    markCase(SUITE, "tkt332 actions: Completed, Rejected, and recon statuses are refused on the general status path");
  });

  it("tkt332 actions: control number, notes, and trade instructions use the general PATCH and may be cleared", async () => {
    mocks.write.mockResolvedValue({ status: 200, data: raw() });
    await saveTransferText("rec-1", "controlNumber", " CTRL-1 ");
    await saveTransferText("rec-1", "notes", "");
    await saveTransferText("rec-1", "tradeInstructions", "  Sell all  ");
    expect(mocks.write.mock.calls).toEqual([
      ["PATCH", BY_RECORD, { controlNumber: "CTRL-1" }],
      ["PATCH", BY_RECORD, { notes: null }],
      ["PATCH", BY_RECORD, { tradeInstructions: "Sell all" }],
    ]);
    mocks.write.mockClear();
    for (const field of ["feeCharged", "feeAmount", "status", "clientName", "direction"]) {
      expect(await saveTransferText("rec-1", field, "x"), field).toMatchObject({ ok: false });
    }
    expect(mocks.write).not.toHaveBeenCalled();
    markCase(SUITE, "tkt332 actions: control number, notes, and trade instructions use the general PATCH and may be cleared");
  });

  it("tkt332 actions: admin delete sends a DELETE with the trimmed reason, marks the book stale, and revalidates the tracking page", async () => {
    session("ADMIN");
    mocks.write.mockResolvedValue({ status: 200, data: { removed: true, transfer: raw() } });
    const result = await deleteTransfer("rec-1", "  Wrong client ");
    expect(mocks.write).toHaveBeenCalledWith("DELETE", DRAWER, { reason: "Wrong client" });
    expect(result).toMatchObject({ ok: true, removed: true, transfer: { id: "rec-1" } });
    expect(mocks.stale).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledWith("/acat-tracking");
    markCase(SUITE, "tkt332 actions: admin delete sends a DELETE with the trimmed reason, marks the book stale, and revalidates the tracking page");
  });

  it("tkt332 actions: non-admin delete is refused without a call", async () => {
    session("OPERATIONS");
    expect(await deleteTransfer("rec-1", "Wrong client")).toEqual({ ok: false, reason: ACAT_DRAWER_ADMIN_ONLY, retryable: false });
    noTrackerCall();
    markCase(SUITE, "tkt332 actions: non-admin delete is refused without a call");
  });

  it("tkt332 actions: delete with a blank or short reason is refused without a call", async () => {
    session("ADMIN");
    expect(await deleteTransfer("rec-1", "   ")).toMatchObject({ ok: false, reason: ACAT_DRAWER_REASON_SHORT });
    expect(await deleteTransfer("rec-1", "ab")).toMatchObject({ ok: false, reason: ACAT_DRAWER_REASON_SHORT });
    noTrackerCall();
    markCase(SUITE, "tkt332 actions: delete with a blank or short reason is refused without a call");
  });

  it("tkt332 actions: a failed delete is retryable and reports no removal", async () => {
    session("ADMIN");
    mocks.write.mockResolvedValue({ status: 500, data: { error: "internal_error" } });
    const result = await deleteTransfer("rec-1", "Wrong client");
    expect(result).toEqual({ ok: false, reason: ACAT_WRITE_UNAVAILABLE, retryable: true });
    mocks.write.mockResolvedValue({ status: 200, data: { removed: false, transfer: raw() } });
    expect(await deleteTransfer("rec-1", "Wrong client")).toMatchObject({ ok: false });
    expect(mocks.stale).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
    markCase(SUITE, "tkt332 actions: a failed delete is retryable and reports no removal");
  });

  it("tkt332 actions: replacing a client sends the selected person, version, reason, and the display-name replacement", async () => {
    mocks.write.mockResolvedValue({ status: 200, data: { transfer: raw({ clientName: "Sam Selected" }) } });
    const result = await replaceTransferClient("rec-1", {
      cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: " Name fixed ", apexAccountId: "", acknowledgeMappingInvalidation: false,
    });
    expect(mocks.write).toHaveBeenCalledWith("PATCH", DRAWER, {
      action: "replaceClient",
      relink: { cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: "Name fixed", replaceDisplayName: true },
    });
    expect(result).toMatchObject({ ok: true, transfer: { clientName: "Sam Selected" } });
    markCase(SUITE, "tkt332 actions: replacing a client sends the selected person, version, reason, and the display-name replacement");
  });

  it("tkt332 actions: replacing a client asks for acknowledgement when the tracker requires mapping invalidation", async () => {
    const refusal = {
      error: "Changing the saved name clears its asset mapping link. Confirm this change first.",
      code: "MAPPING_INVALIDATION_REQUIRED",
      transfer: raw({ clientName: "Pat Example" }),
    };
    mocks.write.mockResolvedValueOnce({ status: 400, data: refusal });
    const first = await replaceTransferClient("rec-1", {
      cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: "Name fixed", apexAccountId: "", acknowledgeMappingInvalidation: false,
    });
    expect(first).toMatchObject({ ok: false, code: "MAPPING_INVALIDATION_REQUIRED", reason: refusal.error, current: { clientName: "Pat Example" } });
    expect(mocks.write.mock.calls[0][2].relink).not.toHaveProperty("acknowledgeMappingInvalidation");
    mocks.write.mockResolvedValueOnce({ status: 200, data: { transfer: raw({ clientName: "Sam Selected" }) } });
    await replaceTransferClient("rec-1", {
      cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: "Name fixed", apexAccountId: "", acknowledgeMappingInvalidation: true,
    });
    expect(mocks.write.mock.calls[1][2].relink.acknowledgeMappingInvalidation).toBe(true);
    markCase(SUITE, "tkt332 actions: replacing a client asks for acknowledgement when the tracker requires mapping invalidation");
  });

  it("tkt332 actions: a failed client replacement returns a retryable failure and no name", async () => {
    mocks.write.mockResolvedValue({ status: 500, data: { error: "internal_error" } });
    const result = await replaceTransferClient("rec-1", {
      cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: "Name fixed", apexAccountId: "", acknowledgeMappingInvalidation: false,
    });
    expect(result).toEqual({ ok: false, reason: ACAT_WRITE_UNAVAILABLE, retryable: true });
    expect(await replaceTransferClient("rec-1", {
      cedarRidgeUserIds: [USER], expectedIdentityVersion: 4, reason: "Name fixed", apexAccountId: "****3402", acknowledgeMappingInvalidation: false,
    })).toMatchObject({ ok: false, reason: ACAT_DRAWER_MASKED });
    expect(mocks.write).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt332 actions: a failed client replacement returns a retryable failure and no name");
  });

  it("tkt332 actions: client search is gated and keeps only selectable clients", async () => {
    mocks.read.mockResolvedValue({
      status: 200,
      data: {
        items: [{ cedarRidgeUserId: USER, displayName: "Pat Example", accountHints: [] }, { cedarRidgeUserId: "bad", displayName: "No" }],
        hasMore: false,
        directory: { writeEligible: true, enabled: true, health: "FRESH", pendingAccountPolicy: "ACCOUNT_REQUIRED" },
      },
    });
    const result = await searchTransferClients(" Pat Example ");
    expect(mocks.read).toHaveBeenCalledWith("/api/machine/clients/search?query=Pat%20Example&limit=20");
    expect(result).toMatchObject({ ok: true, clients: [{ cedarRidgeUserId: USER, displayName: "Pat Example" }], directory: { health: "FRESH" } });
    expect(await searchTransferClients("P")).toMatchObject({ ok: false });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    session("VIEWER");
    expect(await searchTransferClients("Pat Example")).toMatchObject({ ok: false, reason: ACAT_EDIT_FORBIDDEN });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt332 actions: client search is gated and keeps only selectable clients");
  });

  it("tkt332 actions: the contra list is gated and read from the custodian library", async () => {
    mocks.library.mockResolvedValue({ custodians: [{ name: "Fidelity", dtcNumber: "0226" }, { name: "Schwab" }] });
    const result = await listTransferContras();
    expect(mocks.library).toHaveBeenCalledWith("OPERATIONS");
    expect(result).toEqual({ ok: true, contras: [{ name: "Fidelity", dtcNumber: "0226" }, { name: "Schwab", dtcNumber: null }] });
    mocks.library.mockRejectedValue(new mocks.CustodianLibraryError("down"));
    expect(await listTransferContras()).toMatchObject({ ok: false, reason: "Custodian list is unavailable", retryable: true });
    session("VIEWER");
    mocks.library.mockClear();
    expect(await listTransferContras()).toMatchObject({ ok: false, reason: ACAT_EDIT_FORBIDDEN });
    expect(mocks.library).not.toHaveBeenCalled();
    markCase(SUITE, "tkt332 actions: the contra list is gated and read from the custodian library");
  });

  it("tkt332 actions: the DTCC suggestion reads the tracker with an encoded contra and fails closed", async () => {
    mocks.read.mockResolvedValueOnce({ status: 200, data: { status: "suggested", dtccNumber: "0443", source: "custodian", historicalSampleSize: 3 } });
    expect(await loadDtccSuggestion(" Fidelity & Co ")).toEqual({ ok: true, status: "suggested", dtccNumber: "0443" });
    expect(mocks.read).toHaveBeenCalledWith("/api/machine/dtcc-suggestion?contra=Fidelity%20%26%20Co");
    mocks.read.mockResolvedValueOnce({ status: 500, data: { error: "x" } });
    expect(await loadDtccSuggestion("Fidelity")).toEqual({ ok: true, status: "none", dtccNumber: null });
    mocks.read.mockResolvedValueOnce({ status: null, data: null });
    expect(await loadDtccSuggestion("Fidelity")).toEqual({ ok: true, status: "none", dtccNumber: null });
    mocks.read.mockResolvedValueOnce({ status: 200, data: { status: "ambiguous", dtccNumber: "0443" } });
    expect(await loadDtccSuggestion("Fidelity")).toEqual({ ok: true, status: "ambiguous", dtccNumber: null });
    mocks.read.mockClear();
    expect(await loadDtccSuggestion("   ")).toEqual({ ok: true, status: "none", dtccNumber: null });
    expect(await loadDtccSuggestion("x".repeat(121))).toEqual({ ok: true, status: "none", dtccNumber: null });
    expect(mocks.read).not.toHaveBeenCalled();
    markCase(SUITE, "tkt332 actions: the DTCC suggestion reads the tracker with an encoded contra and fails closed");
  });

  it("tkt332 actions: every successful write marks the book stale and revalidates the tracking page", async () => {
    session("ADMIN");
    mocks.write.mockImplementation(async (method: string, path: string) => ({
      status: 200,
      data: method === "DELETE" ? { removed: true, transfer: raw() }
        : path.endsWith("/drawer") ? { transfer: raw() } : raw(),
    }));
    const writes: Record<string, Call> = { ...ALL_ACTIONS };
    for (const read of ["load", "search", "contras", "suggestion"]) delete writes[read];
    let expected = 0;
    for (const [name, call] of Object.entries(writes)) {
      expect(await call(), name).toMatchObject({ ok: true });
      expected += 1;
      expect(mocks.stale, name).toHaveBeenCalledTimes(expected);
      expect(mocks.revalidate, name).toHaveBeenCalledTimes(expected);
    }
    expect(expected).toBe(7);
    mocks.read.mockResolvedValue({ status: 200, data: raw() });
    await loadTransferDrawer("rec-1");
    expect(mocks.stale).toHaveBeenCalledTimes(expected);
    markCase(SUITE, "tkt332 actions: every successful write marks the book stale and revalidates the tracking page");
  });

  it("tkt332 actions: client search failure returns the search failure message as a retryable failure", async () => {
    mocks.read.mockResolvedValue({ status: 503, data: { error: "unavailable" } });
    expect(await searchTransferClients("Pat Example")).toEqual({ ok: false, reason: ACAT_DRAWER_SEARCH_FAILURE, retryable: true });
    mocks.read.mockResolvedValue({ status: null, data: null });
    expect(await searchTransferClients("Pat Example")).toEqual({ ok: false, reason: ACAT_DRAWER_SEARCH_FAILURE, retryable: true });
    markCase(SUITE, "tkt332 actions: client search failure returns the search failure message as a retryable failure");
  });

  it("tkt332 actions: write and search actions are refused while edits are off and loading still works", async () => {
    vi.stubEnv(EDITS, "0");
    session("ADMIN");
    for (const [name, call] of Object.entries(ALL_ACTIONS)) {
      if (name === "load") continue;
      expect(await call(), name).toMatchObject({ ok: false, reason: ACAT_EDITS_OFF });
    }
    noTrackerCall();
    mocks.read.mockResolvedValue({ status: 200, data: raw() });
    expect(await loadTransferDrawer("rec-1")).toMatchObject({ ok: true, transfer: { id: "rec-1" } });
    markCase(SUITE, "tkt332 actions: write and search actions are refused while edits are off and loading still works");
  });
});
