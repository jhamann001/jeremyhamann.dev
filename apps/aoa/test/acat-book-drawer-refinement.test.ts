// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), write: vi.fn(), read: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(),
  refresh: vi.fn(), loadDetail: vi.fn(), load: vi.fn(), history: vi.fn(), fee: vi.fn(), rules: vi.fn(),
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
  loadTransferFee: mocks.fee, saveTransferFeeField: vi.fn(), applyTransferFeeRules: vi.fn(),
  logTransferReimbursement: vi.fn(), loadFeeRules: mocks.rules,
}));
vi.mock("@/components/transfers/TransferPreparationPanel", async () => {
  const { createElement: h } = await import("react");
  return { TransferPreparationPanel: () => h("div", { "data-testid": "preparation-panel" }) };
});
vi.mock("@/components/transfers/AcatLinkPicker", async () => {
  const { createElement: h } = await import("react");
  return { AcatLinkPicker: () => h("div", { "data-testid": "link-picker" }) };
});
// AcatStatusCard is intentionally NOT mocked: the shell-off case renders the real legacy card.



import { AcatBookView } from "@/components/transfers/AcatBookView";
import type { AcatBookRow } from "@/lib/data/acat-book";
import { mapDrawerTransfer } from "@/lib/data/acat-drawer-contract";
import type { AcatStatus } from "@/lib/data/acat-status";

// The migrated drawer no longer renders the old read-only positions block (the legacy
// tracker status card and the "Positions" list mounted below the fee section). It keeps
// the Security Recon "Position Details" grid. The shell-off drawer keeps its fallback.

const SUITE = "acat-book-drawer-refinement";
const LEGACY = /live acat status|from tracker|Loading positions|No positions recorded|ACAT detail unavailable/i;

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

const ROWS = [bookRow({ id: "rec-a", clientName: "Alpha Smith" })];

const DETAIL: AcatStatus = {
  acatTransferId: "rec-a", controlNumber: null, direction: "In", type: "Full transfer", accountType: "Brokerage",
  status: "Submitted", transferringContra: "Schwab", statementAmount: 100000, methodRequested: null, feeCharged: null,
  feeAmount: null, acatDate: "2026-07-10", apexAccountId: "****1111", statementAccountNumber: null, dtccNumber: null,
  assets: [
    { symbol: "VTI", description: "Total market fund", cusip: null, expectedQty: 10, actualQty: 10, mapStatus: null, issue: null, amount: 123456, assetClass: null },
  ],
};

function drawerTransfer(id: string) {
  const mapped = mapDrawerTransfer({
    id, identityVersion: 1, clientName: "Alpha Smith", status: "Submitted", direction: "In", type: "Full",
    apexAccountId: "****1111", acatDate: "2026-09-01", assets: [],
  });
  if (!mapped) throw new Error("fixture must map");
  return mapped;
}

const EVERYTHING = { transferDrawer: { admin: false }, feeEnabled: true, historyEnabled: true, securityRecon: true, paperwork: false };

type ViewProps = Partial<Parameters<typeof AcatBookView>[0]>;
const renderBook = (props: ViewProps) => render(createElement(AcatBookView, {
  rows: ROWS, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", editsEnabled: true, ...props,
}));
const openAlpha = () => fireEvent.click(screen.getByText("Alpha Smith").closest("tr")!);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  mocks.auth.mockResolvedValue({ user: { role: "ADMIN", email: "synthetic@example.test" } });
  mocks.loadDetail.mockResolvedValue({ ok: true, status: DETAIL });
  mocks.load.mockImplementation(async (id: string) => ({ ok: true, transfer: drawerTransfer(id) }));
  mocks.history.mockResolvedValue({ ok: true, entries: [] });
  mocks.fee.mockResolvedValue({ ok: false, code: "transport" });
  mocks.rules.mockResolvedValue({ ok: false, code: "transport" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("book drawer without the old positions block", () => {
  it("tkt332 drop: the migrated drawer renders no old positions block below the fee section and still renders Position Details", async () => {
    renderBook(EVERYTHING);
    openAlpha();
    const dialog = screen.getByRole("dialog", { name: "Transfer drawer" });
    expect(await within(dialog).findByTestId("acat-transfer-shell")).toBeTruthy();
    const toggle = await within(dialog).findByRole("button", { name: "Position Details" });
    await settle();
    // Nothing of the old read-only block: heading, loading or empty copy, positions test ids, or a list titled Positions.
    expect(dialog.textContent ?? "").not.toMatch(LEGACY);
    expect(dialog.querySelector('[aria-label="Live ACAT status"]')).toBeNull();
    expect(within(dialog).queryByTestId("acat-positions-section")).toBeNull();
    expect(within(dialog).queryByRole("region", { name: "Positions" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /^Positions/ })).toBeNull();
    // Below the fee section comes the field history, directly, and nothing else.
    const fee = within(dialog).getByTestId("transfer-fee-section");
    const historyButton = within(dialog).getByRole("button", { name: "History" });
    expect(fee.nextElementSibling?.contains(historyButton)).toBe(true);
    // Position Details is still there, open by default, and still collapsible.
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(dialog).getByRole("button", { name: /Download CSV/ })).toBeTruthy();
    // The rest of the migrated drawer is still mounted.
    expect(within(dialog).getByTestId("preparation-panel")).toBeTruthy();
    expect(within(dialog).getByTestId("link-picker")).toBeTruthy();
    markCase(SUITE, "tkt332 drop: the migrated drawer renders no old positions block below the fee section and still renders Position Details");
  });

  it("tkt332 drop: the migrated drawer makes no read of the legacy tracker detail", async () => {
    renderBook(EVERYTHING);
    openAlpha();
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    expect(mocks.loadDetail).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledWith("rec-a");
    markCase(SUITE, "tkt332 drop: the migrated drawer makes no read of the legacy tracker detail");
  });

  it("tkt332 drop: with the drawer off the legacy status card still renders as the fallback", async () => {
    renderBook({ transferDrawer: null });
    openAlpha();
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(/live acat status/i)).toBeTruthy();
    expect(mocks.loadDetail).toHaveBeenCalledWith("rec-a");
    expect(dialog.getAttribute("aria-label")).toBeNull();
    expect(within(dialog).queryByTestId("acat-transfer-shell")).toBeNull();
    markCase(SUITE, "tkt332 drop: with the drawer off the legacy status card still renders as the fallback");
  });
});
