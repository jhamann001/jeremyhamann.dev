// @vitest-environment jsdom
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), write: vi.fn(), read: vi.fn(), stale: vi.fn(), revalidate: vi.fn(), library: vi.fn(),
  refresh: vi.fn(), loadDetail: vi.fn(), readBook: vi.fn(),
  load: vi.fn(), change: vi.fn(), complete: vi.fn(), reject: vi.fn(), status: vi.fn(), text: vi.fn(),
  remove: vi.fn(), replace: vi.fn(), search: vi.fn(), contras: vi.fn(), suggestion: vi.fn(),
  mounts: [] as string[], unmounts: [] as string[],
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
vi.mock("@/lib/data/acat-workspace", () => ({ readAcatBook: mocks.readBook, markAcatBookStale: mocks.stale }));
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
vi.mock("@/components/transfers/AcatPaperworkSection", async () => {
  const react = await import("react");
  return {
    AcatPaperworkSection: ({ recordId, readOnly }: { recordId: string; readOnly: boolean }) => {
      react.useEffect(() => {
        mocks.mounts.push(recordId);
        return () => { mocks.unmounts.push(recordId); };
      }, [recordId]);
      return react.createElement("section", { "data-testid": "acat-paperwork", "data-record": recordId, "data-readonly": String(readOnly) });
    },
  };
});

import { AcatBookData } from "@/components/transfers/AcatBookData";
import { AcatBookView } from "@/components/transfers/AcatBookView";
import { type AcatBookRow } from "@/lib/data/acat-book";
import { mapDrawerTransfer } from "@/lib/data/acat-drawer-contract";
import type { Identity } from "@/lib/data/types";

const SUITE = "acat-paperwork-mount";
const BOOK_EPIC = "EPIC_ACAT_OPS_WORKSPACE_TKT290";
const BOOK_SHOW = "SHOW_ACAT_OPS_BOOK_TKT293";
const DRAWER_EPIC = "EPIC_ACAT_TRANSFER_DRAWER_TKT319";
const DRAWER_SHOW = "SHOW_ACAT_TRANSFER_DRAWER_TKT332";
const EPIC = "EPIC_ACAT_PAPERWORK_TKT321";
const SHOW = "SHOW_ACAT_PAPERWORK_TKT335";

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
  bookRow({ id: "rec-b", clientName: "Bravo Jones", lastActivityAt: "2026-10-02T12:00:00.000Z" }),
];

function drawerTransfer(id: string) {
  const mapped = mapDrawerTransfer({
    id, identityVersion: 1, clientName: "Client", status: "Submitted", direction: "In", type: "Full",
    apexAccountId: "****1111", acatDate: "2026-09-01", assets: [],
  });
  if (!mapped) throw new Error("fixture must map");
  return mapped;
}

