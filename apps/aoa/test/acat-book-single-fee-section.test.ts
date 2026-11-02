// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

// Regression for the doubled Fee Details block. Cause: sibling elements in the open
// drawer shared one React key (`open.id`) - the fee and history sections in the drawer
// panel, the shell and Security Recon in the shell fragment, and the paperwork section
// and client dialog inside the shell. Duplicate sibling keys make React lose track of
// the earlier child on an update, so the old fee section stayed mounted next to the new one.

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
vi.mock("@/components/transfers/AcatStatusCard", () => ({ AcatStatusCard: () => null }));

import { AcatBookView } from "@/components/transfers/AcatBookView";
import type { AcatBookRow } from "@/lib/data/acat-book";
import { mapDrawerTransfer } from "@/lib/data/acat-drawer-contract";

const SUITE = "acat-book-single-fee-section";
const FEE = '[data-testid="transfer-fee-section"]';
const feeSections = () => document.querySelectorAll(FEE).length;

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
  const mapped = mapDrawerTransfer({
    id, identityVersion: 1, clientName: "Alpha Smith", status: "Submitted", direction: "In", type: "Full",
    apexAccountId: "****1111", acatDate: "2026-09-01", assets: [],
  });
  if (!mapped) throw new Error("fixture must map");
  return mapped;
}

const EVERYTHING = { transferDrawer: { admin: false }, feeEnabled: true, historyEnabled: true, securityRecon: true, paperwork: true };

type ViewProps = Partial<Parameters<typeof AcatBookView>[0]>;
const renderBook = (props: ViewProps) => render(createElement(AcatBookView, {
  rows: ROWS, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", editsEnabled: true, ...props,
}));
const openRow = (name: string) => fireEvent.click(screen.getByText(name).closest("tr")!);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });

let errors: string[];

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  mocks.auth.mockResolvedValue({ user: { role: "ADMIN", email: "synthetic@example.test" } });
  mocks.loadDetail.mockResolvedValue({ ok: true, status: null });
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

describe("single fee section in the book drawer", () => {
  it("tkt332 refine fee: one Fee Details section mounts when the fee release is on, with every other drawer section on", async () => {
    renderBook(EVERYTHING);
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    expect(feeSections()).toBe(1);
    expect(screen.getAllByText("Fee Details")).toHaveLength(1);
    markCase(SUITE, "tkt332 refine fee: one Fee Details section mounts when the fee release is on, with every other drawer section on");
  });

  it("tkt332 refine fee: the fee section stays single after the drawer re-renders and after previous and next", async () => {
    renderBook(EVERYTHING);
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Next record" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith("rec-b"));
    await settle();
    expect(feeSections()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Previous record" }));
    await settle();
    expect(feeSections()).toBe(1);
    expect(screen.getAllByRole("region", { name: "Fee section" })).toHaveLength(1);
    markCase(SUITE, "tkt332 refine fee: the fee section stays single after the drawer re-renders and after previous and next");
  });

  it("tkt332 refine fee: no fee section mounts when the fee release is off", async () => {
    renderBook({ ...EVERYTHING, feeEnabled: false });
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    expect(feeSections()).toBe(0);
    markCase(SUITE, "tkt332 refine fee: no fee section mounts when the fee release is off");
  });

  it("tkt332 refine fee: sibling drawer sections never share a React key", async () => {
    renderBook(EVERYTHING);
    openRow("Alpha Smith");
    await screen.findByTestId("acat-transfer-shell");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Next record" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith("rec-b"));
    await settle();
    expect(errors.filter((message) => /two children with the same key/i.test(message))).toEqual([]);
    markCase(SUITE, "tkt332 refine fee: sibling drawer sections never share a React key");
  });
});
