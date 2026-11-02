// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/app/(authenticated)/acat-tracking/book-actions", () => ({
  saveAcatBookRecord: mocks.save,
  createAcatBookRecord: vi.fn(),
  searchAcatBookClients: vi.fn(),
  listAcatContras: vi.fn(),
  restoreAcatBookRecord: vi.fn(),
}));
vi.mock("@/app/(authenticated)/acat-tracking/fee-actions", () => ({
  loadTransferFee: vi.fn(), saveTransferFeeField: vi.fn(), applyTransferFeeRules: vi.fn(),
  logTransferReimbursement: vi.fn(), loadFeeRules: vi.fn(),
}));
vi.mock("@/app/(authenticated)/acat-tracking/transfer-drawer-actions", () => ({}));
vi.mock("@/app/(authenticated)/acat-tracking/history-actions", () => ({ loadTransferHistory: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), redirect: vi.fn() }));
vi.mock("@/app/(authenticated)/asset-transfer/acat-lane-actions", () => ({
  loadUnlinkedAcatDetail: vi.fn(async () => ({ ok: true, status: null })),
}));
vi.mock("@/app/(authenticated)/acat-tracking/actions", () => ({ unlinkAcatFromExistingTransfer: vi.fn() }));
vi.mock("@/components/transfers/TransferPreparationPanel", () => ({ TransferPreparationPanel: () => null }));
vi.mock("@/components/transfers/AcatLinkPicker", () => ({ AcatLinkPicker: () => null }));
vi.mock("@/components/transfers/AcatStatusCard", () => ({ AcatStatusCard: () => null }));

import { AcatBookView } from "@/components/transfers/AcatBookView";
import { buildAcatPatch } from "@/lib/data/acat-book-edit";
import type { AcatBookRow } from "@/lib/data/acat-book";

const SUITE = "acat-book-fee-editor";

function bookRow(over: Partial<AcatBookRow> = {}): AcatBookRow {
  return {
    id: "rec-1", acatTransferId: "ACAT-1", clientName: "Pat Example", controlNumber: "CTRL-1", direction: "In", type: "Full",
    accountType: "Brokerage", status: "Submitted", transferringContra: "Schwab", statementAmount: 1000, acatDate: "2026-07-10",
    lastActivityAt: "2026-07-10T00:00:00.000Z", apexAccountId: "****1111", statementAccountNumber: null, dtccNumber: null,
    assetMap: { total: null, mapped: null, unmapped: null, pending: null, expected: null },
    wealthAdvisor: null, crmDealId: null, tradeInstructionsBlank: false, notes: "Original notes", tradeInstructions: null,
    custodianName: "Schwab", textLoadError: null, feeCharged: null, feeRequestCompleted: null, hasIssue: false, removedAt: null,
    ...over,
  };
}

function view(row: AcatBookRow) {
  return createElement(AcatBookView, {
    rows: [row], linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic",
    editsEnabled: true, feeEnabled: false, dayToDayEnabled: true, initialRecordId: row.id,
  });
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe("book drawer editor and the stored fee values", () => {
  it("rebuilds the editor draft when the stored fee values change", async () => {
    const { rerender } = render(view(bookRow()));
    expect((screen.getByLabelText("Fee charged") as HTMLInputElement).value).toBe("");
    await act(async () => { rerender(view(bookRow({ feeCharged: "Yes" }))); });
    expect((screen.getByLabelText("Fee charged") as HTMLInputElement).value).toBe("Yes");
    await act(async () => { rerender(view(bookRow({ feeCharged: "Yes", feeRequestCompleted: "2026-10-12" }))); });
    expect((screen.getByLabelText("Fee request completed") as HTMLInputElement).value).toBe("2026-10-12");
    markCase(SUITE, "rebuilds the editor draft when the stored fee values change");
  });

  it("an editor save after a fee save sends no stale feeCharged", async () => {
    mocks.save.mockResolvedValue({ ok: false, reason: "x" });
    const { rerender } = render(view(bookRow()));
    await act(async () => { rerender(view(bookRow({ feeCharged: "Yes" }))); });
    fireEvent.change(screen.getByLabelText("Control #"), { target: { value: "CTRL-2" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const [sentRow, sentDraft] = mocks.save.mock.calls[0];
    const { patch } = buildAcatPatch(sentRow, sentDraft);
    expect(patch).toEqual({ controlNumber: "CTRL-2" });
    expect("feeCharged" in patch).toBe(false);
    markCase(SUITE, "an editor save after a fee save sends no stale feeCharged");
  });

  it("an editor remount after a fee save discards an unsent notes edit", async () => {
    const { rerender } = render(view(bookRow()));
    fireEvent.click(screen.getByLabelText("Edit notes"));
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "half-typed note" } });
    expect(screen.queryByLabelText("Notes")).not.toBeNull();
    await act(async () => { rerender(view(bookRow({ feeCharged: "Yes" }))); });
    expect(screen.queryByLabelText("Notes")).toBeNull();
    expect(screen.getByLabelText("Edit notes")).toBeTruthy();
    markCase(SUITE, "an editor remount after a fee save discards an unsent notes edit");
  });
});
