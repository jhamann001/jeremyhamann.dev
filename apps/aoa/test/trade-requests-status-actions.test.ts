// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), pdf: vi.fn(), change: vi.fn(), retry: vi.fn(), close: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/(authenticated)/trade-requests/checklist-actions", () => ({ readRequestChecklist: m.read, writeRequestChecklistItem: m.write }));
vi.mock("@/app/(authenticated)/trade-requests/[id]/actions", () => ({ loadRequestPdfExclusions: m.pdf }));
vi.mock("@/app/(authenticated)/trade-requests/status-actions", () => ({ changeTradeRequestStatus: m.change }));
vi.mock("@/components/trade-requests/queue/QueueProvider", () => ({ useTradeRequestsQueue: () => ({ retry: m.retry }) }));

import { RequestDetailDialog } from "@/components/trade-requests/detail/RequestDetailDialog";
import { RequestStatusActions } from "@/components/trade-requests/detail/status-actions";
import { RequestChecklistScope } from "@/components/trade-requests/checklist/RequestChecklistScope";
import { SessionMessagesProvider, useSessionMessages } from "@/components/trade-requests/bell/session-messages";
import type { TradeRequest } from "@/lib/trade-requests/request-types";

// ticket: reviewer status actions in the request frame's actions slot —
// availability (AC-43, AC-13), note form (AC-105), approve warning (AC-88,
// AC-89), the change itself (AC-11, AC-106) and failures (AC-101, AC-102).
// Synthetic data.

const UPDATED_AT = "2026-10-15T15:00:00.123Z";

function request(overrides: Partial<TradeRequest> = {}): TradeRequest {
  return {
    id: "REQ-SYN1", clientId: "HH-1", clientName: "Synthetic Family", clientIds: ["HH-1"], clientNames: ["Synthetic Family"],
    advisor: "Rachel Moss", submittedBy: "Avery Stone", tradeType: "Rebalance", tradeAmount: "", depositAccount: "",
    rebalanceAll: false, status: "Pending Review", date: "2026-10-15T14:00:00.000Z", updatedAt: UPDATED_AT,
    selectedAccounts: ["SYN-1"], totalValue: 50000, priority: "Normal", advisorNotes: "Synthetic note", residence: "",
    liquidationApproval: "", advisorExclusions: "", clientExclusions: "", esgFilters: {}, riskProfile: null, baseAllocation: null,
    equityStrategies: [], raiseCashReason: "", liquidityDeadline: null, liquidateOption: "", liquidatePositions: "",
    accountMetadata: [{ accountId: "ulid-1", accountNumber: "SYN-1", accountType: "Taxable", balance: 50000 }],
    auditLog: [{ id: "a1", date: "2026-10-15T14:00:00.000Z", user: "Avery Stone", action: "Request Created", notes: "Initial" }],
    ...overrides,
  };
}

const CHECKED = { checked: true, value: "", by: "Riley Ops", at: UPDATED_AT };

function SessionProbe() {
  const { messages } = useSessionMessages();
  return createElement("ul", { "data-testid": "session-messages" }, messages.map((item) => createElement("li", { key: item.id }, item.message)));
}

function view(role: string, overrides: Partial<TradeRequest> = {}) {
  const value = request(overrides);
  const tree = (req: TradeRequest | null) => createElement(SessionMessagesProvider, null,
    req && createElement(RequestChecklistScope, {
      key: req.id, request: req, role,
      children: (checklist) => createElement(RequestDetailDialog, {
        request: req, exporter: { name: "Riley Ops", email: "ops@example.invalid" }, onClose: m.close, checklist,
        actions: createElement(RequestStatusActions, { role }),
      }),
    }),
    createElement(SessionProbe),
  );
  const rendered = render(tree(value));
  return {
    ...rendered,
    update: (next: Partial<TradeRequest>) => rendered.rerender(tree(request({ ...overrides, ...next }))),
    /** Unmounts the request (as Close does) while the providers above it stay. */
    closeRequest: () => rendered.rerender(tree(null)),
  };
}

