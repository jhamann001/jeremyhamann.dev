// @vitest-environment jsdom
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), write: vi.fn(), read: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(),
  refresh: vi.fn(), loadDetail: vi.fn(), load: vi.fn(), history: vi.fn(),
  fee: vi.fn(), save: vi.fn(), apply: vi.fn(), rules: vi.fn(), requests: vi.fn(),
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
vi.mock("@/app/(authenticated)/acat-tracking/fee-requests-actions", () => ({ loadTransferFeeRequests: mocks.requests }));
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
import type { AcatBookRow } from "@/lib/data/acat-book";
import { mapDrawerTransfer } from "@/lib/data/acat-drawer-contract";

const SUITE = "acat-fee-requests-book";
const CARD = '[data-testid="fee-requests-on-file"]';
const EMPTY = {
  feeCharged: null, feeAmount: null, feeMemo: null, feeRequestSubmitted: null, feeRequestCompleted: null,
  feeApexTicket: null, feeCreditRequestId: null,
};

function bookRow(id: string, over: Partial<AcatBookRow> = {}): AcatBookRow {
  return {
    id, acatTransferId: id, clientName: id === "rec-a" ? "Alpha Smith" : "Bravo Jones", controlNumber: null, direction: "In", type: "Full",
    accountType: "Brokerage", status: "Submitted", transferringContra: "Schwab", statementAmount: 1000, acatDate: "2026-07-10",
    lastActivityAt: "2026-07-10T00:00:00.000Z", apexAccountId: id === "rec-a" ? "****1111" : "****2222", statementAccountNumber: null, dtccNumber: null,
    assetMap: { total: null, mapped: null, unmapped: null, pending: null, expected: null },
    wealthAdvisor: null, crmDealId: null, tradeInstructionsBlank: false, notes: null, tradeInstructions: null,
    custodianName: "", textLoadError: null, feeCharged: null, feeRequestCompleted: null, hasIssue: false, removedAt: null,
    records: { needsClientLink: false, cedarRidgeUserIds: "user-11111111-1111-1111-1111-111111111111", reconStatus: "Complete", cedarRidgeUserId: `user-${id}` },
    ...over,
  };
}
const ROWS = [bookRow("rec-a"), bookRow("rec-b")];

function drawerTransfer(id: string) {
  const mapped = mapDrawerTransfer({
    id, identityVersion: 1, clientName: "Alpha Smith", status: "Submitted", direction: "In", type: "Full",
    apexAccountId: "****1111", acatDate: "2026-09-01", assets: [],
  });
  if (!mapped) throw new Error("fixture must map");
  return mapped;
}

const BOOK = { transferDrawer: { admin: false }, feeEnabled: true, feeRequestsHref: "/operations/fee-requests", feeRequestsRead: true };
type ViewProps = Partial<Parameters<typeof AcatBookView>[0]>;
const renderBook = (props: ViewProps = {}) => render(createElement(AcatBookView, {
  rows: ROWS, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", editsEnabled: true, ...BOOK, ...props,
}));
const openRow = (name: string) => fireEvent.click(screen.getByText(name).closest("tr")!);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  mocks.auth.mockResolvedValue({ user: { role: "ADMIN", email: "synthetic@example.test" } });
  mocks.loadDetail.mockResolvedValue({ ok: true, status: null });
  mocks.load.mockImplementation(async (id: string) => ({ ok: true, transfer: drawerTransfer(id) }));
  mocks.history.mockResolvedValue({ ok: true, entries: [] });
  mocks.fee.mockResolvedValue({ ok: true, fee: EMPTY, log: null });
  mocks.rules.mockResolvedValue({ ok: true, rules: [] });
  mocks.requests.mockResolvedValue({ ok: true, read: { identity: "resolved", clientName: "Alpha Smith", accountLabel: "IRA · ••••1111", requests: [], truncated: false } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("requests on file in the book drawer (ticket)", () => {
  it("reads once when a transfer opens, with that record's id and its own hints, and again for the next transfer", async () => {
    renderBook();
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    expect(document.querySelectorAll(CARD)).toHaveLength(1);
    expect(mocks.requests).toHaveBeenCalledTimes(1);
    expect(mocks.requests).toHaveBeenLastCalledWith("rec-a", { cedarRidgeUserId: "user-rec-a", maskedAccount: "****1111" });
    fireEvent.click(screen.getByRole("button", { name: "Next record" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith("rec-b"));
    await settle();
    expect(document.querySelectorAll(CARD)).toHaveLength(1);
    expect(mocks.requests).toHaveBeenCalledTimes(2);
    expect(mocks.requests).toHaveBeenLastCalledWith("rec-b", { cedarRidgeUserId: "user-rec-b", maskedAccount: "****2222" });
    markCase(SUITE, "reads once when a transfer opens, with that record's id and its own hints, and again for the next transfer");
  });

  it("closing and reopening the same transfer reads exactly once more", async () => {
    renderBook();
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    expect(mocks.requests).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByTestId("acat-transfer-shell")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("acat-transfer-shell")).toBeNull());
    expect(document.querySelectorAll(CARD)).toHaveLength(0);
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    expect(document.querySelectorAll(CARD)).toHaveLength(1);
    expect(mocks.requests).toHaveBeenCalledTimes(2);
    expect(mocks.requests).toHaveBeenLastCalledWith("rec-a", { cedarRidgeUserId: "user-rec-a", maskedAccount: "****1111" });
    markCase(SUITE, "closing and reopening the same transfer reads exactly once more");
  });

  it("makes no read and shows no card when the server did not enable it", async () => {
    renderBook({ feeRequestsRead: false });
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    expect(document.querySelectorAll(CARD)).toHaveLength(0);
    expect(mocks.requests).not.toHaveBeenCalled();
    markCase(SUITE, "makes no read and shows no card when the server did not enable it");
  });

  it("makes no read and shows no fee section at all when the fee release is off", async () => {
    renderBook({ feeEnabled: false });
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    expect(document.querySelectorAll('[data-testid="transfer-fee-section"]')).toHaveLength(0);
    expect(document.querySelectorAll(CARD)).toHaveLength(0);
    expect(mocks.requests).not.toHaveBeenCalled();
    expect(mocks.fee).not.toHaveBeenCalled();
    markCase(SUITE, "makes no read and shows no fee section at all when the fee release is off");
  });

  it("the server component enables the read only for the fee release and passes nothing from the browser", () => {
    const source = readFileSync("components/transfers/AcatBookData.tsx", "utf8");
    expect(source).toContain("feeRequestsRead={feeEnabled && acatFeeRequestsReadEnabled(identity.role)}");
    const view = readFileSync("components/transfers/AcatBookView.tsx", "utf8");
    expect(view).toContain("requestsOnFile={feeRequestsRead}");
    markCase(SUITE, "the server component enables the read only for the fee release and passes nothing from the browser");
  });
});
