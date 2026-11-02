// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ action: vi.fn(), build: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push, refresh: m.refresh }) }));
vi.mock("@/app/(authenticated)/trade-requests/[id]/actions", () => ({ loadRequestPdfExclusions: m.action }));
vi.mock("@/lib/trade-requests/request-pdf", () => ({ buildRequestPdf: m.build }));

import { RequestDetailDialog, useRequestDetailFrame } from "@/components/trade-requests/detail/RequestDetailDialog";
import { RequestDetailRoute } from "@/components/trade-requests/detail/RequestDetailRoute";
import type { TradeRequest } from "@/lib/trade-requests/request-types";

// ticket: the request detail frame — tabs (AC-9), audit order (AC-42),
// rejected banner (AC-115), Download PDF and its failure line (AC-58, AC-100),
// and the slots later work orders fill. Synthetic data.

function request(overrides: Partial<TradeRequest> = {}): TradeRequest {
  return {
    id: "REQ-SYN1", clientId: "HH-1", clientName: "Synthetic Family", clientIds: ["HH-1", "HH-2"],
    clientNames: ["Synthetic Family", "Sample Person"], advisor: "Rachel Moss", submittedBy: "Avery Stone",
    tradeType: "Cash Deposit", tradeAmount: "50000", depositAccount: "SYN-1", rebalanceAll: true,
    status: "Pending Current Asset Liquidation", date: "2026-10-15T14:00:00.000Z", updatedAt: "2026-10-15T15:00:00.000Z",
    selectedAccounts: ["SYN-1"], totalValue: 50000, priority: "", advisorNotes: "Synthetic note",
    residence: "CA", liquidationApproval: "No", advisorExclusions: "", clientExclusions: "SYNY",
    esgFilters: { fossilFuels: false, tobacco: true, none: false }, riskProfile: 9,
    baseAllocation: { equity: 50, fixed: 40, cash: 10 },
    equityStrategies: [{ id: 1, benchmark: "Synthetic Core", allocation: 90, rationale: "Synthetic rationale" }],
    raiseCashReason: "", liquidityDeadline: null, liquidateOption: "", liquidatePositions: "",
    accountMetadata: [{ accountId: "ulid-1", accountNumber: "SYN-1", accountType: "Taxable", balance: 50000 }],
    auditLog: [
      { id: "a1", date: "2026-10-15T14:00:00.000Z", user: "Avery Stone", action: "Request Created", notes: "Initial", channel: "standalone" },
      { id: "a2", date: "2026-10-15T15:00:00.000Z", user: "Riley Ops", action: "Status Changed", notes: "Synthetic step", channel: "aoa" },
    ],
    ...overrides,
  };
}

const EXPORTER = { name: "Riley Ops", email: "ops@example.invalid" };