const footer = () => screen.getByTestId("trade-request-detail").querySelector("footer") as HTMLElement;
const settled = () => waitFor(() => expect(m.read).toHaveBeenCalled());

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
});
beforeEach(() => {
  vi.resetAllMocks();
  m.read.mockResolvedValue({ ok: true, checklist: {} });
  m.change.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("availability (ticket)", () => {
  it.each(["ADMIN", "OPERATIONS"])("gives %s the four actions with their tooltips on an undecided request (AC-43)", async (role) => {
    for (const status of ["Pending Review", "Needs Info", "Pending Current Asset Liquidation"]) {
      const { unmount } = view(role, { status });
      await settled();
      const buttons = within(screen.getByTestId("trade-request-status-actions")).getAllByRole("button");
      expect(buttons.map((button) => [button.textContent, button.title])).toEqual([
        ["Needs Info", "Return to advisor for more details"],
        ["Pending Liquidation", "Mark as pending existing asset liquidation"],
        ["Reject", "Permanently reject — record will be locked"],
        ["Approve & Execute", "Approve and send to execution"],
      ]);
      expect(within(footer()).getByRole("button", { name: "Close" })).toBeTruthy();
      unmount();
    }
  });

  it.each(["Approved", "Rejected", "Completed"])("shows no status action on a %s request (AC-13)", async (status) => {
    view("ADMIN", { status });
    await settled();
    expect(screen.queryByTestId("trade-request-status-actions")).toBeNull();
    expect(within(footer()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Close"]);
  });

  it.each(["ADVISOR", "CLIENT_SERVICE", "VIEWER"])("shows no status action to %s", async (role) => {
    view(role);
    await settled();
    expect(screen.queryByTestId("trade-request-status-actions")).toBeNull();
  });

  it("removes the actions, and an open note form, when the shown request becomes decided (AC-13)", async () => {
    const { update } = view("OPERATIONS");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByTestId("trade-request-status-form")).toBeTruthy();
    update({ status: "Approved" });
    expect(screen.queryByTestId("trade-request-status-form")).toBeNull();
    expect(screen.queryByTestId("trade-request-status-actions")).toBeNull();
  });
});

describe("note form (ticket)", () => {
  it("asks for an optional note with Cancel and Confirm before changing anything (AC-105)", async () => {
    view("ADMIN");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Needs Info" }));
    const form = screen.getByTestId("trade-request-status-form");
    const input = within(form).getByLabelText("Add Note for Audit/Advisor:") as HTMLInputElement;
    expect(input.placeholder).toBe("e.g., Client needs to sign form first...");
    expect(document.activeElement).toBe(input);
    expect(within(form).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Confirm"]);
    expect(screen.queryByTestId("trade-request-status-actions")).toBeNull();
    expect(screen.queryByTestId("trade-request-approve-warning")).toBeNull();
    expect(m.change).not.toHaveBeenCalled();
  });

  it("Cancel returns to the actions without a change", async () => {
    view("ADMIN");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("trade-request-status-actions")).toBeTruthy();
    expect(m.change).not.toHaveBeenCalled();
  });

  it("confirms with the note and the stale-change stamp, then reloads the queue and closes (AC-11)", async () => {
    let finish!: (value: { ok: true }) => void;
    m.change.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    view("OPERATIONS");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Pending Liquidation" }));
    fireEvent.change(screen.getByLabelText("Add Note for Audit/Advisor:"), { target: { value: "Synthetic liquidation note" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    const processing = screen.getByRole("button", { name: "Processing..." }) as HTMLButtonElement;
    expect(processing.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(processing);
    expect(m.change).toHaveBeenCalledTimes(1);
    expect(m.change).toHaveBeenCalledWith("REQ-SYN1", {
      status: "Pending Current Asset Liquidation", note: "Synthetic liquidation note", expectedUpdatedAt: UPDATED_AT,
    });
    finish({ ok: true });
    await waitFor(() => expect(m.close).toHaveBeenCalledTimes(1));
    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId("session-messages")).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("sends an empty note when none is given (AC-106)", async () => {
    view("ADMIN");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(m.close).toHaveBeenCalled());
    expect(m.change).toHaveBeenCalledWith("REQ-SYN1", { status: "Rejected", note: "", expectedUpdatedAt: UPDATED_AT });
  });
});

describe("approve warning (ticket)", () => {
  it("counts the unchecked items and still allows the approval (AC-88, AC-89)", async () => {
    m.read.mockResolvedValue({ ok: true, checklist: { exclusions: CHECKED, templates: CHECKED } });
    view("ADMIN");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Pre-approval Checklist (5)" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approve & Execute" }));
    expect(screen.getByTestId("trade-request-approve-warning").textContent).toBe(
      "5 checklist items are still unchecked. You can approve anyway — confirm below — or finish the pre-approval checklist first.",
    );
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(m.change).toHaveBeenCalledWith("REQ-SYN1", { status: "Approved", note: "", expectedUpdatedAt: UPDATED_AT }));
  });

  it("uses the singular form for one item", async () => {
    const six = ["exclusions", "templates", "asset_location", "transition", "legacy_liquidation", "residual_cash"];
    m.read.mockResolvedValue({ ok: true, checklist: Object.fromEntries(six.map((key) => [key, CHECKED])) });
    view("ADMIN");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Pre-approval Checklist (1)" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approve & Execute" }));
    expect(screen.getByTestId("trade-request-approve-warning").textContent).toMatch(/^1 checklist item is still unchecked\. You can approve anyway/);
  });

  it("counts all seven as unchecked when the checklist failed to load (AC-88, epic AC-84)", async () => {
    m.read.mockResolvedValue({ ok: false, message: "Failed to load request. Please try again." });
    view("OPERATIONS");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Approve & Execute" }));
    expect(screen.getByTestId("trade-request-approve-warning").textContent).toMatch(/^7 checklist items are still unchecked\./);
  });

  it("shows no warning once every item is checked", async () => {
    const all = ["exclusions", "templates", "asset_location", "transition", "legacy_liquidation", "residual_cash", "advisor_tickers"];
    m.read.mockResolvedValue({ ok: true, checklist: Object.fromEntries(all.map((key) => [key, CHECKED])) });
    view("ADMIN");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Pre-approval Checklist" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approve & Execute" }));
    expect(screen.queryByTestId("trade-request-approve-warning")).toBeNull();
  });

  it("its link closes the form and opens the checklist tab", async () => {
    view("ADMIN");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Approve & Execute" }));
    fireEvent.click(screen.getByRole("button", { name: "pre-approval checklist" }));
    expect(screen.getByRole("tab", { name: /Pre-approval Checklist/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("trade-request-status-actions")).toBeTruthy();
    expect(m.change).not.toHaveBeenCalled();
  });
});

