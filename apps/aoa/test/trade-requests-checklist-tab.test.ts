// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), pdf: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push, refresh: m.refresh }) }));
vi.mock("@/app/(authenticated)/trade-requests/checklist-actions", () => ({ readRequestChecklist: m.read, writeRequestChecklistItem: m.write }));
vi.mock("@/app/(authenticated)/trade-requests/[id]/actions", () => ({ loadRequestPdfExclusions: m.pdf }));

import { RequestDetailDialog } from "@/components/trade-requests/detail/RequestDetailDialog";
import { RequestChecklistScope, useRequestChecklistSummary } from "@/components/trade-requests/checklist/RequestChecklistScope";
import { RequestDetailRouteWithChecklist } from "@/components/trade-requests/checklist/RequestDetailRouteWithChecklist";
import type { TradeRequest } from "@/lib/trade-requests/request-types";

// ticket: the Pre-approval Checklist tab inside the request detail frame —
// immediate state (AC-15), lock (AC-48, AC-87), load and save failures
// (AC-84, AC-85, AC-150), advisor read-only (AC-86), text fields (AC-127,
// AC-151), "Checked by" (AC-130), progress (AC-140). Synthetic data.

function request(overrides: Partial<TradeRequest> = {}): TradeRequest {
  return {
    id: "REQ-SYN1", clientId: "HH-1", clientName: "Synthetic Family", clientIds: ["HH-1"], clientNames: ["Synthetic Family"],
    advisor: "Rachel Moss", submittedBy: "Avery Stone", tradeType: "Rebalance", tradeAmount: "", depositAccount: "",
    rebalanceAll: false, status: "Pending Review", date: "2026-10-15T14:00:00.000Z", updatedAt: "2026-10-15T15:00:00.000Z",
    selectedAccounts: ["SYN-1"], totalValue: 50000, priority: "Normal", advisorNotes: "Synthetic note", residence: "",
    liquidationApproval: "", advisorExclusions: "", clientExclusions: "", esgFilters: {}, riskProfile: null, baseAllocation: null,
    equityStrategies: [], raiseCashReason: "", liquidityDeadline: null, liquidateOption: "", liquidatePositions: "",
    accountMetadata: [{ accountId: "ulid-1", accountNumber: "SYN-1", accountType: "Taxable", balance: 50000 }],
    auditLog: [{ id: "a1", date: "2026-10-15T14:00:00.000Z", user: "Avery Stone", action: "Request Created", notes: "Initial" }],
    ...overrides,
  };
}

const STAMP_AT = "2026-10-15T15:00:00.000Z";
const STORED = {
  exclusions: { checked: true, value: "", by: "Riley Ops", at: STAMP_AT },
  templates: { checked: true, value: "Synthetic Template", by: "Riley Ops", at: STAMP_AT },
  residual_cash: { checked: false, value: "", by: "Admin Person", at: STAMP_AT },
};

function SummaryProbe() {
  const summary = useRequestChecklistSummary();
  return createElement("output", { "data-testid": "summary" }, summary ? `${summary.loaded}:${summary.uncheckedCount}/${summary.total}` : "none");
}

function open(role: string, overrides: Partial<TradeRequest> = {}) {
  const value = request(overrides);
  return render(createElement(RequestChecklistScope, {
    request: value, role,
    children: (checklist) => createElement(RequestDetailDialog, {
      request: value, exporter: { name: "Riley Ops", email: "ops@example.invalid" }, onClose: vi.fn(), checklist,
      actions: createElement(SummaryProbe),
    }),
  }));
}

async function openChecklist(role: string, overrides: Partial<TradeRequest> = {}) {
  const view = open(role, overrides);
  await waitFor(() => expect(screen.getByTestId("summary").textContent).toMatch(/^true:/));
  fireEvent.click(screen.getByRole("tab", { name: /Pre-approval Checklist/ }));
  return { view, panel: screen.getByTestId("trade-request-checklist") };
}

