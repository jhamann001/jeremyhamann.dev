import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AcatBookRow } from "@/lib/data/acat-book";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), scope: vi.fn(), revalidate: vi.fn(), redirect: vi.fn(),
  write: vi.fn(), stale: vi.fn(), attach: vi.fn(), signal: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/rls", () => ({ withUserScope: mocks.scope }));
vi.mock("@/lib/data/clients", () => ({ listClients: vi.fn() }));
vi.mock("@/lib/data/households", () => ({ listHouseholds: vi.fn() }));
vi.mock("@/lib/data/household-picker", () => ({ listHouseholdPickerTargets: vi.fn() }));
vi.mock("@/lib/data/transfers", () => ({ listTransfers: vi.fn() }));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: mocks.signal }));
vi.mock("@/lib/data/acat-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/acat-link")>()),
  attachAcatToTransfer: mocks.attach,
}));
vi.mock("@/lib/data/acat-status", () => ({
  writeAcatBookRecord: mocks.write, getAcatStatus: vi.fn(), getAcatStatusByRecordId: vi.fn(),
}));
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: mocks.stale }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data/custodian-library", () => ({
  getCustodianLibrary: vi.fn(),
  CustodianLibraryError: class CustodianLibraryError extends Error {},
}));
vi.mock("@/components/transfers/AcatUnlinkedDrawer", () => ({ AcatUnlinkedDrawer: () => null }));

import { acatOpsEditsEnabled } from "@/lib/flags";
import { emptyCreateDraft } from "@/lib/data/acat-create-contract";
import {
  ACAT_DAY_TO_DAY_OFF,
  ACAT_EDIT_FORBIDDEN,
  ACAT_EDIT_NOT_LIFECYCLE,
  ACAT_EDITS_OFF,
  ACAT_WRITE_UNAVAILABLE,
  bookRowFromSaved,
  buildAcatPatch,
  draftFromRow,
  editorAfterResult,
  lifecycleStatusOptions,
  validateCreateDraft,
  writeRejectionReason,
} from "@/lib/data/acat-book-edit";
import { createAcatBookRecord, restoreAcatBookRecord, saveAcatBookRecord } from "@/app/(authenticated)/acat-tracking/book-actions";
import { attachAcatToExistingTransfer } from "@/app/(authenticated)/acat-tracking/actions";
import { AcatBookView } from "@/components/transfers/AcatBookView";

const SUITE = "acat-book-edit";
const EPIC = "EPIC_ACAT_OPS_WORKSPACE_TKT290";
const BOOK = "SHOW_ACAT_OPS_BOOK_TKT293";
const EDITS = "ALLOW_ACAT_OPS_EDITS_TKT294";

function bookRow(over: Partial<AcatBookRow> = {}): AcatBookRow {
  return {
    id: "rec-1",
    acatTransferId: "ACAT-synthetic",
    clientName: "Synthetic Client",
    controlNumber: null,
    direction: "In",
    type: "Full",
    accountType: "Brokerage",
    status: "Submitted",
    transferringContra: "Synthetic Contra",
    statementAmount: 1000,
    acatDate: "2026-07-10",
    lastActivityAt: "2026-07-10T00:00:00.000Z",
    apexAccountId: "****1111",
    statementAccountNumber: null,
    dtccNumber: null,
    assetMap: { total: null, mapped: null, unmapped: null, pending: null, expected: null },
    wealthAdvisor: null,
    crmDealId: null,
    tradeInstructionsBlank: false,
    notes: null,
    tradeInstructions: null,
    custodianName: "",
    textLoadError: null,
    feeCharged: null,
    feeRequestCompleted: null,
    hasIssue: false,
    removedAt: null,
    ...over,
  };
}

const saved = (over: Record<string, unknown> = {}) => ({
  id: "rec-1", acatTransferId: "ACAT-synthetic", clientName: "Synthetic Client", direction: "In", type: "Full",
  status: "Submitted", apexAccountId: "****1111", tradeInstructions: null, ...over,
});