describe("closed while the change runs (ticket)", () => {
  function pending() {
    let finish!: (value: { ok: true } | { ok: false; message: string }) => void;
    m.change.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    return (value: { ok: true } | { ok: false; message: string }) => finish(value);
  }

  it("still adds the session message for a failure that arrives after the request closed (AC-102)", async () => {
    const finish = pending();
    const { closeRequest } = view("ADMIN");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    closeRequest();
    expect(screen.queryByTestId("trade-request-detail")).toBeNull();
    finish({ ok: false, message: "Cannot modify a rejected request." });
    await waitFor(() => expect(within(screen.getByTestId("session-messages")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["Status update failed: Cannot modify a rejected request."]));
    expect(m.retry).not.toHaveBeenCalled();
  });

  it("still reloads the queue for a success that arrives after the request closed, without closing again", async () => {
    const finish = pending();
    const { closeRequest } = view("OPERATIONS");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Needs Info" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    closeRequest();
    finish({ ok: true });
    await waitFor(() => expect(m.retry).toHaveBeenCalledTimes(1));
    expect(m.close).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("session-messages")).queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("failures (ticket)", () => {
  it("shows the service's message in the action panel and adds the session message (AC-101, AC-102)", async () => {
    const stale = "Request was modified by another user. Please refresh and try again.";
    m.change.mockResolvedValue({ ok: false, message: stale });
    view("ADMIN");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Approve & Execute" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(within(footer()).getByRole("alert").textContent).toBe(stale));
    expect(within(screen.getByTestId("session-messages")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual([`Status update failed: ${stale}`]);
    expect(screen.getByTestId("trade-request-status-form")).toBeTruthy();
    expect(m.close).not.toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(within(footer()).queryByRole("alert")).toBeNull();
  });

  it("defaults to \"Action failed. Please try again.\" when the call itself fails (AC-101, AC-102)", async () => {
    m.change.mockRejectedValue(new Error("synthetic transport failure"));
    view("OPERATIONS");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Needs Info" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(within(footer()).getByRole("alert").textContent).toBe("Action failed. Please try again."));
    expect(within(screen.getByTestId("session-messages")).getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["Status update failed: Action failed. Please try again."]);
  });

  it("clears the previous failure when confirming again", async () => {
    m.change.mockResolvedValueOnce({ ok: false, message: "Cannot modify a rejected request." }).mockResolvedValueOnce({ ok: true });
    view("ADMIN");
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(within(footer()).getByRole("alert")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(m.close).toHaveBeenCalled());
    expect(within(footer()).queryByRole("alert")).toBeNull();
  });
});