function open(props: Partial<Parameters<typeof RequestDetailDialog>[0]> = {}) {
  const onClose = vi.fn();
  render(createElement(RequestDetailDialog, { request: request(), exporter: EXPORTER, onClose, ...props }));
  return { onClose, dialog: screen.getByTestId("trade-request-detail") };
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
  URL.createObjectURL = vi.fn(() => "blob:synthetic");
  URL.revokeObjectURL = vi.fn();
});
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("RequestDetailDialog (ticket)", () => {
  it("shows the title, the three views and the Request Details sections (AC-9)", () => {
    const { dialog } = open();
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Synthetic Family (REQ-SYN1)");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Request Details", "Audit Trail", "Pre-approval Checklist"]);
    const details = screen.getByRole("tabpanel");
    for (const text of [
      "Pending Liquidation", "N/A", "Clients (Household)", "Synthetic Family & Sample Person", "Selected Accounts", "ID: ulid-1",
      "Deposit Amount", "Deposit Into Account", "Yes — all selected accounts will be rebalanced to target", "Level 9 / 25",
      "Fixed Inc.", "\"Synthetic rationale\"", "90% / 100%", "California (CA) - Muni Preference", "Tobacco", "None", "SYNY",
      "Advisor Compliance & Execution Notes",
    ]) expect(within(details).getAllByText(text, { exact: false }).length, text).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Download PDF" }).getAttribute("title")).toBe("Download as PDF");
  });

  it("lists the audit trail newest first with the AOA marker (AC-42)", () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: "Audit Trail" }));
    const items = within(screen.getByRole("tabpanel")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Status ChangedAOA"), expect.stringContaining("Request Created"),
    ]);
    expect(items[0].textContent).toContain("Riley Ops");
    expect(items[0].textContent).toContain("Synthetic step");
    expect(items[1].textContent).not.toContain("AOA");
  });

  it("shows the rejected-and-locked banner on every view (AC-115)", () => {
    open({ request: request({ status: "Rejected" }) });
    for (const name of ["Request Details", "Audit Trail", "Pre-approval Checklist"]) {
      fireEvent.click(screen.getByRole("tab", { name }));
      const banner = screen.getByRole("alert");
      expect(banner.textContent).toBe("Request Rejected and LockedFor SEC compliance, this record is permanently locked. The advisor must submit a new request.");
    }
  });

  it("closes from ×, the footer Close, Esc and the backdrop", () => {
    const { onClose, dialog } = open();
    const [x, footer] = screen.getAllByRole("button", { name: "Close" });
    fireEvent.click(x);
    fireEvent.click(footer);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("hosts the checklist and actions slots and lets them use the footer line and tabs", () => {
    function Actions() {
      const frame = useRequestDetailFrame();
      return createElement("button", { type: "button", onClick: () => { frame.setError("Action failed. Please try again."); frame.selectTab("checklist"); } }, "Synthetic action");
    }
    open({ checklist: { label: "Pre-approval Checklist (7)", content: "CHECKLIST-CONTENT" }, actions: createElement(Actions) });
    fireEvent.click(screen.getByRole("button", { name: "Synthetic action" }));
    expect(screen.getByRole("alert").textContent).toBe("Action failed. Please try again.");
    expect(screen.getByRole("tab", { name: "Pre-approval Checklist (7)" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("CHECKLIST-CONTENT");
  });

  it("exposes close() and refresh() to slot content", () => {
    const onRefresh = vi.fn();
    function Actions() {
      const frame = useRequestDetailFrame();
      return createElement("span", null,
        createElement("button", { type: "button", onClick: frame.close }, "Synthetic close"),
        createElement("button", { type: "button", onClick: frame.refresh }, "Synthetic refresh"));
    }
    const { onClose } = open({ actions: createElement(Actions), onRefresh });
    fireEvent.click(screen.getByRole("button", { name: "Synthetic close" }));
    fireEvent.click(screen.getByRole("button", { name: "Synthetic refresh" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("the direct-link route takes the same slots; close() returns to the queue and refresh() reloads", () => {
    function Actions() {
      const frame = useRequestDetailFrame();
      return createElement("span", null,
        createElement("button", { type: "button", onClick: frame.close }, "Synthetic close"),
        createElement("button", { type: "button", onClick: frame.refresh }, "Synthetic refresh"));
    }
    render(createElement(RequestDetailRoute, {
      request: request(), accounts: [], exporter: EXPORTER,
      checklist: { label: "Pre-approval Checklist (3)", content: "ROUTE-CHECKLIST" }, actions: createElement(Actions),
    }));
    fireEvent.click(screen.getByRole("tab", { name: "Pre-approval Checklist (3)" }));
    expect(screen.getByRole("tabpanel").textContent).toBe("ROUTE-CHECKLIST");
    fireEvent.click(screen.getByRole("button", { name: "Synthetic refresh" }));
    expect(m.refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Synthetic close" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(m.push).toHaveBeenCalledTimes(2);
    expect(m.push).toHaveBeenCalledWith("/trade-requests/queue", { scroll: false });
  });

  it("Download PDF reads the selected accounts' exclusions and saves the document (AC-58)", async () => {
    m.action.mockResolvedValue({ ok: true, byAccountId: { "ulid-1": [{ id: "e1", accountId: "ulid-1", ticker: "SYNA", kind: "advisor", reason: "", noBuy: true, noSell: false }] } });
    m.build.mockResolvedValue({ bytes: new Uint8Array([37, 80, 68, 70]), filename: "Trade_Request_x.pdf" });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    open();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download PDF" })); });
    expect(m.action).toHaveBeenCalledWith(["ulid-1"]);
    expect(m.build).toHaveBeenCalledWith(expect.objectContaining({ id: "REQ-SYN1" }), EXPORTER, [
      { accountNumber: "SYN-1", kind: "advisor", ticker: "SYNA", reason: "", noBuy: true, noSell: false },
    ]);
    expect(click).toHaveBeenCalledTimes(1);
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("Trade_Request_x.pdf");
    expect(screen.queryByRole("alert")).toBeNull();
    click.mockRestore();
  });

  it("shows the PDF failure line: service text, else the default (AC-100)", async () => {
    m.action.mockResolvedValue({ ok: false, message: "Internal server error" });
    open();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download PDF" })); });
    expect(screen.getByRole("alert").textContent).toBe("Internal server error");
    expect(m.build).not.toHaveBeenCalled();

    m.action.mockRejectedValue("not an error");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download PDF" })); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("PDF export failed. Please try again."));

    m.action.mockResolvedValue({ ok: true, byAccountId: {} });
    m.build.mockRejectedValue(new Error(""));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download PDF" })); });
    expect(screen.getByRole("alert").textContent).toBe("PDF export failed. Please try again.");
  });
});