function flags(on: boolean) {
  vi.stubEnv(EPIC, on ? "1" : "");
  vi.stubEnv(BOOK, on ? "1" : "");
  vi.stubEnv(EDITS, on ? "1" : "");
}
const sessionFor = (role: string) => ({ user: { role, email: "synthetic@example.test" } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(sessionFor("OPERATIONS"));
  flags(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("acat book edit flag", () => {
  it("is on only when the epic and edits variables are both exactly 1", () => {
    vi.stubEnv(EPIC, "1");
    vi.stubEnv(EDITS, "1");
    expect(acatOpsEditsEnabled()).toBe(true);
    markCase(SUITE, "flag-on");
  });

  it("is off when either variable is unset, blank, 0 or true", () => {
    for (const [epic, edits] of [["", "1"], ["1", ""], ["0", "1"], ["1", "0"], ["true", "1"], ["1", "true"]]) {
      vi.stubEnv(EPIC, epic);
      vi.stubEnv(EDITS, edits);
      expect(acatOpsEditsEnabled()).toBe(false);
    }
    vi.unstubAllEnvs();
    delete process.env[EPIC];
    delete process.env[EDITS];
    expect(acatOpsEditsEnabled()).toBe(false);
    markCase(SUITE, "flag-off");
  });
});

describe("acat book edit helpers", () => {
  it("offers the 17 lifecycle statuses and no reconciliation statuses", () => {
    const values = lifecycleStatusOptions().map((o) => o.value);
    expect(values).toHaveLength(17);
    expect(values).toContain("WaitingForStatement");
    for (const recon of ["Matched", "Mismatch", "Pending"]) expect(values).not.toContain(recon);
    markCase(SUITE, "lifecycle-options");
  });

  it("builds a patch of only the changed editable fields", () => {
    const row = bookRow({ controlNumber: "C-1", wealthAdvisor: "Willie Doe" });
    const draft = { ...draftFromRow(row), status: " Accepted ", controlNumber: "", wealthAdvisor: "Willie Doe" };
    expect(buildAcatPatch(row, draft)).toEqual({ patch: { status: "Accepted", controlNumber: null }, changed: 2 });
    expect(buildAcatPatch(row, draftFromRow(row))).toEqual({ patch: {}, changed: 0 });
    markCase(SUITE, "patch-changed-only");
  });

  it("ignores draft keys outside the editable fields", () => {
    const row = bookRow();
    expect(buildAcatPatch(row, { ...draftFromRow(row), assets: "[]" })).toEqual({ patch: {}, changed: 0 });
    markCase(SUITE, "patch-ignores-unknown");
  });

  it("validates a new transfer and fills its defaults", () => {
    expect(validateCreateDraft({ clientName: " ", apexAccountId: "123" })).toEqual({ ok: false, reason: "Client name is required" });
    expect(validateCreateDraft({ clientName: "A", apexAccountId: "" })).toEqual({ ok: false, reason: "Apex account number is required" });
    expect(validateCreateDraft({ clientName: " A ", apexAccountId: "123", type: "", status: "" }))
      .toEqual({ ok: true, body: { clientName: "A", apexAccountId: "123", status: "AcatReceived" } });
    markCase(SUITE, "create-validation");
  });

  it("maps tracker rejections to operator-readable reasons", () => {
    expect(writeRejectionReason(400, { error: "Bad field" })).toBe("Bad field");
    expect(writeRejectionReason(401, null)).toBe("AoA is not allowed to change transfers in the tracker.");
    expect(writeRejectionReason(404, null)).toBe("This transfer no longer exists in the tracker.");
    expect(writeRejectionReason(429, null)).toBe("Too many changes at once — wait a minute and try again.");
    expect(writeRejectionReason(500, { error: "internal" })).toBe(ACAT_WRITE_UNAVAILABLE);
    expect(writeRejectionReason(null, null)).toBe(ACAT_WRITE_UNAVAILABLE);
    markCase(SUITE, "rejection-reasons");
  });

  it("builds the refreshed row from the saved record", () => {
    const previous = bookRow({ hasIssue: true });
    const next = bookRowFromSaved(saved({ status: "Accepted", wealthAdvisor: "Alf Brekke", tradeInstructions: "  " }), previous, "2026-10-06T00:00:00.000Z");
    expect(next).toMatchObject({ status: "Accepted", wealthAdvisor: "Alf Brekke", hasIssue: true, tradeInstructionsBlank: true });
    expect(bookRowFromSaved(saved({ tradeInstructions: "Sell all" }), previous, "x")?.tradeInstructionsBlank).toBe(false);
    markCase(SUITE, "saved-row");
  });

  it("keeps the draft on a rejection and resets it on success", () => {
    const row = bookRow();
    const state = { draft: { ...draftFromRow(row), controlNumber: "typed" }, error: null };
    expect(editorAfterResult(state, { ok: false, reason: "nope" })).toEqual({ draft: state.draft, error: "nope" });
    const savedRow = bookRow({ controlNumber: "C-9" });
    expect(editorAfterResult(state, { ok: true, row: savedRow })).toEqual({ draft: draftFromRow(savedRow), error: null });
    markCase(SUITE, "editor-state");
  });
});

describe("saveAcatBookRecord and createAcatBookRecord", () => {
  it("returns edits-off without a tracker call when the flag is off", async () => {
    flags(false);
    expect(await saveAcatBookRecord(bookRow(), { status: "Accepted" })).toEqual({ ok: false, reason: ACAT_EDITS_OFF });
    expect(mocks.write).not.toHaveBeenCalled();
    markCase(SUITE, "save-flag-off");
  });

  it("rejects a VIEWER without a tracker call", async () => {
    mocks.auth.mockResolvedValue(sessionFor("VIEWER"));
    expect(await saveAcatBookRecord(bookRow(), { status: "Accepted" })).toEqual({ ok: false, reason: ACAT_EDIT_FORBIDDEN });
    expect(mocks.write).not.toHaveBeenCalled();
    markCase(SUITE, "save-viewer-forbidden");
  });

  it("rejects a reconciliation status without a tracker call", async () => {
    expect(await saveAcatBookRecord(bookRow(), { ...draftFromRow(bookRow()), status: "Matched" }))
      .toEqual({ ok: false, reason: ACAT_EDIT_NOT_LIFECYCLE });
    expect(mocks.write).not.toHaveBeenCalled();
    markCase(SUITE, "save-not-lifecycle");
  });

  it("returns a tracker 400 reason without refreshing the book", async () => {
    const error = "Apex account number is required for an unlinked record";
    mocks.write.mockResolvedValue({ status: 400, data: { error } });
    expect(await saveAcatBookRecord(bookRow(), { ...draftFromRow(bookRow()), status: "Accepted" })).toEqual({ ok: false, reason: error });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.stale).not.toHaveBeenCalled();
    markCase(SUITE, "save-tracker-400");
  });

  it("PATCHes only the changed key and refreshes the book on 200", async () => {
    mocks.write.mockResolvedValue({ status: 200, data: saved({ status: "Accepted" }) });
    const result = await saveAcatBookRecord(bookRow(), { ...draftFromRow(bookRow()), status: "Accepted" });
    expect(result).toMatchObject({ ok: true, row: { status: "Accepted" } });
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("PATCH", "/api/machine/acats/by-record/rec-1", { status: "Accepted" });
    expect(mocks.stale).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith("/acat-tracking");
    markCase(SUITE, "save-ok");
  });

  it("validates then POSTs a new transfer", async () => {
    const draft = {
      ...emptyCreateDraft(),
      selected: [{ cedarRidgeUserId: "user-11111111-1111-1111-1111-111111111111" }],
      direction: "In", transferWorkflow: "ACAT", apexAccountId: "123", originalClientRequestDate: "2026-07-10",
    };
    const directory = { writeEligible: true, pendingAccountPolicy: "ACCOUNT_REQUIRED", health: "FRESH", enabled: true };
    expect(await createAcatBookRecord(draft, directory)).toEqual({ ok: false, reason: ACAT_DAY_TO_DAY_OFF });
    expect(mocks.write).not.toHaveBeenCalled();
    vi.stubEnv("EPIC_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302", "1");
    vi.stubEnv("SHOW_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302", "1");
    expect(await createAcatBookRecord({ ...draft, apexAccountId: " " }, directory))
      .toEqual({ ok: false, reason: "Still needed: Apex Account #" });
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.write.mockResolvedValue({ status: 201, data: saved({ id: "rec-new", clientName: "A", status: "AcatReceived" }) });
    const result = await createAcatBookRecord(draft, directory);
    expect(result).toMatchObject({ ok: true, row: { id: "rec-new", status: "AcatReceived" } });
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("POST", "/api/machine/acats", expect.objectContaining({
      cedarRidgeUserIds: ["user-11111111-1111-1111-1111-111111111111"], apexAccountId: "123", status: "AcatReceived",
    }));
    markCase(SUITE, "create-ok");
  });

  it("restore returns edits-off without a tracker call when the flag is off", async () => {
    flags(false);
    expect(await restoreAcatBookRecord(bookRow({ removedAt: "2026-09-02T00:00:00.000Z" }))).toEqual({ ok: false, reason: ACAT_EDITS_OFF });
    expect(mocks.write).not.toHaveBeenCalled();
    markCase(SUITE, "restore-flag-off");
  });

  it("restore rejects a VIEWER without a tracker call", async () => {
    mocks.auth.mockResolvedValue(sessionFor("VIEWER"));
    expect(await restoreAcatBookRecord(bookRow())).toEqual({ ok: false, reason: ACAT_EDIT_FORBIDDEN });
    expect(mocks.write).not.toHaveBeenCalled();
    markCase(SUITE, "restore-viewer-forbidden");
  });

  it("restore maps a tracker 409 without refreshing the book", async () => {
    mocks.write.mockResolvedValue({ status: 409, data: { error: "ACAT record is not deleted" } });
    expect(await restoreAcatBookRecord(bookRow())).toEqual({ ok: false, reason: "ACAT record is not deleted" });
    expect(mocks.stale).not.toHaveBeenCalled();
    markCase(SUITE, "restore-409");
  });

  it("restore POSTs the restore route and refreshes the book on 200", async () => {
    mocks.write.mockResolvedValue({ status: 200, data: { success: true } });
    expect(await restoreAcatBookRecord(bookRow())).toEqual({ ok: true });
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("POST", "/api/machine/acats/by-record/rec-1/restore", {});
    expect(mocks.stale).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith("/acat-tracking");
    markCase(SUITE, "restore-ok");
  });
});

describe("book view and link actions", () => {
  it("does not render create, with edits on or off", () => {
    const props = { rows: [bookRow()], linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic" };
    for (const editsEnabled of [false, true]) {
      const html = renderToStaticMarkup(createElement(AcatBookView, { ...props, editsEnabled }));
      expect(html).toContain("Open full tracker");
      expect(html).not.toContain("New transfer");
      expect(html).not.toContain("Create transfer");
    }
    markCase(SUITE, "view-edits-gate");
  });

  it("offers the removed section on request and Restore only with edits on", () => {
    const base = { rows: [bookRow()], linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic" };
    const removed = [bookRow({ id: "rec-gone", clientName: "Removed Client", removedAt: "2026-09-02T00:00:00.000Z" })];
    const hidden = renderToStaticMarkup(createElement(AcatBookView, { ...base, editsEnabled: true }));
    expect(hidden).toContain("Show removed transfers");
    expect(hidden).not.toContain("Removed Client");
    const readOnly = renderToStaticMarkup(createElement(AcatBookView, { ...base, editsEnabled: false, removedRows: removed }));
    expect(readOnly).toContain("Hide removed transfers");
    expect(readOnly).toContain("Removed Client");
    expect(readOnly).toContain("2026-09-02");
    expect(readOnly).not.toContain(">Restore<");
    const editable = renderToStaticMarkup(createElement(AcatBookView, { ...base, editsEnabled: true, removedRows: removed }));
    expect(editable).toContain(">Restore<");
    const empty = renderToStaticMarkup(createElement(AcatBookView, { ...base, editsEnabled: true, removedRows: [] }));
    expect(empty).toContain("No removed transfers.");
    markCase(SUITE, "view-removed-section");
  });

  it("stays in place after an attach when asked to", async () => {
    mocks.scope.mockImplementation(async (_identity: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}));
    mocks.attach.mockResolvedValue({ ok: true });
    expect(await attachAcatToExistingTransfer("tr-1", { recordId: "rec-1", acatTransferId: "ACAT-synthetic" }, { stay: true }))
      .toEqual({ ok: true, transferId: "tr-1" });
    expect(mocks.redirect).not.toHaveBeenCalled();
    markCase(SUITE, "attach-stay");
  });

  it("redirects to the transfer after an attach by default", async () => {
    mocks.scope.mockImplementation(async (_identity: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}));
    mocks.attach.mockResolvedValue({ ok: true });
    await attachAcatToExistingTransfer("tr-1", { recordId: "rec-1", acatTransferId: "ACAT-synthetic" });
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/asset-transfer/tr-1");
    markCase(SUITE, "attach-redirect");
  });
});
