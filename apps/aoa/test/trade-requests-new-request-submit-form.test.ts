// @vitest-environment jsdom
import { Fragment, createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(authenticated)/trade-requests/checklist-actions", () => ({ readRequestChecklist: vi.fn(), writeRequestChecklistItem: vi.fn() }));
const m = vi.hoisted(() => ({
  load: vi.fn(), lookup: vi.fn(), prior: vi.fn(), clientExclusions: vi.fn(), accountExclusions: vi.fn(),
  submit: vi.fn(), resubmit: vi.fn(), push: vi.fn(), retry: vi.fn(),
}));
vi.mock("@/app/(authenticated)/trade-requests/new/actions", () => ({
  loadNewRequestClients: m.load,
  lookupNewRequestHouseholds: m.lookup,
  loadPriorAllocation: m.prior,
  loadClientExclusions: m.clientExclusions,
  loadAccountExclusions: m.accountExclusions,
  applyExclusionBatch: async () => ({ ok: false, message: "unused" }),
}));
vi.mock("@/app/(authenticated)/trade-requests/new/submit-actions", () => ({ submitNewRequest: m.submit, resubmitRequest: m.resubmit }));
vi.mock("@/app/(authenticated)/trade-requests/[id]/actions", () => ({ loadRequestPdfExclusions: async () => ({ ok: true, byAccountId: {} }) }));
vi.mock("@/app/(authenticated)/trade-requests/status-actions", () => ({ changeTradeRequestStatus: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push, refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/trade-requests/queue/QueueProvider", () => ({ useTradeRequestsQueue: () => ({ retry: m.retry }) }));

import { SessionMessagesProvider } from "@/components/trade-requests/bell/session-messages";
import { RequestDetailDialog } from "@/components/trade-requests/detail/RequestDetailDialog";
import { ResubmitCloneActions } from "@/components/trade-requests/detail/resubmit-clone-actions";
import { RequestStatusActions } from "@/components/trade-requests/detail/status-actions";
import { NewRequestDraftProvider } from "@/components/trade-requests/form/NewRequestDraft";
import { NewRequestSubmitForm, SourceRequestForm } from "@/components/trade-requests/form/submit/NewRequestSubmit";
import type { NewRequestClient } from "@/lib/trade-requests/new-request";
import type { TradeRequest } from "@/lib/trade-requests/request-types";

// ticket: submit, resubmit and clone in the form (AC-6, AC-8, AC-17, AC-18,
// AC-29, AC-91, AC-107, AC-120, AC-143, AC-144) and the detail view's
// Edit & Resubmit and Clone (AC-46, AC-47). Service calls are mocked;
// the browser spec runs them against a local service. Synthetic data.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENTS: NewRequestClient[] = [
  { id: "c-alex", name: "Maeve Brennan", accounts: [
    { id: "a1", accountNumber: "SYN00001", accountType: "Taxable", balance: 1_500 },
    { id: "a2", accountNumber: "SYN00002", accountType: "Roth IRA", balance: 2_500 }] },
  { id: "c-blair", name: "Lucille Howell", accounts: [{ id: "a3", accountNumber: "SYN00003", accountType: "Traditional IRA", balance: 4_000 }] },
];

function source(over: Partial<TradeRequest> = {}): TradeRequest {
  return {
    id: "REQ-SYN9", clientId: "c-alex", clientName: "Maeve Brennan", clientIds: ["c-alex"], clientNames: ["Maeve Brennan"],
    advisor: "Avery Stone", submittedBy: "Avery Stone", tradeType: "Rebalance", tradeAmount: "", depositAccount: "", rebalanceAll: true,
    status: "Needs Info", date: "2026-10-10T12:00:00.000Z", updatedAt: "2026-10-11T08:30:00.000Z", selectedAccounts: ["SYN00001"],
    totalValue: 1_500, priority: "Urgent", advisorNotes: "Recorded note", residence: "NY", liquidationApproval: "Yes",
    advisorExclusions: "TSLA (DNB - recorded)", clientExclusions: "AAPL (DNS - recorded)",
    esgFilters: { fossilFuels: true, tobacco: false, weapons: false, alcohol: false, gambling: false, other: false, otherDescription: "", none: false },
    riskProfile: 12, baseAllocation: { equity: 61, fixed: 34.5, cash: 4.5 },
    equityStrategies: [{ id: 1, benchmark: "SPY", allocation: 100, rationale: "Recorded rationale" }],
    raiseCashReason: "", liquidityDeadline: null, liquidateOption: "", liquidatePositions: "", auditLog: [],
    ...over,
  };
}

const field = (name: RegExp | string) => screen.getByLabelText(name) as HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
const change = (name: RegExp | string, value: string) => fireEvent.change(field(name), { target: { value } });
const button = (name: RegExp | string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const clientSelect = () => button(/Client \/ Household/);
const banner = () => screen.queryByText((_, el) => el?.id === "new-request-submit-error");

async function openNew() {
  render(createElement(NewRequestDraftProvider, null, createElement(NewRequestSubmitForm)));
  await screen.findByRole("heading", { name: "New Trade Request" });
}
async function openSource(mode: "edit" | "clone", request: TradeRequest) {
  render(createElement(SourceRequestForm, { mode, source: request }));
  await screen.findByRole("heading", { name: mode === "edit" ? `Resubmit: ${request.id}` : `Clone from ${request.id}` });
}
function fillRaiseCash() {
  change("Trade Type", "Raise Cash");
  fireEvent.click(clientSelect());
  fireEvent.click(within(screen.getByRole("listbox", { name: "Client list" })).getByRole("checkbox", { name: /Maeve Brennan/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /SYN00001/ }));
  change(/^Priority/, "Standard");
  change(/^Cash Amount to Raise/, "$50,000");
  change(/^Reason for Cash Raise/, "Synthetic distribution");
  change("Advisor Compliance & Execution Notes", "Synthetic notes");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
});
beforeEach(() => {
  window.sessionStorage.clear();
  m.load.mockResolvedValue({ ok: true, clients: CLIENTS });
  m.lookup.mockResolvedValue({ households: [] });
  m.prior.mockResolvedValue(null);
  m.clientExclusions.mockResolvedValue({ ok: true, data: {} });
  m.accountExclusions.mockResolvedValue({ ok: true, data: {} });
  m.submit.mockResolvedValue({ ok: true, id: "REQ-NEW1" });
  m.resubmit.mockResolvedValue({ ok: true, id: "REQ-SYN9" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("new request submit (AC-6, AC-29, AC-8, AC-144)", () => {
  it("creates once with a key, shows Submitting..., then refreshes and opens the queue", async () => {
    await openNew();
    fillRaiseCash();
    const pending = deferred<{ ok: true; id: string }>();
    m.submit.mockReturnValueOnce(pending.promise);
    fireEvent.click(button("Submit Trade Request"));
    fireEvent.click(button("Submitting..."));
    expect(button("Submitting...").disabled).toBe(true);
    expect(m.submit).toHaveBeenCalledTimes(1);
    const [payload, key] = m.submit.mock.calls[0];
    expect(key).toMatch(UUID);
    expect(window.sessionStorage.getItem("trade-requests:idempotency:new")).toBe(key);
    expect(payload).toMatchObject({
      clientId: "c-alex", clientName: "Maeve Brennan", tradeType: "Raise Cash", tradeAmount: "$50,000", raiseCashReason: "Synthetic distribution",
      advisorNotes: "Synthetic notes", priority: "Standard", selectedAccounts: ["SYN00001"], residence: "Other", isClone: false, existingId: null,
    });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await act(async () => pending.resolve({ ok: true, id: "REQ-NEW1" }));
    expect(button("Submitting...").disabled).toBe(true);
    fireEvent.click(button("Submitting..."));
    expect(m.submit).toHaveBeenCalledTimes(1);
    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(m.push).toHaveBeenCalledWith("/trade-requests/queue");
    expect(window.sessionStorage.getItem("trade-requests:idempotency:new")).toBeNull();
  });

  it("a rejection shows the service's message, keeps every value and retries with the same key", async () => {
    await openNew();
    fillRaiseCash();
    m.submit.mockResolvedValueOnce({ ok: false, message: "Validation failed: advisorNotes: String must contain at most 5000 character(s)" });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    fireEvent.click(button("Submit Trade Request"));
    await waitFor(() => expect(banner()?.textContent).toBe("Validation failed: advisorNotes: String must contain at most 5000 character(s)"));
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    expect(scroll.mock.contexts[0]).toBe(banner());
    expect(banner()?.getAttribute("role")).toBe("alert");
    expect(button("Submit Trade Request").getAttribute("aria-describedby")).toContain("new-request-submit-error");
    expect(field(/^Cash Amount to Raise/).value).toBe("$50,000");
    expect(field(/^Reason for Cash Raise/).value).toBe("Synthetic distribution");
    expect(field("Advisor Compliance & Execution Notes").value).toBe("Synthetic notes");
    expect(field(/^Priority/).value).toBe("Standard");
    expect((screen.getByRole("checkbox", { name: /SYN00001/ }) as HTMLInputElement).checked).toBe(true);
    expect(m.push).not.toHaveBeenCalled();
    expect(m.retry).not.toHaveBeenCalled();

    m.submit.mockResolvedValueOnce({ ok: false, message: "timeout of 120000ms exceeded" });
    fireEvent.click(button("Submit Trade Request"));
    await waitFor(() => expect(banner()?.textContent).toBe("timeout of 120000ms exceeded"));
    expect(m.submit.mock.calls[1][1]).toBe(m.submit.mock.calls[0][1]);
  });

  it("no message, or an action that never answers, shows the default failure text (AC-144)", async () => {
    await openNew();
    fillRaiseCash();
    m.submit.mockResolvedValueOnce({ ok: false, message: "" });
    fireEvent.click(button("Submit Trade Request"));
    await waitFor(() => expect(banner()?.textContent).toBe("Failed to submit request. Please try again."));
    m.submit.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(button("Submit Trade Request"));
    await waitFor(() => expect(m.submit).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(banner()?.textContent).toBe("Failed to submit request. Please try again."));
    expect(field(/^Cash Amount to Raise/).value).toBe("$50,000");
  });

  it("the pending key survives a remount until a success", async () => {
    window.sessionStorage.setItem("trade-requests:idempotency:new", "11111111-2222-4333-8444-555555555555");
    await openNew();
    fillRaiseCash();
    fireEvent.click(button("Submit Trade Request"));
    await waitFor(() => expect(m.push).toHaveBeenCalled());
    expect(m.submit.mock.calls[0][1]).toBe("11111111-2222-4333-8444-555555555555");
  });
});

describe("Edit & Resubmit form (AC-17, AC-91, AC-107, AC-120, AC-143)", () => {
  it("is prefilled, keeps the client unchangeable and the recorded exclusions, and offers no Manage actions", async () => {
    await openSource("edit", source());
    expect(clientSelect().disabled).toBe(true);
    expect(clientSelect().textContent).toContain("Maeve Brennan");
    expect(screen.queryByRole("button", { name: "Enter manually" })).toBeNull();
    expect((screen.getByRole("checkbox", { name: /SYN00001/ }) as HTMLInputElement).checked).toBe(true);
    expect(field("Trade Type").value).toBe("Rebalance");
    expect(field(/^Priority/).value).toBe("Urgent");
    expect(field("Advisor Specific Exclusions").value).toBe("TSLA (DNB - recorded)");
    expect(field("Client Requested Exclusions").value).toBe("AAPL (DNS - recorded)");
    const manage = button(/Manage exclusions/);
    expect(manage.disabled).toBe(true);
    expect(manage.title).toBe("Standing list is disabled in edit / clone mode");
    expect(screen.queryByRole("button", { name: "Manage Account Restrictions" })).toBeNull();
    expect(screen.queryByText("This client has an existing allocation on file.")).toBeNull();
    expect(screen.getByRole("heading", { name: /Mandate & Base Allocation/ })).toBeTruthy();
    await waitFor(() => expect(m.prior).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(m.clientExclusions).not.toHaveBeenCalled();
    expect(m.lookup).not.toHaveBeenCalled();
    expect(field("Advisor Specific Exclusions").value).toBe("TSLA (DNB - recorded)");
  });

  it("resubmits the edited values with the version it opened on, then opens the queue", async () => {
    await openSource("edit", source());
    change("Advisor Compliance & Execution Notes", "Edited synthetic note");
    change(/^Priority/, "Low");
    fireEvent.click(button("Resubmit to Trader"));
    await waitFor(() => expect(m.push).toHaveBeenCalledWith("/trade-requests/queue"));
    expect(m.submit).not.toHaveBeenCalled();
    const [id, payload, version] = m.resubmit.mock.calls[0];
    expect(id).toBe("REQ-SYN9");
    expect(version).toBe("2026-10-11T08:30:00.000Z");
    expect(payload).toMatchObject({
      existingId: "REQ-SYN9", isClone: false, advisorNotes: "Edited synthetic note", priority: "Low", householdId: null,
      advisorExclusions: "TSLA (DNB - recorded)", tradeAmount: "", depositAccount: "",
    });
    expect(m.retry).toHaveBeenCalledTimes(1);
  });

  it("a stale resubmission shows the service's message and keeps the edits", async () => {
    await openSource("edit", source());
    change("Advisor Compliance & Execution Notes", "Edited synthetic note");
    m.resubmit.mockResolvedValueOnce({ ok: false, message: "Request was modified by another user. Please refresh and try again." });
    fireEvent.click(button("Resubmit to Trader"));
    await waitFor(() => expect(banner()?.textContent).toBe("Request was modified by another user. Please refresh and try again."));
    expect(field("Advisor Compliance & Execution Notes").value).toBe("Edited synthetic note");
    expect(m.push).not.toHaveBeenCalled();
  });

  it("Cancel returns to the queue without a call", async () => {
    await openSource("edit", source());
    fireEvent.click(button("Cancel"));
    expect(m.push).toHaveBeenCalledWith("/trade-requests/queue");
    expect(m.resubmit).not.toHaveBeenCalled();
  });
});

describe("Clone to New Request form (AC-18, AC-91, AC-120, AC-143)", () => {
  it("is prefilled from the source, the client stays changeable, and it creates a new request marked as a clone", async () => {
    await openSource("clone", source({ status: "Rejected" }));
    expect(clientSelect().disabled).toBe(false);
    expect(button("Enter manually")).toBeTruthy();
    expect(field("Trade Type").value).toBe("Rebalance");
    expect(field("State Residence").value).toBe("NY");
    expect(field("Liquidation Approval").value).toBe("Yes");
    expect(field("Client Risk Score").value).toBe("12");
    expect(field(/^Strategy Rationale/).value).toBe("Recorded rationale");
    expect(field("Advisor Compliance & Execution Notes").value).toBe("Recorded note");
    expect(field("Advisor Specific Exclusions").value).toBe("TSLA (DNB - recorded)");
    expect(button(/Manage exclusions/).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Manage Account Restrictions" })).toBeNull();
    expect(button("Cancel")).toBeTruthy();
    await waitFor(() => expect(m.lookup).toHaveBeenCalled());
    expect(m.clientExclusions).not.toHaveBeenCalled();

    fireEvent.click(button("Submit Trade Request"));
    await waitFor(() => expect(m.push).toHaveBeenCalledWith("/trade-requests/queue"));
    const [payload, key] = m.submit.mock.calls[0];
    expect(key).toMatch(UUID);
    expect(payload).toMatchObject({
      isClone: true, existingId: null, clientId: "c-alex", tradeType: "Rebalance", residence: "NY", riskProfile: 12,
      equityStrategies: [{ id: 1, benchmark: "SPY", allocation: 100, rationale: "Recorded rationale" }],
      advisorExclusions: "TSLA (DNB - recorded)", clientExclusions: "AAPL (DNS - recorded)",
    });
    expect(m.resubmit).not.toHaveBeenCalled();
  });
});

describe("detail actions (AC-46, AC-47)", () => {
  const exporter = { name: "Avery Stone", email: "advisor@example.invalid" };
  function openDetail(role: string, status: string) {
    render(createElement(RequestDetailDialog, {
      request: source({ status }), exporter, onClose: vi.fn(), actions: createElement(ResubmitCloneActions, { role }),
    }));
  }
  const slot = () => within(document.querySelector('[data-slot="request-actions"]') as HTMLElement);

  it("ADVISOR on Needs Info: Edit & Resubmit opens the edit form", async () => {
    openDetail("ADVISOR", "Needs Info");
    const edit = await waitFor(() => slot().getByRole("button", { name: "Edit & Resubmit" }));
    expect(edit.getAttribute("title")).toBe("Revise and resubmit this request for trader review");
    expect(slot().queryByRole("button", { name: "Clone to New Request" })).toBeNull();
    fireEvent.click(edit);
    expect(m.push).toHaveBeenCalledWith("/trade-requests/new/edit/REQ-SYN9");
  });

  it("ADVISOR on Rejected: Clone to New Request opens the clone form", async () => {
    openDetail("ADVISOR", "Rejected");
    const clone = await waitFor(() => slot().getByRole("button", { name: "Clone to New Request" }));
    expect(clone.getAttribute("title")).toBe("Create a new request pre-filled from this one");
    expect(slot().queryByRole("button", { name: "Edit & Resubmit" })).toBeNull();
    fireEvent.click(clone);
    expect(m.push).toHaveBeenCalledWith("/trade-requests/new/clone/REQ-SYN9");
  });

  it("composed with the reviewer status actions, each role sees only its own (AC-43, AC-46, AC-47)", async () => {
    const composed = (role: string, status: string) => {
      render(createElement(SessionMessagesProvider, null, createElement(RequestDetailDialog, {
        request: source({ status }), exporter, onClose: vi.fn(),
        actions: createElement(Fragment, null, createElement(RequestStatusActions, { role }), createElement(ResubmitCloneActions, { role })),
      })));
    };
    const names = async () => {
      await screen.findByTestId("trade-request-detail");
      return slot().queryAllByRole("button").map((b) => b.textContent);
    };
    composed("ADVISOR", "Needs Info");
    expect(await names()).toEqual(["Edit & Resubmit"]);
    cleanup();
    composed("OPERATIONS", "Needs Info");
    expect(await names()).toEqual(["Needs Info", "Pending Liquidation", "Reject", "Approve & Execute"]);
    cleanup();
    composed("ADVISOR", "Rejected");
    expect(await names()).toEqual(["Clone to New Request"]);
    cleanup();
    composed("ADMIN", "Rejected");
    expect(await names()).toEqual([]);
  });

  it("no advisor action for reviewers, or on any other status", async () => {
    for (const [role, status] of [
      ["ADMIN", "Needs Info"], ["OPERATIONS", "Needs Info"], ["ADMIN", "Rejected"], ["OPERATIONS", "Rejected"],
      ["ADVISOR", "Pending Review"], ["ADVISOR", "Approved"], ["ADVISOR", "Completed"], ["ADVISOR", "Pending Current Asset Liquidation"],
    ]) {
      openDetail(role, status);
      await screen.findByTestId("trade-request-detail");
      expect(slot().queryAllByRole("button")).toHaveLength(0);
      cleanup();
    }
  });
});
