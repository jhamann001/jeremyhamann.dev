// @vitest-environment jsdom
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

// The Mark Complete dialog's Fee review line must follow the fee the fee section just stored: the section and the
// drawer shell are siblings, so the section reports its stored fee to the book view, which hands it to the shell.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), write: vi.fn(), read: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(),
  refresh: vi.fn(), loadDetail: vi.fn(), load: vi.fn(), history: vi.fn(),
  fee: vi.fn(), save: vi.fn(), apply: vi.fn(), rules: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/data/custodian-library", () => ({
  getCustodianLibrary: mocks.library,
  CustodianLibraryError: class CustodianLibraryError extends Error {},
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/lib/data/acat-status", () => ({ writeAcatBookRecord: mocks.write, readAcatMachine: mocks.read }));
vi.mock("@/lib/data/acat-workspace", () => ({ markAcatBookStale: mocks.stale }));
vi.mock("@/app/(authenticated)/asset-transfer/acat-lane-actions", () => ({ loadUnlinkedAcatDetail: mocks.loadDetail }));
vi.mock("@/app/(authenticated)/acat-tracking/actions", () => ({ unlinkAcatFromExistingTransfer: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/history-actions", () => ({ loadTransferHistory: mocks.history }));
vi.mock("@/app/(authenticated)/acat-tracking/transfer-drawer-actions", () => ({
  loadTransferDrawer: mocks.load,
  changeTransferField: vi.fn(), completeTransfer: vi.fn(), rejectTransfer: vi.fn(), changeTransferStatus: vi.fn(),
  saveTransferText: vi.fn(), deleteTransfer: vi.fn(), replaceTransferClient: vi.fn(), searchTransferClients: vi.fn(),
  listTransferContras: vi.fn(async () => ({ ok: true, contras: [] })),
  loadDtccSuggestion: vi.fn(async () => ({ ok: true, status: "none", dtccNumber: null })),
}));
vi.mock("@/app/(authenticated)/acat-tracking/fee-actions", () => ({
  loadTransferFee: mocks.fee, saveTransferFeeField: mocks.save, applyTransferFeeRules: mocks.apply, loadFeeRules: mocks.rules,
}));
vi.mock("@/components/transfers/TransferPreparationPanel", async () => {
  const { createElement: h } = await import("react");
  return { TransferPreparationPanel: () => h("div", { "data-testid": "preparation-panel" }) };
});
vi.mock("@/components/transfers/AcatLinkPicker", async () => {
  const { createElement: h } = await import("react");
  return { AcatLinkPicker: () => h("div", { "data-testid": "link-picker" }) };
});
vi.mock("@/components/transfers/AcatStatusCard", () => ({ AcatStatusCard: () => null }));

import { AcatBookView } from "@/components/transfers/AcatBookView";
import { AcatTransferDrawerShell } from "@/components/transfers/AcatTransferDrawerShell";
import { TransferFeeSection, type TransferFeeRecord } from "@/components/transfers/TransferFeeSection";
import type { AcatBookRow } from "@/lib/data/acat-book";
import { finalizeFeeLabel, mapDrawerTransfer } from "@/lib/data/acat-drawer-contract";
import { feeSnapshotOf, sameFeeSnapshot, type FeeSnapshot } from "@/lib/data/acat-fee-view";

const SUITE = "acat-fee-review-sync";
const FEE_SECTION = '[data-testid="transfer-fee-section"]';

const EMPTY = {
  feeCharged: null, feeAmount: null, feeMemo: null, feeRequestSubmitted: null, feeRequestCompleted: null,
  feeApexTicket: null, feeCreditRequestId: null,
};
const CHARGED = { ...EMPTY, feeCharged: "Yes", feeAmount: "$50.00" };
const RULES = [{ id: "fee-1", feeType: "ACAT Transfer Fee", accountType: "ANY", transferType: "ANY", direction: "ANY", amount: 75, amountText: null, notes: null }];
const ok = (fee: Record<string, unknown>) => ({ ok: true, fee, log: null });
const bad = (code: string, fee: Record<string, unknown> | null = null) => ({ ok: false, code, fee, log: null });

function bookRow(id: string, over: Partial<AcatBookRow> = {}): AcatBookRow {
  return {
    id, acatTransferId: id, clientName: id === "rec-a" ? "Alpha Smith" : "Bravo Jones", controlNumber: null, direction: "In", type: "Full",
    accountType: "Brokerage", status: "Submitted", transferringContra: "Schwab", statementAmount: 1000, acatDate: "2026-07-10",
    lastActivityAt: "2026-07-10T00:00:00.000Z", apexAccountId: "****1111", statementAccountNumber: null, dtccNumber: null,
    assetMap: { total: null, mapped: null, unmapped: null, pending: null, expected: null },
    wealthAdvisor: null, crmDealId: null, tradeInstructionsBlank: false, notes: null, tradeInstructions: null,
    custodianName: "", textLoadError: null, feeCharged: null, feeRequestCompleted: null, hasIssue: false, removedAt: null,
    records: { needsClientLink: false, cedarRidgeUserIds: "user-11111111-1111-1111-1111-111111111111", reconStatus: "Complete", custodianId: "cust-1" },
    ...over,
  };
}
const ROWS = [bookRow("rec-a"), bookRow("rec-b")];

function drawerTransfer(id: string, fee: { feeCharged?: string; feeAmount?: string } = {}) {
  const mapped = mapDrawerTransfer({
    id, identityVersion: 1, clientName: "Alpha Smith", status: "Submitted", direction: "In", type: "Full",
    apexAccountId: "****1111", acatDate: "2026-09-01", assets: [], ...fee,
  });
  if (!mapped) throw new Error("fixture must map");
  return mapped;
}

const BOOK = { transferDrawer: { admin: false }, feeEnabled: true };
type ViewProps = Partial<Parameters<typeof AcatBookView>[0]>;
const renderBook = (props: ViewProps = {}) => render(createElement(AcatBookView, {
  rows: ROWS, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", editsEnabled: true, ...BOOK, ...props,
}));
const openRow = (name: string) => fireEvent.click(screen.getByText(name).closest("tr")!);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
const feeReady = () => waitFor(() => expect((screen.getByLabelText("Edit Fee Amount") as HTMLButtonElement).disabled).toBe(false));

// A text field saves on Enter; the Fee Charged select saves on blur.
async function editText(label: string, value: string) {
  fireEvent.click(screen.getByLabelText(`Edit ${label}`));
  const input = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
}
async function editSelect(label: string, value: string) {
  fireEvent.click(screen.getByLabelText(`Edit ${label}`));
  const select = screen.getByLabelText(label) as HTMLSelectElement;
  fireEvent.change(select, { target: { value } });
  await act(async () => { fireEvent.blur(select); });
}
const openComplete = () => fireEvent.click(screen.getByRole("button", { name: "Mark Complete" }));
function feeReview(): string {
  const dialog = screen.getByRole("dialog", { name: "Complete transfer" });
  return within(dialog).getByText("Fee review").nextElementSibling?.textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  mocks.auth.mockResolvedValue({ user: { role: "ADMIN", email: "synthetic@example.test" } });
  mocks.loadDetail.mockResolvedValue({ ok: true, status: null });
  mocks.load.mockImplementation(async (id: string) => ({ ok: true, transfer: drawerTransfer(id) }));
  mocks.history.mockResolvedValue({ ok: true, entries: [] });
  mocks.fee.mockResolvedValue(ok(EMPTY));
  mocks.rules.mockResolvedValue({ ok: true, rules: RULES });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fee snapshot helpers and source guard", () => {
  it("tkt353 P1: feeSnapshotOf turns blank values into null and trims the rest", () => {
    expect(feeSnapshotOf({ feeCharged: " ", feeAmount: "" })).toEqual({ feeCharged: null, feeAmount: null });
    expect(feeSnapshotOf({ feeCharged: " Yes ", feeAmount: " $50.00 " })).toEqual({ feeCharged: "Yes", feeAmount: "$50.00" });
    markCase(SUITE, "tkt353 P1: feeSnapshotOf turns blank values into null and trims the rest");
  });

  it("tkt353 P2: sameFeeSnapshot compares the two label inputs and reads a missing snapshot as empty", () => {
    const empty: FeeSnapshot = { feeCharged: null, feeAmount: null };
    const fifty: FeeSnapshot = { feeCharged: "Yes", feeAmount: "$50.00" };
    expect(sameFeeSnapshot(null, empty)).toBe(true);
    expect(sameFeeSnapshot(fifty, { ...fifty })).toBe(true);
    expect(sameFeeSnapshot(fifty, { ...fifty, feeAmount: "$51.00" })).toBe(false);
    expect(sameFeeSnapshot(fifty, { ...fifty, feeCharged: "No" })).toBe(false);
    markCase(SUITE, "tkt353 P2: sameFeeSnapshot compares the two label inputs and reads a missing snapshot as empty");
  });

  it("tkt353 P3: the Fee review label is built from a snapshot", () => {
    expect(finalizeFeeLabel(feeSnapshotOf({ feeCharged: "Yes", feeAmount: "$50.00" }))).toBe("$50.00");
    expect(finalizeFeeLabel(feeSnapshotOf({ feeCharged: "Yes", feeAmount: null }))).toBe("Fee recorded");
    expect(finalizeFeeLabel(feeSnapshotOf({ feeCharged: "No", feeAmount: "$50.00" }))).toBe("No fee");
    expect(finalizeFeeLabel(feeSnapshotOf({ feeCharged: null, feeAmount: "" }))).toBe("Not reviewed");
    markCase(SUITE, "tkt353 P3: the Fee review label is built from a snapshot");
  });

  it("tkt353 P4: the book view's snapshot lines never read the row's activity stamp or the section's reload token", () => {
    const lines = readFileSync("components/transfers/AcatBookView.tsx", "utf8").split("\n");
    const own = lines.filter((line) => /feeSnapshot|reportFee|onFeeChanged/.test(line));
    expect(own.length).toBeGreaterThanOrEqual(4);
    expect(own.filter((line) => /lastActivityAt|refreshToken/.test(line))).toEqual([]);
    markCase(SUITE, "tkt353 P4: the book view's snapshot lines never read the row's activity stamp or the section's reload token");
  });
});

describe("TransferFeeSection reports its stored fee", () => {
  const RECORD: TransferFeeRecord = {
    clientName: "Pat Example", direction: "In", type: "Partial", status: "Submitted", transferringContra: "Fidelity",
    custodianName: "Fidelity Investments", controlNumber: "CTRL-9", apexAccountId: "****1111", custodianId: "cust-1", transferWorkflow: null,
  };
  async function mountSection(first: unknown = ok(CHARGED)) {
    mocks.fee.mockResolvedValue(first);
    const onFeeChanged = vi.fn();
    const view = render(createElement(TransferFeeSection, { recordId: "rec-1", refreshToken: "", record: RECORD, feeRequestsHref: null, onFeeChanged }));
    await feeReady();
    await waitFor(() => expect(screen.queryByText("Loading custodian fee schedule...")).toBeNull());
    return { onFeeChanged, ...view };
  }

  it("tkt353 S1: reports the first load", async () => {
    const { onFeeChanged } = await mountSection();
    expect(onFeeChanged).toHaveBeenCalledTimes(1);
    expect(onFeeChanged).toHaveBeenLastCalledWith({ feeCharged: "Yes", feeAmount: "$50.00" });
    markCase(SUITE, "tkt353 S1: reports the first load");
  });

  it("tkt353 S2: reports after a fee save with the stored value", async () => {
    const { onFeeChanged } = await mountSection();
    mocks.save.mockResolvedValue(ok({ ...CHARGED, feeAmount: "$75.00" }));
    await editText("Fee Amount", "$75.00");
    await waitFor(() => expect(onFeeChanged).toHaveBeenCalledTimes(2));
    expect(onFeeChanged).toHaveBeenLastCalledWith({ feeCharged: "Yes", feeAmount: "$75.00" });
    markCase(SUITE, "tkt353 S2: reports after a fee save with the stored value");
  });

  it("tkt353 S3: reports after Apply Selected", async () => {
    const { onFeeChanged } = await mountSection(ok(EMPTY));
    expect(onFeeChanged).toHaveBeenLastCalledWith({ feeCharged: null, feeAmount: null });
    mocks.apply.mockResolvedValue(ok({ ...EMPTY, feeCharged: "Yes", feeAmount: "$75.00" }));
    fireEvent.click(await screen.findByLabelText("Select ACAT Transfer Fee"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Apply Selected to Record/ })); });
    await waitFor(() => expect(onFeeChanged).toHaveBeenCalledTimes(2));
    expect(mocks.apply).toHaveBeenCalledWith("rec-1", ["fee-1"]);
    expect(onFeeChanged).toHaveBeenLastCalledWith({ feeCharged: "Yes", feeAmount: "$75.00" });
    markCase(SUITE, "tkt353 S3: reports after Apply Selected");
  });

  it("tkt353 S4: a failed save reports the stored fee the answer carries, never the unsent edit", async () => {
    const { onFeeChanged } = await mountSection();
    mocks.save.mockResolvedValue(bad("transport", { ...CHARGED, feeAmount: "$60.00" }));
    await editText("Fee Amount", "$99.00");
    await waitFor(() => expect(onFeeChanged).toHaveBeenCalledTimes(2));
    expect(onFeeChanged).toHaveBeenLastCalledWith({ feeCharged: "Yes", feeAmount: "$60.00" });
    expect(onFeeChanged.mock.calls.flat().some((snapshot) => snapshot.feeAmount === "$99.00")).toBe(false);
    markCase(SUITE, "tkt353 S4: a failed save reports the stored fee the answer carries, never the unsent edit");
  });

  it("tkt353 S7: a failed Apply Selected reports the stored fee the answer carries", async () => {
    const { onFeeChanged } = await mountSection(ok(EMPTY));
    mocks.apply.mockResolvedValue(bad("transport", { ...EMPTY, feeCharged: "Yes", feeAmount: "$60.00" }));
    fireEvent.click(await screen.findByLabelText("Select ACAT Transfer Fee"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Apply Selected to Record/ })); });
    await waitFor(() => expect(onFeeChanged).toHaveBeenCalledTimes(2));
    expect(onFeeChanged).toHaveBeenLastCalledWith({ feeCharged: "Yes", feeAmount: "$60.00" });
    markCase(SUITE, "tkt353 S7: a failed Apply Selected reports the stored fee the answer carries");
  });

  it("tkt353 S5: an answer with the same label inputs reports nothing", async () => {
    const { onFeeChanged } = await mountSection();
    mocks.save.mockResolvedValue(ok({ ...CHARGED, feeMemo: "Changed memo" }));
    await editText("Fee Memo", "Changed memo");
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    await settle();
    expect(onFeeChanged).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt353 S5: an answer with the same label inputs reports nothing");
  });

  it("tkt353 S6: a report triggers no reload of the fee or of the rules", async () => {
    const { onFeeChanged } = await mountSection();
    mocks.save.mockResolvedValue(ok({ ...CHARGED, feeAmount: "$75.00" }));
    await editText("Fee Amount", "$75.00");
    await waitFor(() => expect(onFeeChanged).toHaveBeenCalledTimes(2));
    await settle();
    expect(mocks.fee).toHaveBeenCalledTimes(1);
    expect(mocks.rules).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt353 S6: a report triggers no reload of the fee or of the rules");
  });
});

