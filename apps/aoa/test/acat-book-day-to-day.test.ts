import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), write: vi.fn(), read: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data/custodian-library", () => ({
  getCustodianLibrary: mocks.library,
  CustodianLibraryError: class CustodianLibraryError extends Error {},
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/data/acat-status", () => ({
  writeAcatBookRecord: mocks.write, readAcatMachine: mocks.read,
}));
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: mocks.stale }));
vi.mock("@/app/(authenticated)/asset-transfer/acat-lane-actions", () => ({ loadUnlinkedAcatDetail: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/actions", () => ({ unlinkAcatFromExistingTransfer: vi.fn() }));
vi.mock("@/components/transfers/TransferPreparationPanel", () => ({ TransferPreparationPanel: () => null }));
vi.mock("@/components/transfers/AcatLinkPicker", () => ({ AcatLinkPicker: () => null }));
vi.mock("@/components/transfers/AcatStatusCard", () => ({ AcatStatusCard: () => null }));
vi.mock("@/components/transfers/TransferFeeSection", () => ({
  TransferFeeSection: (props: { recordId: string; feeRequestsHref?: string | null }) =>
    createElement("div", { "data-fee-section": props.recordId, "data-fee-href": props.feeRequestsHref ?? "none" }),
}));

import { AcatRecordEditor, createRequestFor } from "@/components/transfers/AcatBookActions";
import { AcatClientResultRow } from "@/components/transfers/AcatClientSearch";
import { AcatNewTransferDialog, submitCreate } from "@/components/transfers/AcatNewTransferDialog";
import { AcatBookView } from "@/components/transfers/AcatBookView";
import { AcatUnlinkedDrawer } from "@/components/transfers/AcatUnlinkedDrawer";
import {
  ACAT_BOOK_TEXT_LOAD_FAILURE,
  applyAcatBookFilter,
  mapAcatBookRow,
  type AcatBookRow,
} from "@/lib/data/acat-book";
import {
  ACAT_DAY_TO_DAY_OFF,
  ACAT_EDIT_NO_CHANGES,
  ACAT_WRITE_UNAVAILABLE,
  buildDayToDayPatch,
  draftFromRow,
  editorAfterResult,
  keepUnsentText,
} from "@/lib/data/acat-book-edit";
import {
  buildAcatCreateBody,
  canAddClient,
  clientSearchKey,
  confirmClose,
  emptyCreateDraft,
  isStaleSearch,
  NO_ACCOUNT_COPY,
  signedStatementCents,
  suggestDtcc,
  textEditKey,
  type AcatCreateDraft,
  type AcatDirectoryStatus,
} from "@/lib/data/acat-create-contract";
import { acatBookHue } from "@/lib/data/acat-status-catalog";
import { epicAcatBookDayToDayActionsEnabled } from "@/lib/flags";
import { createAcatBookRecord, saveAcatBookRecord } from "@/app/(authenticated)/acat-tracking/book-actions";

const SUITE = "acat-book-day-to-day";
const SELECTED = "user-11111111-1111-1111-1111-111111111111";
const EPIC = "EPIC_ACAT_OPS_WORKSPACE_TKT290";
const BOOK = "SHOW_ACAT_OPS_BOOK_TKT293";
const EDITS = "ALLOW_ACAT_OPS_EDITS_TKT294";
const DAY_EPIC = "EPIC_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302";
const DAY_SHOW = "SHOW_ACAT_BOOK_DAY_TO_DAY_ACTIONS_TKT302";
const DIRECTORY: AcatDirectoryStatus = { writeEligible: true, pendingAccountPolicy: "ACCOUNT_REQUIRED", health: "FRESH", enabled: true };

function completeDraft(over: Partial<AcatCreateDraft> = {}): AcatCreateDraft {
  return {
    ...emptyCreateDraft(),
    selected: [{ cedarRidgeUserId: SELECTED }],
    direction: "In",
    transferWorkflow: "ACAT",
    apexAccountId: "Fzmgab45nX2",
    status: "AcatReceived",
    originalClientRequestDate: "2026-07-10",
    ...over,
  };
}

function bookRow(over: Partial<AcatBookRow> = {}): AcatBookRow {
  const id = over.id ?? "rec-1";
  return {
    acatTransferId: id,
    clientName: "Client",
    controlNumber: null,
    direction: "In",
    type: "Full",
    accountType: "Brokerage",
    status: "Submitted",
    transferringContra: "Schwab",
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
    id,
  };
}

function editsOn() {
  vi.stubEnv(EPIC, "1");
  vi.stubEnv(BOOK, "1");
  vi.stubEnv(EDITS, "1");
}

function dayToDayOn() {
  editsOn();
  vi.stubEnv(DAY_EPIC, "1");
  vi.stubEnv(DAY_SHOW, "1");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { role: "OPERATIONS", email: "synthetic@example.test" } });
  dayToDayOn();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("day-to-day book actions", () => {
  it("day-to-day flags are on only when both new flags are exactly 1", () => {
    vi.stubEnv(DAY_EPIC, "1");
    vi.stubEnv(DAY_SHOW, "1");
    expect(epicAcatBookDayToDayActionsEnabled()).toBe(true);
    markCase(SUITE, "flags-on");
  });

  it("day-to-day flags are off unless both variables are exactly 1", () => {
    for (const value of [undefined, "", "0", "true"]) {
      vi.unstubAllEnvs();
      vi.stubEnv(DAY_SHOW, "1");
      if (value !== undefined) vi.stubEnv(DAY_EPIC, value);
      expect(epicAcatBookDayToDayActionsEnabled(), `epic=${String(value)}`).toBe(false);
      vi.unstubAllEnvs();
      vi.stubEnv(DAY_EPIC, "1");
      if (value !== undefined) vi.stubEnv(DAY_SHOW, value);
      expect(epicAcatBookDayToDayActionsEnabled(), `show=${String(value)}`).toBe(false);
    }
    markCase(SUITE, "flags-off");
  });

  it("custodian search contains the custodian name only when enabled", () => {
    const row = bookRow({ id: "fid", custodianName: "Fidelity", transferringContra: "Schwab" });
    expect(applyAcatBookFilter([row], "all", "fid", null, true).map((r) => r.id)).toEqual(["fid"]);
    expect(applyAcatBookFilter([row], "all", "fid", null)).toEqual([]);
    markCase(SUITE, "custodian-contains");
  });

  it("book row keeps call the client, sell winners, and Fidelity", () => {
    expect(mapAcatBookRow({
      id: "r", notes: "call the client", tradeInstructions: "sell winners", custodianName: "Fidelity",
    })).toMatchObject({
      notes: "call the client", tradeInstructions: "sell winners", custodianName: "Fidelity", textLoadError: null,
    });
    markCase(SUITE, "book-text");
  });

  it("a book row missing notes reports the load failure", () => {
    expect(mapAcatBookRow({ id: "r" })?.textLoadError).toBe(ACAT_BOOK_TEXT_LOAD_FAILURE);
    markCase(SUITE, "text-load-failure");
  });

  it("selected-client create accepts user-11111111-1111-1111-1111-111111111111", async () => {
    mocks.write.mockResolvedValue({ status: 201, data: { id: "rec-new", clientName: "Abigayle", status: "AcatReceived", notes: null, tradeInstructions: null } });
    const draft = completeDraft();
    const result = await createAcatBookRecord(draft, DIRECTORY);
    expect(result.ok).toBe(true);
    const built = buildAcatCreateBody(draft, DIRECTORY);
    expect(built.ok).toBe(true);
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith("POST", "/api/machine/acats", built.ok ? built.body : null);
    const body = mocks.write.mock.calls[0][2] as Record<string, unknown>;
    expect(body).toEqual({
      cedarRidgeUserIds: [SELECTED], direction: "In", apexAccountId: "Fzmgab45nX2", status: "AcatReceived",
      transferWorkflow: "ACAT", residualMonitoringRequired: false, crmDealId: "",
      originalClientRequestDate: "2026-07-10", acatDate: "2026-07-10",
    });
    expect(body).not.toHaveProperty("cedarRidgeUserId");
    expect(body).not.toHaveProperty("statementAmount");
    markCase(SUITE, "create-selected");
  });

  it("create without a selected client returns Search for and select a Cedar Ridge client", async () => {
    const noDirectory = await createAcatBookRecord(emptyCreateDraft(), null);
    expect(noDirectory.ok).toBe(false);
    expect(noDirectory.ok ? "" : noDirectory.reason).toContain("Client directory status");
    expect(mocks.write).not.toHaveBeenCalled();
    const noClient = await createAcatBookRecord({ ...emptyCreateDraft(), selected: [] }, DIRECTORY);
    expect(noClient.ok ? "" : noClient.reason).toContain("Client selection");
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.write.mockResolvedValue({ status: 400, data: { error: "Apex account number is required" } });
    expect(await createAcatBookRecord(completeDraft(), DIRECTORY))
      .toEqual({ ok: false, reason: "Apex account number is required" });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    markCase(SUITE, "create-rejected");
  });

  it("a rejected notes save keeps the unsent text", async () => {
    const row = bookRow();
    expect(buildDayToDayPatch(row, { notes: "call the client" })).toEqual({ patch: { notes: "call the client" }, changed: 1 });
    const draft = { ...draftFromRow(row), notes: "call the client" };
    expect(editorAfterResult(
      { draft: draftFromRow(row), error: null },
      { ok: false, reason: ACAT_WRITE_UNAVAILABLE },
    )).toEqual({ draft: draftFromRow(row), error: ACAT_WRITE_UNAVAILABLE });
    mocks.write.mockResolvedValue({ status: 400, data: { error: ACAT_WRITE_UNAVAILABLE } });
    expect(await saveAcatBookRecord(row, draft)).toEqual({ ok: false, reason: ACAT_WRITE_UNAVAILABLE });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    editsOn();
    mocks.write.mockClear();
    expect(await saveAcatBookRecord(row, draft)).toEqual({ ok: false, reason: ACAT_EDIT_NO_CHANGES });
    expect(mocks.write).not.toHaveBeenCalled();
    markCase(SUITE, "save-rejected");
  });

  it("flag off book does not show the new controls and still has Unlink transfer", () => {
    const props = { rows: [bookRow()], linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic" };
    const html = renderToStaticMarkup(createElement(AcatBookView, props));
    expect(html).not.toContain("New transfer");
    expect(html).not.toContain("Search for a Cedar Ridge client");
    const editor = renderToStaticMarkup(createElement(AcatRecordEditor, { row: bookRow(), onSaved: () => undefined, dayToDay: false }));
    expect(editor).not.toContain("Trade instructions");
    const drawer = renderToStaticMarkup(createElement(AcatUnlinkedDrawer, {
      row: bookRow(), transferId: "transfer-1", readOnly: false, onClose: () => undefined, onUnlinked: () => undefined,
    }));
    expect(drawer).toContain("Unlink transfer");
    markCase(SUITE, "flag-off-markup");
  });

  it("flag on book shows notes, trade instructions, and client search", () => {
    const props = { rows: [bookRow({ notes: "call the client" })], linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", dayToDayEnabled: true };
    expect(renderToStaticMarkup(createElement(AcatBookView, props))).toContain("New transfer");
    const editor = renderToStaticMarkup(createElement(AcatRecordEditor, {
      row: bookRow({ notes: "call the client" }), onSaved: () => undefined, dayToDay: true,
    }));
    expect(editor).toContain("call the client");
    expect(editor).toContain("Edit trade instructions");
    const failed = renderToStaticMarkup(createElement(AcatRecordEditor, {
      row: bookRow({ textLoadError: ACAT_BOOK_TEXT_LOAD_FAILURE }), onSaved: () => undefined, dayToDay: true,
    }));
    expect(failed).toContain("Notes and trade instructions could not be loaded.");
    expect(failed).not.toContain("<textarea");
    markCase(SUITE, "flag-on-markup");
  });

  it("create form without a selected client shows the reason instead of a disabled button", () => {
    expect(createRequestFor(null, "Fzmgab45nX2")).toEqual({ ok: false, reason: "Search for and select a Cedar Ridge client" });
    expect(createRequestFor({ cedarRidgeUserId: "user-11111111-1111-1111-1111-111111111111" }, "Fzmgab45nX2")).toEqual({
      ok: true, body: { cedarRidgeUserId: "user-11111111-1111-1111-1111-111111111111", apexAccountId: "Fzmgab45nX2" },
    });
    markCase(SUITE, "create-no-client-reason");
  });

  it("forwards the full tracker create body", async () => {
    const id = "user-11111111-1111-1111-1111-111111111111";
    const draft = completeDraft({
      selected: [{ cedarRidgeUserId: id }], apexAccountId: "IOP812", statementAmount: "50.00", notes: "hold",
    });
    const built = buildAcatCreateBody(draft, DIRECTORY);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.cedarRidgeUserIds).toEqual([id]);
    expect(built.body.statementAmount).toBe(5000);
    expect(built.body.transferWorkflow).toBe("ACAT");
    expect(built.body.acatDate).toBe("2026-07-10");
    expect(built.body).not.toHaveProperty("cedarRidgeUserId");
    expect(signedStatementCents(5000, "Out")).toBe(-5000);
    expect(signedStatementCents(5000, "In")).toBe(5000);
    mocks.write.mockResolvedValue({ status: 201, data: { id: "rec-new", status: "AcatReceived", notes: "hold", tradeInstructions: null } });
    const result = await createAcatBookRecord(draft, DIRECTORY);
    expect(result.ok).toBe(true);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const [method, path, posted] = mocks.write.mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe("/api/machine/acats");
    expect(posted).toMatchObject({ cedarRidgeUserIds: [id], statementAmount: 5000 });
    markCase(SUITE, "create-full-body");
  });

  it("create returns the day-to-day off reason without writing when the show flag is off", async () => {
    vi.stubEnv(DAY_SHOW, "0");
    expect(await createAcatBookRecord(completeDraft(), DIRECTORY)).toEqual({ ok: false, reason: ACAT_DAY_TO_DAY_OFF });
    expect(mocks.write).not.toHaveBeenCalled();
    markCase(SUITE, "create-flag-off");
  });

  it("show flag off hides the dialog", () => {
    const props = { rows: [bookRow()], linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", startCreating: true };
    const html = renderToStaticMarkup(createElement(AcatBookView, props));
    expect(html).not.toContain("New Transfer Record");
    expect(html).not.toContain("New transfer");
    markCase(SUITE, "dialog-flag-off");
  });

  it("show flag on opens the New Transfer Record dialog", () => {
    const props = { rows: [bookRow()], linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", startCreating: true, dayToDayEnabled: true };
    expect(renderToStaticMarkup(createElement(AcatBookView, props))).toContain("New Transfer Record");
    markCase(SUITE, "dialog-flag-on");
  });

  it("an empty dialog has Cancel and a disabled Create Transfer", () => {
    const html = renderToStaticMarkup(createElement(AcatNewTransferDialog, {
      onClose: () => undefined, onCreated: () => undefined, initialDraft: emptyCreateDraft(), initialDirectory: DIRECTORY,
    }));
    expect(html).toContain("New Transfer Record");
    expect(html).toContain("Cancel");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Create Transfer<\/button>/);
    expect(html).toContain("Still needed: Client selection, Direction, Transfer Workflow, Apex Account #");
    markCase(SUITE, "dialog-empty");
  });

  it("stale searches are ignored and keys move, select, and close", () => {
    expect(isStaleSearch(1, 2)).toBe(true);
    expect(isStaleSearch(2, 2)).toBe(false);
    expect(clientSearchKey("ArrowDown", -1, 2).highlight).toBe(0);
    expect(clientSearchKey("ArrowDown", 1, 2).highlight).toBe(1);
    expect(clientSearchKey("ArrowUp", 0, 2).highlight).toBe(0);
    expect(clientSearchKey("Enter", 0, 2).select).toBe(true);
    expect(clientSearchKey("Enter", -1, 2).select).toBe(false);
    expect(clientSearchKey("Escape", 0, 2)).toEqual({ highlight: 0, close: true, select: false });
    markCase(SUITE, "search-keys");
  });

  it("a search result shows every account hint or the no-account copy", () => {
    const two = renderToStaticMarkup(createElement(AcatClientResultRow, { client: {
      cedarRidgeUserId: SELECTED, displayName: "Synthetic Client",
      accountHints: [
        { custodian: "Apex", maskedAccountNumber: "••••1111", relationshipType: "PRIMARY" },
        { custodian: "Apex", maskedAccountNumber: "••••2222", relationshipType: "JOINT" },
      ],
    } }));
    expect(two).toContain("••••1111");
    expect(two).toContain("••••2222");
    expect(two).toContain("ID ending 11111111");
    const none = renderToStaticMarkup(createElement(AcatClientResultRow, { client: {
      cedarRidgeUserId: SELECTED, displayName: "Synthetic Client", accountHints: [],
    } }));
    expect(none).toContain(NO_ACCOUNT_COPY);
    markCase(SUITE, "search-hints");
  });

  it("client search returns hints, hasMore, and directory status", async () => {
    mocks.read.mockResolvedValue({ status: 200, data: {
      items: [
        { cedarRidgeUserId: SELECTED, displayName: "Synthetic Client", accountHints: [{ custodian: "Apex", maskedAccountNumber: "••••1111", relationshipType: "PRIMARY" }] },
        { cedarRidgeUserId: "not-a-user", displayName: "Dropped" },
      ],
      hasMore: true,
      directory: DIRECTORY,
    } });
    const { searchAcatBookClients } = await import("@/app/(authenticated)/acat-tracking/book-actions");
    const result = await searchAcatBookClients("sy");
    expect(mocks.read).toHaveBeenCalledWith("/api/machine/clients/search?query=sy&limit=20");
    expect(result).toEqual({
      ok: true, hasMore: true, directory: DIRECTORY,
      clients: [{ cedarRidgeUserId: SELECTED, displayName: "Synthetic Client", accountHints: [{ custodian: "Apex", maskedAccountNumber: "••••1111", relationshipType: "PRIMARY" }] }],
    });
    markCase(SUITE, "search-payload");
  });

  it("contra list maps DTC numbers and a single match fills DTCC", async () => {
    mocks.library.mockResolvedValue({ custodians: [{ name: "Schwab", dtcNumber: "164" }, { name: "Fidelity", dtcNumber: null }] });
    const { listAcatContras } = await import("@/app/(authenticated)/acat-tracking/book-actions");
    const result = await listAcatContras();
    expect(result).toEqual({ ok: true, contras: [{ name: "Schwab", dtcNumber: "164" }, { name: "Fidelity", dtcNumber: null }] });
    if (!result.ok) return;
    expect(suggestDtcc(result.contras, " schwab ", false)).toBe("0164");
    expect(suggestDtcc(result.contras, "Schwab", true)).toBeNull();
    expect(suggestDtcc(result.contras, "Fidelity", false)).toBeNull();
    markCase(SUITE, "contra-dtcc");
  });

  it("the ten-client cap stops adding at ten", () => {
    expect(canAddClient(9)).toBe(true);
    expect(canAddClient(10)).toBe(false);
    markCase(SUITE, "client-cap");
  });

  it("a rejected Apex create keeps the dialog reason and does not call onCreated", async () => {
    mocks.write.mockResolvedValue({ status: 400, data: { error: "Apex account ID is not a known account" } });
    const onCreated = vi.fn();
    const reason = await submitCreate(completeDraft(), DIRECTORY, createAcatBookRecord, onCreated);
    expect(reason).toBe("Apex account ID is not a known account");
    expect(onCreated).not.toHaveBeenCalled();
    mocks.write.mockClear();
    expect(await submitCreate(completeDraft({ statementAmount: "fifty" }), DIRECTORY, createAcatBookRecord, onCreated))
      .toBe("Invalid Statement Amount");
    expect(mocks.write).not.toHaveBeenCalled();
    markCase(SUITE, "create-apex-rejected");
  });

  it("a rejected click-to-edit save keeps the buffer", async () => {
    const row = bookRow({ notes: "call the client" });
    mocks.write.mockResolvedValue({ status: 400, data: { error: ACAT_WRITE_UNAVAILABLE } });
    const result = await saveAcatBookRecord(row, { ...draftFromRow(row), notes: "call the client tomorrow" });
    expect(result.ok).toBe(false);
    expect(keepUnsentText("call the client", "call the client tomorrow", result.ok)).toBe("call the client tomorrow");
    expect(keepUnsentText("call the client", "call the client tomorrow", true)).toBe("call the client");
    markCase(SUITE, "text-save-rejected");
  });

  it("saving one text field never clears the other", () => {
    const row = bookRow({ notes: "call the client", tradeInstructions: "sell winners" });
    const notes = buildDayToDayPatch(row, { notes: "call the client tomorrow" });
    expect(notes).toEqual({ patch: { notes: "call the client tomorrow" }, changed: 1 });
    expect(notes.patch).not.toHaveProperty("tradeInstructions");
    const trade = buildDayToDayPatch(row, { tradeInstructions: "hold winners" });
    expect(trade).toEqual({ patch: { tradeInstructions: "hold winners" }, changed: 1 });
    expect(trade.patch).not.toHaveProperty("notes");
    expect(buildDayToDayPatch(row, {})).toEqual({ patch: {}, changed: 0 });
    expect(buildDayToDayPatch(row, { notes: "" })).toEqual({ patch: { notes: null }, changed: 1 });
    markCase(SUITE, "text-patch-isolation");
  });

  it("dirty close stays, Enter in a textarea is a newline, and Escape cancels", () => {
    expect(confirmClose(true, false)).toBe("stay");
    expect(confirmClose(true, true)).toBe("close");
    expect(confirmClose(false, false)).toBe("close");
    expect(textEditKey("Enter", true)).toBe("newline");
    expect(textEditKey("Enter", false)).toBe("commit");
    expect(textEditKey("Escape", true)).toBe("cancel");
    markCase(SUITE, "dialog-keys");
  });

  it("custodian filter still matches and status hues stay green and red", () => {
    const row = bookRow({ id: "fid", custodianName: "Fidelity" });
    expect(applyAcatBookFilter([row], "all", "fidel", null, true).map((r) => r.id)).toEqual(["fid"]);
    expect(acatBookHue("Completed")).toBe("green");
    expect(acatBookHue("Rejected")).toBe("red");
    markCase(SUITE, "filter-and-hues");
  });

  it("opens the requested existing record and ignores an unknown record", () => {
    const rows = [bookRow({ id: "rec-known", clientName: "Known Record Client" })];
    const props = { rows, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic" };
    const known = renderToStaticMarkup(createElement(AcatBookView, { ...props, initialRecordId: "rec-known" }));
    expect(known).toContain('role="dialog"');
    expect(known).toContain("Known Record Client");
    const unknown = renderToStaticMarkup(createElement(AcatBookView, { ...props, initialRecordId: "missing-record" }));
    expect(unknown).not.toContain('role="dialog"');
    expect(unknown).toContain("Known Record Client");
    markCase(SUITE, "opens the requested existing record and ignores an unknown record");
  });

  it("book drawer shows the fee section while the fee release is on", () => {
    const rows = [bookRow({ id: "rec-fee", clientName: "Fee Client" })];
    const props = { rows, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", editsEnabled: true, initialRecordId: "rec-fee" };
    const on = renderToStaticMarkup(createElement(AcatBookView, { ...props, feeEnabled: true }));
    expect(on).toContain('role="dialog"');
    expect(on).toContain('data-fee-section="rec-fee"');
    markCase(SUITE, "book drawer shows the fee section while the fee release is on");
  });

  it("tkt349: book drawer hands the fee section the Operations Tools link it was given, or none", () => {
    const rows = [bookRow({ id: "rec-fee", clientName: "Fee Client" })];
    const props = { rows, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", editsEnabled: true, initialRecordId: "rec-fee", feeEnabled: true };
    const linked = renderToStaticMarkup(createElement(AcatBookView, { ...props, feeRequestsHref: "/operations/fee-requests" }));
    expect(linked).toContain('data-fee-href="/operations/fee-requests"');
    expect(renderToStaticMarkup(createElement(AcatBookView, props))).toContain('data-fee-href="none"');
    expect(renderToStaticMarkup(createElement(AcatBookView, { ...props, feeRequestsHref: null }))).toContain('data-fee-href="none"');
    markCase(SUITE, "tkt349: book drawer hands the fee section the Operations Tools link it was given, or none");
  });

  it("book drawer has no fee section while the fee release is off", () => {
    const rows = [bookRow({ id: "rec-fee", clientName: "Fee Client" })];
    const props = { rows, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", editsEnabled: true, initialRecordId: "rec-fee" };
    const off = renderToStaticMarkup(createElement(AcatBookView, { ...props, feeEnabled: false }));
    expect(off).toContain('role="dialog"');
    expect(off).not.toContain("data-fee-section");
    const unset = renderToStaticMarkup(createElement(AcatBookView, props));
    expect(unset).not.toContain("data-fee-section");
    // A read-only drawer never shows the section, even with the release on.
    const readOnly = renderToStaticMarkup(createElement(AcatBookView, { ...props, editsEnabled: false, feeEnabled: true }));
    expect(readOnly).toContain('role="dialog"');
    expect(readOnly).not.toContain("data-fee-section");
    markCase(SUITE, "book drawer has no fee section while the fee release is off");
  });

  it("book drawer mounts the fee section after the transfer drawer shell and drops the old editor", () => {
    const rows = [bookRow({ id: "rec-fee", clientName: "Fee Client" })];
    const html = renderToStaticMarkup(createElement(AcatBookView, {
      rows, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic",
      editsEnabled: true, feeEnabled: true, initialRecordId: "rec-fee", transferDrawer: { admin: false },
    }));
    const shell = html.indexOf('data-testid="acat-transfer-shell"');
    const fee = html.indexOf('data-fee-section="rec-fee"');
    expect(shell).toBeGreaterThan(-1);
    expect(fee).toBeGreaterThan(shell);
    expect(html).not.toContain('aria-label="Edit transfer"');
    markCase(SUITE, "book drawer mounts the fee section after the transfer drawer shell and drops the old editor");
  });
});
