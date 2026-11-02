// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), write: vi.fn(), read: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(),
  refresh: vi.fn(), loadDetail: vi.fn(),
  load: vi.fn(), change: vi.fn(), complete: vi.fn(), reject: vi.fn(), status: vi.fn(), text: vi.fn(),
  remove: vi.fn(), replace: vi.fn(), search: vi.fn(), contras: vi.fn(), suggestion: vi.fn(),
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
vi.mock("@/app/(authenticated)/acat-tracking/transfer-drawer-actions", () => ({
  loadTransferDrawer: mocks.load,
  changeTransferField: mocks.change,
  completeTransfer: mocks.complete,
  rejectTransfer: mocks.reject,
  changeTransferStatus: mocks.status,
  saveTransferText: mocks.text,
  deleteTransfer: mocks.remove,
  replaceTransferClient: mocks.replace,
  searchTransferClients: mocks.search,
  listTransferContras: mocks.contras,
  loadDtccSuggestion: mocks.suggestion,
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
import { ACAT_BOOK_COLUMNS, type AcatBookRow } from "@/lib/data/acat-book";
import { ACAT_EXPORT_FAILURE, mapDrawerTransfer } from "@/lib/data/acat-drawer-contract";

const SUITE = "acat-book-transfer-drawer";
const BOOK_EPIC = "EPIC_ACAT_OPS_WORKSPACE_TKT290";
const BOOK_SHOW = "SHOW_ACAT_OPS_BOOK_TKT293";
const EDITS = "ALLOW_ACAT_OPS_EDITS_TKT294";
const COLUMNS_KEY = "aoa.acat-book.columns.v1.synthetic";

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
  bookRow({ id: "rec-a", clientName: "Alpha Smith", status: "Submitted", lastActivityAt: "2026-10-03T00:00:00.000Z" }),
  bookRow({ id: "rec-b", clientName: "Bravo Jones", status: "Submitted", lastActivityAt: "2026-10-02T12:00:00.000Z" }),
  bookRow({ id: "rec-d", clientName: "Delta Smith", status: "Submitted", lastActivityAt: "2026-10-02T00:00:00.000Z" }),
  bookRow({ id: "rec-c", clientName: "Charlie Smith", status: "Completed", lastActivityAt: "2026-10-01T00:00:00.000Z" }),
];

function drawerTransfer(id: string, over: Record<string, unknown> = {}) {
  const row = ROWS.find((r) => r.id === id) ?? ROWS[0];
  const mapped = mapDrawerTransfer({
    id, identityVersion: 1, clientName: row.clientName, status: row.status, direction: "In", type: "Full",
    apexAccountId: "****1111", acatDate: "2026-09-01", assets: [], ...over,
  });
  if (!mapped) throw new Error("fixture must map");
  return mapped;
}

type ViewProps = Partial<Parameters<typeof AcatBookView>[0]>;
function view(props: ViewProps = {}) {
  return createElement(AcatBookView, {
    rows: ROWS, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic",
    editsEnabled: true, ...props,
  });
}
const renderBook = (props: ViewProps = {}) => render(view(props));

function openRow(name: string) {
  fireEvent.click(screen.getByText(name).closest("tr")!);
}
const shell = () => screen.findByTestId("acat-transfer-shell");

let blobs: Blob[] = [];
let downloads: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  blobs = [];
  downloads = [];
  window.localStorage.clear();
  vi.stubEnv(BOOK_EPIC, "1");
  vi.stubEnv(BOOK_SHOW, "1");
  vi.stubEnv(EDITS, "1");
  mocks.auth.mockResolvedValue({ user: { role: "ADMIN", email: "synthetic@example.test" } });
  mocks.loadDetail.mockResolvedValue({ ok: true, status: { type: "Full transfer" } });
  mocks.load.mockImplementation(async (id: string) => ({ ok: true, transfer: drawerTransfer(id) }));
  mocks.suggestion.mockResolvedValue({ ok: true, status: "none", dtccNumber: null });
  mocks.contras.mockResolvedValue({ ok: true, contras: [] });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:synthetic"; }),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("book transfer drawer", () => {
  it("tkt332 book: a row opens the tracker shell inside the existing drawer when the drawer is on", async () => {
    renderBook({ transferDrawer: { admin: false } });
    openRow("Alpha Smith");
    const root = await shell();
    const dialog = screen.getByRole("dialog", { name: "Transfer drawer" });
    expect(dialog.contains(root)).toBe(true);
    await screen.findByRole("combobox", { name: "Status" });
    expect(screen.queryByRole("form", { name: "Edit transfer" })).toBeNull();
    expect(screen.queryByText("‹ Close")).toBeNull();
    expect(mocks.load).toHaveBeenCalledWith("rec-a");
    markCase(SUITE, "tkt332 book: a row opens the tracker shell inside the existing drawer when the drawer is on");
  });

  it("tkt332 book: previous and next open the neighbouring transfer in the filtered order", async () => {
    renderBook({ transferDrawer: { admin: false } });
    fireEvent.change(screen.getByLabelText("Search transfers"), { target: { value: "smith" } });
    expect(screen.queryByText("Bravo Jones")).toBeNull();
    openRow("Alpha Smith");
    await screen.findByRole("combobox", { name: "Status" });
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous record" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next record" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith("rec-d"));
    await screen.findByText("2 of 3");
    expect(mocks.load).not.toHaveBeenCalledWith("rec-b");
    fireEvent.click(screen.getByRole("button", { name: "Next record" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith("rec-c"));
    await screen.findByText("3 of 3");
    expect((screen.getByRole("button", { name: "Next record" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous record" }));
    await screen.findByText("2 of 3");
    markCase(SUITE, "tkt332 book: previous and next open the neighbouring transfer in the filtered order");
  });

  it("tkt332 book: a removed transfer leaves the book and closes the drawer", async () => {
    mocks.remove.mockResolvedValue({ ok: true, transfer: drawerTransfer("rec-a"), removed: true });
    renderBook({ transferDrawer: { admin: true } });
    openRow("Alpha Smith");
    await screen.findByRole("combobox", { name: "Status" });
    fireEvent.click(screen.getByRole("button", { name: "Delete ACAT record" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete ACAT record?" });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Wrong client" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByTestId("acat-transfer-shell")).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Alpha Smith")).toBeNull();
    expect(screen.getByText("Bravo Jones")).toBeTruthy();
    expect(mocks.remove).toHaveBeenCalledWith("rec-a", "Wrong client");
    expect(mocks.refresh).toHaveBeenCalled();
    markCase(SUITE, "tkt332 book: a removed transfer leaves the book and closes the drawer");
  });

  it("tkt332 book: the drawer keeps the link actions and preparation panel and shows no legacy positions block", async () => {
    renderBook({ transferDrawer: { admin: false }, linkedByRecordId: { "rec-b": "transfer-1" } });
    openRow("Alpha Smith");
    await screen.findByRole("combobox", { name: "Status" });
    expect(await screen.findByTestId("acat-transfer-shell")).toBeTruthy();
    expect(screen.queryByTestId("status-card")).toBeNull();
    expect(screen.queryByText(/Loading positions|No positions recorded/)).toBeNull();
    expect(screen.getByTestId("preparation-panel")).toBeTruthy();
    expect(screen.getByTestId("link-picker")).toBeTruthy();
    cleanup();
    renderBook({ transferDrawer: { admin: false }, linkedByRecordId: { "rec-b": "transfer-1" } });
    openRow("Bravo Jones");
    await screen.findByRole("combobox", { name: "Status" });
    expect(screen.getByRole("link", { name: "View transfer →" }).getAttribute("href")).toBe("/asset-transfer/transfer-1");
    expect(screen.getByRole("button", { name: "Unlink transfer" })).toBeTruthy();
    expect(screen.getByTestId("preparation-panel")).toBeTruthy();
    markCase(SUITE, "tkt332 book: the drawer keeps the link actions and preparation panel and shows no legacy positions block");
  });

  it("tkt332 book: Export CSV downloads every filtered row including collapsed groups and only the selected columns", async () => {
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(["clientName", "status"]));
    renderBook({ transferDrawer: { admin: false }, columnsEnabled: true });
    fireEvent.change(screen.getByLabelText("Search transfers"), { target: { value: "smith" } });
    expect(screen.queryByText("Charlie Smith")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(blobs).toHaveLength(1);
    const text = await blobs[0].text();
    expect(text.split("\r\n").filter(Boolean)).toEqual([
      "Client,Status",
      "Alpha Smith,Submitted",
      "Delta Smith,Submitted",
      "Charlie Smith,Completed",
    ]);
    expect(text).not.toContain("Bravo Jones");
    expect(text).not.toContain("Contra");
    expect(downloads[0]).toMatch(/^acat-records-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((blobs[0] as Blob).type).toBe("text/csv;charset=utf-8;");
    markCase(SUITE, "tkt332 book: Export CSV downloads every filtered row including collapsed groups and only the selected columns");
  });

  it("tkt332 book: Export CSV on an empty view downloads the headers only", async () => {
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(["clientName", "status"]));
    renderBook({ transferDrawer: { admin: false }, columnsEnabled: true });
    fireEvent.change(screen.getByLabelText("Search transfers"), { target: { value: "no such client" } });
    expect(screen.getByText("No transfers match.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await blobs[0].text()).toBe("Client,Status\r\n");
    markCase(SUITE, "tkt332 book: Export CSV on an empty view downloads the headers only");
  });

  it("tkt332 book: a failed export keeps the book and offers retry", async () => {
    renderBook({ transferDrawer: { admin: false } });
    const create = URL.createObjectURL as unknown as ReturnType<typeof vi.fn>;
    create.mockImplementationOnce(() => { throw new Error("blob failed"); });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(ACAT_EXPORT_FAILURE);
    expect(screen.getByText("Alpha Smith")).toBeTruthy();
    expect(downloads).toHaveLength(0);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(downloads).toHaveLength(1);
    expect(blobs).toHaveLength(1);
    markCase(SUITE, "tkt332 book: a failed export keeps the book and offers retry");
  });

  it("tkt332 book: Export CSV and the shell are absent while the drawer is off", async () => {
    renderBook({});
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    openRow("Alpha Smith");
    await screen.findByRole("form", { name: "Edit transfer" });
    expect(screen.queryByTestId("acat-transfer-shell")).toBeNull();
    expect(screen.getByText("‹ Close")).toBeTruthy();
    expect(mocks.load).not.toHaveBeenCalled();
    cleanup();
    renderBook({ transferDrawer: null });
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    markCase(SUITE, "tkt332 book: Export CSV and the shell are absent while the drawer is off");
  });

  it("tkt332 book: the export follows the legacy columns while the chooser is off", async () => {
    renderBook({ transferDrawer: { admin: false }, columnsEnabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const lines = (await blobs[0].text()).split("\r\n").filter(Boolean);
    expect(lines[0]).toBe(ACAT_BOOK_COLUMNS.map((c) => c.label).join(","));
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe("Alpha Smith,****1111,Submitted,Schwab,In,Full,2026-07-10,Not linked");
    markCase(SUITE, "tkt332 book: the export follows the legacy columns while the chooser is off");
  });

  it("tkt332 book: a saved change updates the book row without closing the drawer", async () => {
    mocks.status.mockResolvedValue({ ok: true, transfer: drawerTransfer("rec-a", { status: "Accepted" }) });
    renderBook({ transferDrawer: { admin: false } });
    expect(screen.getByText("Alpha Smith").closest("tr")?.textContent).toContain("Submitted");
    openRow("Alpha Smith");
    await screen.findByRole("combobox", { name: "Status" });
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "Accepted" } });
    await waitFor(() => expect(mocks.status).toHaveBeenCalledWith("rec-a", "Accepted"));
    const alphaRow = () => screen.getAllByRole("row").find((r) => r.textContent?.includes("Alpha Smith"));
    await waitFor(() => expect(alphaRow()?.textContent).toContain("Accepted"));
    expect(alphaRow()?.textContent).not.toContain("Submitted");
    expect(screen.getByTestId("acat-transfer-shell")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Status" }) as HTMLSelectElement).value).toBe("Accepted");
    markCase(SUITE, "tkt332 book: a saved change updates the book row without closing the drawer");
  });

  it("tkt332 book: a removed transfer stays hidden while a refresh still returns it and clears once the rows no longer contain it", async () => {
    mocks.remove.mockResolvedValue({ ok: true, transfer: drawerTransfer("rec-a"), removed: true });
    const { rerender } = renderBook({ transferDrawer: { admin: true } });
    openRow("Alpha Smith");
    await screen.findByRole("combobox", { name: "Status" });
    fireEvent.click(screen.getByRole("button", { name: "Delete ACAT record" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete ACAT record?" });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Wrong client" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Alpha Smith")).toBeNull());
    rerender(view({ transferDrawer: { admin: true }, rows: [...ROWS] }));
    expect(screen.queryByText("Alpha Smith")).toBeNull();
    expect(screen.getByText("Bravo Jones")).toBeTruthy();
    rerender(view({ transferDrawer: { admin: true }, rows: ROWS.filter((r) => r.id !== "rec-a") }));
    expect(screen.queryByText("Alpha Smith")).toBeNull();
    rerender(view({ transferDrawer: { admin: true }, rows: [...ROWS] }));
    expect(screen.getByText("Alpha Smith")).toBeTruthy();
    markCase(SUITE, "tkt332 book: a removed transfer stays hidden while a refresh still returns it and clears once the rows no longer contain it");
  });

  it("tkt332 book: edits off mounts the shell read-only inside the read-only drawer", async () => {
    renderBook({ transferDrawer: { admin: true }, editsEnabled: false });
    openRow("Alpha Smith");
    await screen.findByRole("combobox", { name: "Status" });
    const dialog = screen.getByRole("dialog", { name: "Transfer drawer" });
    expect(within(dialog).getByTestId("acat-transfer-shell")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Status" }) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Mark Complete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete ACAT record" })).toBeNull();
    expect(screen.queryByTestId("preparation-panel")).toBeNull();
    expect(screen.queryByTestId("link-picker")).toBeNull();
    expect(screen.getByText("Not linked to an asset transfer")).toBeTruthy();
    expect(mocks.contras).not.toHaveBeenCalled();
    expect(mocks.suggestion).not.toHaveBeenCalled();
    markCase(SUITE, "tkt332 book: edits off mounts the shell read-only inside the read-only drawer");
  });
});
