// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), write: vi.fn(), read: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(),
  refresh: vi.fn(), loadDetail: vi.fn(), loadDrawer: vi.fn(), history: vi.fn(),
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
  loadTransferDrawer: mocks.loadDrawer,
  changeTransferField: vi.fn(),
  completeTransfer: vi.fn(),
  rejectTransfer: vi.fn(),
  changeTransferStatus: vi.fn(),
  saveTransferText: vi.fn(),
  deleteTransfer: vi.fn(),
  replaceTransferClient: vi.fn(),
  searchTransferClients: vi.fn(),
  listTransferContras: vi.fn(),
  loadDtccSuggestion: vi.fn(),
}));
vi.mock("@/app/(authenticated)/acat-tracking/fee-actions", () => ({
  loadTransferFee: vi.fn(), saveTransferFeeField: vi.fn(), applyTransferFeeRules: vi.fn(),
  logTransferReimbursement: vi.fn(), loadFeeRules: vi.fn(),
}));
vi.mock("@/components/transfers/TransferPreparationPanel", async () => {
  const { createElement: h } = await import("react");
  return { TransferPreparationPanel: () => h("div", { "data-testid": "preparation-panel" }) };
});
vi.mock("@/components/transfers/AcatLinkPicker", async () => {
  const { createElement: h } = await import("react");
  return { AcatLinkPicker: () => h("div", { "data-testid": "link-picker" }) };
});
vi.mock("@/components/transfers/AcatStatusCard", async () => {
  const { createElement: h } = await import("react");
  return { AcatStatusCard: () => h("div", { "data-testid": "status-card" }) };
});

import { AcatBookView } from "@/components/transfers/AcatBookView";
import { type AcatBookRow } from "@/lib/data/acat-book";
import { mapDrawerTransfer } from "@/lib/data/acat-drawer-contract";

const SUITE = "acat-book-history-mount";

function bookRow(over: Partial<AcatBookRow> = {}): AcatBookRow {
  const id = over.id ?? "rec-1";
  return {
    acatTransferId: id, clientName: "Client", controlNumber: null, direction: "In", type: "Full", accountType: "Brokerage",
    status: "Submitted", transferringContra: "Schwab", statementAmount: 1000, acatDate: "2026-07-10",
    lastActivityAt: "2026-07-10T00:00:00.000Z", apexAccountId: "****1111", statementAccountNumber: null, dtccNumber: null,
    assetMap: { total: null, mapped: null, unmapped: null, pending: null, expected: null },
    wealthAdvisor: null, crmDealId: null, tradeInstructionsBlank: false, notes: null, tradeInstructions: null,
    custodianName: "", textLoadError: null, feeCharged: null, feeRequestCompleted: null, hasIssue: false, removedAt: null,
    records: { needsClientLink: false, cedarRidgeUserIds: "user-11111111-1111-1111-1111-111111111111", reconStatus: "Complete" },
    ...over,
    id,
  };
}

const ROWS = [
  bookRow({ id: "rec-a", clientName: "Alpha Smith", lastActivityAt: "2026-10-03T00:00:00.000Z" }),
  bookRow({ id: "rec-b", clientName: "Bravo Jones", lastActivityAt: "2026-10-02T00:00:00.000Z" }),
];

function drawerTransfer(id: string) {
  const row = ROWS.find((r) => r.id === id) ?? ROWS[0];
  const mapped = mapDrawerTransfer({
    id, identityVersion: 1, clientName: row.clientName, status: row.status, direction: "In", type: "Full",
    apexAccountId: "****1111", acatDate: "2026-09-01", assets: [],
  });
  if (!mapped) throw new Error("fixture must map");
  return mapped;
}