const item = (name: string) => screen.getByRole("button", { name });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
});
beforeEach(() => {
  vi.resetAllMocks();
  m.read.mockResolvedValue({ ok: true, checklist: STORED });
  m.write.mockResolvedValue({ ok: true, checklist: {} });
});
afterEach(cleanup);

describe("Pre-approval Checklist tab (ticket)", () => {
  it("shows the loaded state, progress, stamps and the unchecked count in the tab label (AC-130, AC-140)", async () => {
    const { panel } = await openChecklist("OPERATIONS");
    expect(m.read).toHaveBeenCalledWith("REQ-SYN1");
    expect(screen.getByRole("tab", { name: /Pre-approval Checklist/ }).textContent).toBe("Pre-approval Checklist (5)");
    expect(panel.textContent).toContain("Pre-approval checklist — confirm before you approve & execute.");
    expect(within(panel).getByText("2 of 7 complete")).toBeTruthy();
    const progress = within(panel).getByRole("progressbar", { name: "Pre-approval checklist completion" }) as HTMLProgressElement;
    expect([progress.value, progress.max]).toEqual([2, 7]);
    const date = new Date(STAMP_AT).toLocaleDateString();
    expect(within(panel).getAllByText(`Checked by Riley Ops · ${date}`)).toHaveLength(2);
    // The last change unchecked it; the line still names who made it.
    expect(within(panel).getByText(`Checked by Admin Person · ${date}`)).toBeTruthy();
    expect(item("Exclusions & restrictions applied (DNB / DNS)").getAttribute("aria-pressed")).toBe("true");
    expect(item("Asset location completed").getAttribute("aria-pressed")).toBe("false");
    expect((within(panel).getByLabelText("Template name(s)") as HTMLTextAreaElement).value).toBe("Synthetic Template");
    expect(within(panel).queryByText(/Read-only|checklist is locked/)).toBeNull();
  });

  it("marks and unmarks at once and saves each change (AC-15)", async () => {
    const pending = deferred<{ ok: boolean }>();
    m.write.mockReturnValue(pending.promise);
    const { panel } = await openChecklist("ADMIN");
    fireEvent.click(item("Asset location completed"));
    expect(item("Asset location completed").getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).getByText("3 of 7 complete")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Pre-approval Checklist/ }).textContent).toBe("Pre-approval Checklist (4)");
    expect(screen.getByTestId("summary").textContent).toBe("true:4/7");
    expect(m.write).toHaveBeenLastCalledWith("REQ-SYN1", { key: "asset_location", checked: true, value: "" });
    fireEvent.click(item("Exclusions & restrictions applied (DNB / DNS)"));
    expect(item("Exclusions & restrictions applied (DNB / DNS)").getAttribute("aria-pressed")).toBe("false");
    expect(m.write).toHaveBeenLastCalledWith("REQ-SYN1", { key: "exclusions", checked: false, value: "" });
    await act(async () => pending.resolve({ ok: true }));
  });

  it("shows a text field once its item is checked and saves the text when it loses focus (AC-127, AC-151)", async () => {
    const { panel } = await openChecklist("OPERATIONS");
    expect(within(panel).queryByLabelText("Transition model")).toBeNull();
    fireEvent.click(item("Transition used"));
    const field = within(panel).getByLabelText("Transition model") as HTMLTextAreaElement;
    expect(field.placeholder).toBe("e.g., National Tax Efficient – Risk 20");
    expect(field.disabled).toBe(false);
    fireEvent.change(field, { target: { value: "Synthetic Transition" } });
    expect(m.write).toHaveBeenCalledTimes(1);
    fireEvent.blur(field);
    expect(m.write).toHaveBeenLastCalledWith("REQ-SYN1", { key: "transition", checked: true, value: "Synthetic Transition" });
  });

  it("keeps the reviewer's change when the save fails, with no message (AC-85)", async () => {
    m.write.mockResolvedValueOnce({ ok: false, message: "Service Unavailable" }).mockRejectedValueOnce(new Error("network"));
    const { panel } = await openChecklist("OPERATIONS");
    fireEvent.click(item("Residual cash trades placed"));
    fireEvent.click(item("Legacy / ACAT positions liquidated"));
    await act(async () => undefined);
    expect(item("Residual cash trades placed").getAttribute("aria-pressed")).toBe("true");
    expect(item("Legacy / ACAT positions liquidated").getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).getByText("4 of 7 complete")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reloads the saved state when the request is reopened (AC-85)", async () => {
    m.write.mockResolvedValue({ ok: false, message: "Service Unavailable" });
    const { view } = await openChecklist("OPERATIONS");
    fireEvent.click(item("Asset location completed"));
    view.unmount();
    await openChecklist("OPERATIONS");
    expect(m.read).toHaveBeenCalledTimes(2);
    expect(item("Asset location completed").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows every item unchecked when the load fails and leaves the other views as they are (AC-84, AC-150)", async () => {
    m.read.mockResolvedValue({ ok: false, message: "Service Unavailable" });
    const { panel } = await openChecklist("OPERATIONS");
    expect(within(panel).getByText("0 of 7 complete")).toBeTruthy();
    for (const button of within(panel).getAllByRole("button")) expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(within(panel).queryByText(/Checked by/)).toBeNull();
    expect(screen.getByTestId("summary").textContent).toBe("true:7/7");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Request Details" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("Synthetic note");
    fireEvent.click(screen.getByRole("tab", { name: "Audit Trail" }));
    expect(within(screen.getByRole("tabpanel")).getAllByRole("listitem")).toHaveLength(1);
  });

  it("treats a load that throws like a failed load (AC-84)", async () => {
    m.read.mockRejectedValue(new Error("network"));
    const { panel } = await openChecklist("ADMIN");
    expect(within(panel).getByText("0 of 7 complete")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("accepts no change until the load settles, so a save never replaces stored text unseen", async () => {
    const pending = deferred<unknown>();
    m.read.mockReturnValue(pending.promise);
    open("OPERATIONS");
    fireEvent.click(screen.getByRole("tab", { name: /Pre-approval Checklist/ }));
    const panel = screen.getByTestId("trade-request-checklist");
    for (const button of within(panel).getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(item("Meridian templates created for all accounts"));
    expect(m.write).not.toHaveBeenCalled();
    expect(within(panel).queryByText(/Read-only|checklist is locked/)).toBeNull();
    await act(async () => pending.resolve({ ok: true, checklist: STORED }));
    for (const button of within(panel).getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(item("Meridian templates created for all accounts"));
    expect(m.write).toHaveBeenLastCalledWith("REQ-SYN1", { key: "templates", checked: false, value: "Synthetic Template" });
  });

  it("after a failed load keeps items with a text field read-only and the others editable (AC-84)", async () => {
    m.read.mockResolvedValue({ ok: false, message: "Service Unavailable" });
    const { panel } = await openChecklist("OPERATIONS");
    for (const name of ["Meridian templates created for all accounts", "Transition used", "Advisor-instructed tickers traded"]) {
      expect((item(name) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(item(name));
    }
    expect(within(panel).queryByRole("textbox")).toBeNull();
    expect(m.write).not.toHaveBeenCalled();
    fireEvent.click(item("Asset location completed"));
    expect(item("Asset location completed").getAttribute("aria-pressed")).toBe("true");
    expect(m.write).toHaveBeenCalledWith("REQ-SYN1", { key: "asset_location", checked: true, value: "" });
  });

  it("does not save, or re-stamp, a text field that loses focus unchanged (AC-151)", async () => {
    const { panel } = await openChecklist("OPERATIONS");
    const field = within(panel).getByLabelText("Template name(s)") as HTMLTextAreaElement;
    fireEvent.focus(field);
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: "Synthetic Template v2" } });
    fireEvent.change(field, { target: { value: "Synthetic Template" } });
    fireEvent.blur(field);
    expect(m.write).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "Synthetic Template v2" } });
    fireEvent.blur(field);
    expect(m.write).toHaveBeenCalledTimes(1);
    await act(async () => undefined);
    fireEvent.blur(field);
    expect(m.write).toHaveBeenCalledTimes(1);
  });

  it("saves the text again on the next blur when the previous save failed", async () => {
    m.write.mockResolvedValueOnce({ ok: false, message: "Service Unavailable" });
    const { panel } = await openChecklist("OPERATIONS");
    const field = within(panel).getByLabelText("Template name(s)") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Synthetic Template v3" } });
    fireEvent.blur(field);
    await act(async () => undefined);
    fireEvent.blur(field);
    expect(m.write).toHaveBeenCalledTimes(2);
    expect(m.write).toHaveBeenLastCalledWith("REQ-SYN1", { key: "templates", checked: true, value: "Synthetic Template v3" });
  });

  it("is read-only for an advisor on any status (AC-86)", async () => {
    for (const status of ["Pending Review", "Approved"]) {
      const { panel, view } = await openChecklist("ADVISOR", { status });
      expect(within(panel).getByText("Read-only — only traders can update the checklist.")).toBeTruthy();
      expect(within(panel).queryByText("This request is closed; the checklist is locked.")).toBeNull();
      for (const button of within(panel).getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
      expect((within(panel).getByLabelText("Template name(s)") as HTMLTextAreaElement).disabled).toBe(true);
      fireEvent.click(item("Asset location completed"));
      expect(item("Asset location completed").getAttribute("aria-pressed")).toBe("false");
      expect(within(panel).getAllByText(/Checked by/)).toHaveLength(3);
      view.unmount();
    }
    expect(m.write).not.toHaveBeenCalled();
  });

  it("locks the checklist of a decided request for reviewers (AC-48, AC-87)", async () => {
    for (const status of ["Approved", "Rejected", "Completed"]) {
      const { panel, view } = await openChecklist("ADMIN", { status });
      expect(within(panel).getByText("This request is closed; the checklist is locked.")).toBeTruthy();
      for (const button of within(panel).getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
      const field = within(panel).getByLabelText("Template name(s)") as HTMLTextAreaElement;
      expect(field.disabled).toBe(true);
      fireEvent.blur(field);
      fireEvent.click(item("Asset location completed"));
      view.unmount();
    }
    expect(m.write).not.toHaveBeenCalled();
  });

  it("locks as soon as the request it shows becomes decided (terminal status wins)", async () => {
    const { view } = await openChecklist("OPERATIONS");
    expect(item("Asset location completed")).toHaveProperty("disabled", false);
    const decided = request({ status: "Approved" });
    view.rerender(createElement(RequestChecklistScope, {
      request: decided, role: "OPERATIONS",
      children: (checklist) => createElement(RequestDetailDialog, { request: decided, exporter: { name: "R", email: "r@example.invalid" }, onClose: vi.fn(), checklist }),
    }));
    expect(item("Asset location completed")).toHaveProperty("disabled", true);
    expect(screen.getByText("This request is closed; the checklist is locked.")).toBeTruthy();
    expect(m.read).toHaveBeenCalledTimes(1);
  });

  it("returns null from the summary hook outside a scope", () => {
    render(createElement(SummaryProbe));
    expect(screen.getByTestId("summary").textContent).toBe("none");
  });

  it("fills the direct-link route's checklist slot", async () => {
    render(createElement(RequestDetailRouteWithChecklist, {
      request: request(), accounts: [], exporter: { name: "Riley Ops", email: "ops@example.invalid" }, role: "ADVISOR",
    }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Pre-approval Checklist/ }).textContent).toBe("Pre-approval Checklist (5)"));
    fireEvent.click(screen.getByRole("tab", { name: /Pre-approval Checklist/ }));
    expect(screen.getByText("Read-only — only traders can update the checklist.")).toBeTruthy();
  });
});