describe("Mark Complete Fee review in the book drawer", () => {
  async function openAlpha(props: ViewProps = {}) {
    renderBook(props);
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
  }

  it("tkt353 B1: a saved fee shows in Mark Complete without reopening the drawer (WO-AC-1)", async () => {
    await openAlpha();
    await feeReady();
    mocks.save.mockResolvedValueOnce(ok({ ...EMPTY, feeCharged: "Yes" })).mockResolvedValueOnce(ok(CHARGED));
    await editSelect("Fee Charged?", "Yes");
    await editText("Fee Amount", "$50.00");
    await settle();
    openComplete();
    expect(feeReview()).toBe("$50.00");
    markCase(SUITE, "tkt353 B1: a saved fee shows in Mark Complete without reopening the drawer (WO-AC-1)");
  });

  it("tkt353 B2: Apply Selected shows its fee in Mark Complete (WO-AC-2)", async () => {
    await openAlpha();
    await feeReady();
    mocks.apply.mockResolvedValue(ok({ ...EMPTY, feeCharged: "Yes", feeAmount: "$75.00" }));
    fireEvent.click(await screen.findByLabelText("Select ACAT Transfer Fee"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Apply Selected to Record/ })); });
    await settle();
    openComplete();
    expect(feeReview()).toBe("$75.00");
    markCase(SUITE, "tkt353 B2: Apply Selected shows its fee in Mark Complete (WO-AC-2)");
  });

  it("tkt353 B3: the open dialog follows a changed snapshot (WO-AC-3)", async () => {
    const props = {
      row: ROWS[0], admin: false, readOnly: false, position: { index: 0, total: 1 },
      onPrevious: null, onNext: null, onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(),
    };
    const view = render(createElement(AcatTransferDrawerShell, { ...props, feeSnapshot: null }));
    await screen.findByRole("button", { name: "Mark Complete" });
    openComplete();
    expect(feeReview()).toBe("Not reviewed");
    view.rerender(createElement(AcatTransferDrawerShell, { ...props, feeSnapshot: { feeCharged: "Yes", feeAmount: "$12.00" } }));
    expect(feeReview()).toBe("$12.00");
    view.rerender(createElement(AcatTransferDrawerShell, { ...props, feeSnapshot: { feeCharged: "No", feeAmount: "$12.00" } }));
    expect(feeReview()).toBe("No fee");
    markCase(SUITE, "tkt353 B3: the open dialog follows a changed snapshot (WO-AC-3)");
  });

  it("tkt353 B4: a failed save shows the stored fee in the dialog, not the unsent edit (WO-AC-4)", async () => {
    mocks.fee.mockResolvedValue(ok(CHARGED));
    await openAlpha();
    await feeReady();
    mocks.save.mockResolvedValue(bad("transport", CHARGED));
    await editText("Fee Amount", "$99.00");
    await settle();
    openComplete();
    expect(feeReview()).toBe("$50.00");
    markCase(SUITE, "tkt353 B4: a failed save shows the stored fee in the dialog, not the unsent edit (WO-AC-4)");
  });

  it("tkt353 B9: a failed Apply Selected shows the stored fee in the dialog (WO-AC-4)", async () => {
    await openAlpha();
    await feeReady();
    mocks.apply.mockResolvedValue(bad("transport", { ...EMPTY, feeCharged: "Yes", feeAmount: "$60.00" }));
    fireEvent.click(await screen.findByLabelText("Select ACAT Transfer Fee"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Apply Selected to Record/ })); });
    await settle();
    openComplete();
    expect(feeReview()).toBe("$60.00");
    markCase(SUITE, "tkt353 B9: a failed Apply Selected shows the stored fee in the dialog (WO-AC-4)");
  });

  it("tkt353 B5: with the fee release off the dialog uses the drawer's own copy and nothing reads the fee (WO-AC-6)", async () => {
    mocks.load.mockImplementation(async (id: string) => ({ ok: true, transfer: drawerTransfer(id, { feeCharged: "Yes", feeAmount: "$12.00" }) }));
    await openAlpha({ feeEnabled: false });
    expect(document.querySelectorAll(FEE_SECTION)).toHaveLength(0);
    openComplete();
    expect(feeReview()).toBe("$12.00");
    expect(mocks.fee).not.toHaveBeenCalled();
    markCase(SUITE, "tkt353 B5: with the fee release off the dialog uses the drawer's own copy and nothing reads the fee (WO-AC-6)");
  });

  it("tkt353 B6: a fee saved on one transfer never shows in another transfer's dialog (WO-AC-7)", async () => {
    mocks.load.mockImplementation(async (id: string) => ({
      ok: true, transfer: id === "rec-b" ? drawerTransfer(id, { feeCharged: "No" }) : drawerTransfer(id),
    }));
    await openAlpha();
    await feeReady();
    mocks.save.mockResolvedValue(ok(CHARGED));
    await editText("Fee Amount", "$50.00");
    await settle();
    mocks.fee.mockResolvedValue(ok({ ...EMPTY, feeCharged: "No" }));
    fireEvent.click(screen.getByRole("button", { name: "Next record" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith("rec-b"));
    await settle();
    openComplete();
    expect(feeReview()).toBe("No fee");
    markCase(SUITE, "tkt353 B6: a fee saved on one transfer never shows in another transfer's dialog (WO-AC-7)");
  });

  it("tkt353 B7: reopening a transfer starts from the drawer's fresh copy, not the earlier snapshot", async () => {
    await openAlpha();
    await feeReady();
    mocks.save.mockResolvedValue(ok(CHARGED));
    await editText("Fee Amount", "$50.00");
    await settle();
    fireEvent.click(within(screen.getByTestId("acat-transfer-shell")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("acat-transfer-shell")).toBeNull());
    mocks.load.mockImplementation(async (id: string) => ({ ok: true, transfer: drawerTransfer(id, { feeCharged: "Yes", feeAmount: "$9.00" }) }));
    mocks.fee.mockImplementation(() => new Promise(() => {}));
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    openComplete();
    expect(feeReview()).toBe("$9.00");
    markCase(SUITE, "tkt353 B7: reopening a transfer starts from the drawer's fresh copy, not the earlier snapshot");
  });

  it("tkt353 B8: saving fees causes no extra fee or rules reload (WO-AC-5)", async () => {
    await openAlpha();
    await feeReady();
    mocks.save.mockResolvedValueOnce(ok({ ...EMPTY, feeCharged: "Yes" })).mockResolvedValueOnce(ok(CHARGED));
    await editSelect("Fee Charged?", "Yes");
    await editText("Fee Amount", "$50.00");
    await settle();
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.fee).toHaveBeenCalledTimes(1);
    expect(mocks.rules).toHaveBeenCalledTimes(1);
    markCase(SUITE, "tkt353 B8: saving fees causes no extra fee or rules reload (WO-AC-5)");
  });
});