type ViewProps = Partial<Parameters<typeof AcatBookView>[0]>;
const renderBook = (props: ViewProps = {}) => render(createElement(AcatBookView, {
  rows: ROWS, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic",
  editsEnabled: true, historyEnabled: true, ...props,
}));
const openRow = (name: string) => fireEvent.click(screen.getByText(name).closest("tr")!);
const historyButton = () => screen.queryByRole("button", { name: "History" });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.auth.mockResolvedValue({ user: { role: "ADMIN", email: "synthetic@example.test" } });
  mocks.loadDetail.mockResolvedValue({ ok: true, status: { type: "Full transfer" } });
  mocks.loadDrawer.mockImplementation(async (id: string) => ({ ok: true, transfer: drawerTransfer(id) }));
  mocks.history.mockResolvedValue({ ok: true, entries: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("book history mount (ticket)", () => {
  it("puts a collapsed History section after the shell inside the shell drawer, with no legacy positions block, and makes no call until opened", async () => {
    renderBook({ transferDrawer: { admin: false } });
    openRow("Alpha Smith");
    const dialog = screen.getByRole("dialog", { name: "Transfer drawer" });
    await screen.findByRole("combobox", { name: "Status" });
    const button = within(dialog).getByRole("button", { name: "History" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(within(dialog).queryByText(/Loading positions|No positions recorded/)).toBeNull();
    const shellRoot = within(dialog).getByTestId("acat-transfer-shell");
    expect(shellRoot.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(shellRoot.contains(button)).toBe(false);
    const footer = within(dialog).getByTestId("link-picker");
    expect(button.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mocks.history).not.toHaveBeenCalled();
    markCase(SUITE, "puts a collapsed History section after the shell inside the shell drawer, with no legacy positions block, and makes no call until opened");
  });

  it("opening History in the shell reads that transfer's history once, and the next transfer starts collapsed", async () => {
    mocks.history.mockResolvedValue({ ok: true, entries: [{ id: "h1", action: "update", field: "notes", oldValue: null, newValue: "called", performedBy: null, timestamp: "2026-10-13T14:32:00.000Z" }] });
    renderBook({ transferDrawer: { admin: false } });
    openRow("Alpha Smith");
    await screen.findByRole("combobox", { name: "Status" });
    fireEvent.click(historyButton()!);
    await screen.findByText("Notes changed");
    expect(mocks.history).toHaveBeenCalledTimes(1);
    expect(mocks.history).toHaveBeenCalledWith("rec-a");
    fireEvent.click(screen.getByRole("button", { name: "Next record" }));
    await waitFor(() => expect(mocks.loadDrawer).toHaveBeenCalledWith("rec-b"));
    await screen.findByText("2 of 2");
    expect(historyButton()!.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Notes changed")).toBeNull();
    expect(mocks.history).toHaveBeenCalledTimes(1);
    markCase(SUITE, "opening History in the shell reads that transfer's history once, and the next transfer starts collapsed");
  });

  it("shows History in the read-only shell drawer too, because reading history is not an edit", async () => {
    renderBook({ transferDrawer: { admin: false }, editsEnabled: false });
    openRow("Alpha Smith");
    await screen.findByRole("combobox", { name: "Status" });
    expect((screen.getByRole("combobox", { name: "Status" }) as HTMLSelectElement).disabled).toBe(true);
    expect(historyButton()!.getAttribute("aria-expanded")).toBe("false");
    markCase(SUITE, "shows History in the read-only shell drawer too, because reading history is not an edit");
  });

  it("shows History in the drawer without the shell, editable and read-only", async () => {
    const { unmount } = renderBook();
    openRow("Alpha Smith");
    await screen.findByTestId("status-card");
    expect(historyButton()!.getAttribute("aria-expanded")).toBe("false");
    unmount();
    renderBook({ editsEnabled: false });
    openRow("Alpha Smith");
    await screen.findByTestId("status-card");
    expect(historyButton()!.getAttribute("aria-expanded")).toBe("false");
    expect(mocks.history).not.toHaveBeenCalled();
    markCase(SUITE, "shows History in the drawer without the shell, editable and read-only");
  });

  it("leaves the drawer without a History section and makes no history call while the release is off", async () => {
    const { unmount } = renderBook({ transferDrawer: { admin: false }, historyEnabled: false });
    openRow("Alpha Smith");
    await screen.findByRole("combobox", { name: "Status" });
    expect(historyButton()).toBeNull();
    expect(screen.queryByText("Record change history")).toBeNull();
    unmount();
    renderBook({ historyEnabled: false });
    openRow("Alpha Smith");
    await screen.findByTestId("status-card");
    expect(historyButton()).toBeNull();
    expect(mocks.history).not.toHaveBeenCalled();
    markCase(SUITE, "leaves the drawer without a History section and makes no history call while the release is off");
  });

  it("puts History after the fee section and before the link footer, with no legacy positions block between them, when both releases are on", () => {
    const html = renderToStaticMarkup(createElement(AcatBookView, {
      rows: [bookRow({ id: "rec-a", clientName: "Alpha Smith" })], linkedTransferIds: {}, linkedByRecordId: {}, userName: null,
      prefsScope: "synthetic", editsEnabled: true, feeEnabled: true, historyEnabled: true, initialRecordId: "rec-a",
      transferDrawer: { admin: false },
    }));
    const at = (needle: string) => {
      const index = html.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const order = [at('data-testid="acat-transfer-shell"'), at('data-testid="transfer-fee-section"'), at('aria-expanded="false"'), at('data-testid="link-picker"')];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).not.toContain("Loading positions");
    markCase(SUITE, "puts History after the fee section and before the link footer, with no legacy positions block between them, when both releases are on");
  });
});