type ViewProps = Partial<Parameters<typeof AcatBookView>[0]>;
const view = (props: ViewProps = {}) => createElement(AcatBookView, {
  rows: ROWS, linkedTransferIds: {}, linkedByRecordId: {}, userName: null, prefsScope: "synthetic", editsEnabled: true, ...props,
});
const renderBook = (props: ViewProps = {}) => render(view(props));
const openRow = (name: string) => fireEvent.click(screen.getByText(name).closest("tr")!);
const shell = () => screen.findByTestId("acat-transfer-shell");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mounts.length = 0;
  mocks.unmounts.length = 0;
  window.localStorage.clear();
  for (const name of [BOOK_EPIC, BOOK_SHOW, DRAWER_EPIC, DRAWER_SHOW, EPIC, SHOW]) vi.stubEnv(name, "");
  vi.stubEnv(BOOK_EPIC, "1");
  vi.stubEnv(BOOK_SHOW, "1");
  mocks.auth.mockResolvedValue({ user: { role: "ADMIN", email: "synthetic@example.test" } });
  mocks.loadDetail.mockResolvedValue({ ok: true, status: { type: "Full transfer" } });
  mocks.load.mockImplementation(async (id: string) => ({ ok: true, transfer: drawerTransfer(id) }));
  mocks.suggestion.mockResolvedValue({ ok: true, status: "none", dtccNumber: null });
  mocks.contras.mockResolvedValue({ ok: true, contras: [] });
  mocks.readBook.mockResolvedValue({ rows: ROWS, linkedTransferIds: {}, linkedByRecordId: {}, removedRows: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("paperwork mount", () => {
  it("tkt335 mount: no paperwork section while the paperwork release is off", async () => {
    renderBook({ transferDrawer: { admin: false } });
    openRow("Alpha Smith");
    await within(await shell()).findByLabelText("Status");
    expect(screen.queryByTestId("acat-paperwork")).toBeNull();
    cleanup();
    renderBook({ transferDrawer: { admin: false }, paperwork: false });
    openRow("Alpha Smith");
    await within(await shell()).findByLabelText("Status");
    expect(screen.queryByTestId("acat-paperwork")).toBeNull();
    expect(mocks.mounts).toEqual([]);
    markCase(SUITE, "tkt335 mount: no paperwork section while the paperwork release is off");
  });

  it("tkt335 mount: the shell mounts the section right after the transfer details when paperwork is on", async () => {
    renderBook({ transferDrawer: { admin: false }, paperwork: true });
    openRow("Alpha Smith");
    const section = await screen.findByTestId("acat-paperwork");
    expect(section.getAttribute("data-record")).toBe("rec-a");
    expect(section.getAttribute("data-readonly")).toBe("false");
    const details = (await shell()).querySelector("[class*=details]") as HTMLElement;
    expect(details).toBeTruthy();
    expect(section.previousElementSibling).toBe(details);
    markCase(SUITE, "tkt335 mount: the shell mounts the section right after the transfer details when paperwork is on");
  });

  it("tkt335 mount: the section is keyed by the open transfer and remounts when another transfer opens", async () => {
    renderBook({ transferDrawer: { admin: false }, paperwork: true });
    openRow("Alpha Smith");
    await screen.findByTestId("acat-paperwork");
    expect(mocks.mounts).toEqual(["rec-a"]);
    fireEvent.click(screen.getByRole("button", { name: "Next record" }));
    await screen.findByText("Record rec-b", { exact: false });
    await screen.findByTestId("acat-paperwork");
    expect(screen.getByTestId("acat-paperwork").getAttribute("data-record")).toBe("rec-b");
    expect(mocks.unmounts).toContain("rec-a");
    expect(mocks.mounts).toEqual(["rec-a", "rec-b"]);
    markCase(SUITE, "tkt335 mount: the section is keyed by the open transfer and remounts when another transfer opens");
  });

  it("tkt335 mount: the book view threads paperwork to the shell only for paperwork true and mounts nothing without the drawer", async () => {
    renderBook({ transferDrawer: null, paperwork: true });
    openRow("Alpha Smith");
    await screen.findAllByText("Alpha Smith");
    expect(screen.queryByTestId("acat-transfer-shell")).toBeNull();
    expect(screen.queryByTestId("acat-paperwork")).toBeNull();
    cleanup();
    renderBook({ transferDrawer: { admin: false }, paperwork: true, editsEnabled: false });
    openRow("Alpha Smith");
    const section = await screen.findByTestId("acat-paperwork");
    expect(section.getAttribute("data-readonly")).toBe("true");
    markCase(SUITE, "tkt335 mount: the book view threads paperwork to the shell only for paperwork true and mounts nothing without the drawer");
  });

  it("tkt335 mount: with the drawer off, paperwork on alone shows no drawer and no section", async () => {
    vi.stubEnv(EPIC, "1");
    vi.stubEnv(SHOW, "1");
    const identity = { role: "ADMIN", email: "synthetic@example.test" } as unknown as Identity;
    const tree = await AcatBookData({ identity, userName: null, prefsScope: "synthetic", editsEnabled: true });
    const children = Children.toArray((tree as ReactElement<{ children: ReactNode }>).props.children);
    const element = children.find((c): c is ReactElement<ViewProps> => isValidElement(c) && c.type === AcatBookView);
    expect(element?.props.paperwork).toBe(false);
    expect(element?.props.transferDrawer).toBeNull();
    render(createElement(AcatBookView, element!.props as Parameters<typeof AcatBookView>[0]));
    openRow("Alpha Smith");
    await screen.findAllByText("Alpha Smith");
    expect(screen.queryByTestId("acat-transfer-shell")).toBeNull();
    expect(screen.queryByTestId("acat-paperwork")).toBeNull();
    markCase(SUITE, "tkt335 mount: with the drawer off, paperwork on alone shows no drawer and no section");
  });
});
