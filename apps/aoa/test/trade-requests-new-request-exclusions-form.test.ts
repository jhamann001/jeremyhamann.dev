// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  load: vi.fn(), lookup: vi.fn(), prior: vi.fn(), clientExclusions: vi.fn(), accountExclusions: vi.fn(), apply: vi.fn(),
}));
vi.mock("@/app/(authenticated)/trade-requests/new/actions", () => ({
  loadNewRequestClients: actions.load,
  lookupNewRequestHouseholds: actions.lookup,
  loadPriorAllocation: actions.prior,
  loadClientExclusions: actions.clientExclusions,
  loadAccountExclusions: actions.accountExclusions,
  applyExclusionBatch: actions.apply,
}));

import { NewRequestDraftProvider } from "@/components/trade-requests/form/NewRequestDraft";
import { NewRequestForm } from "@/components/trade-requests/form/NewRequestForm";
import type { NewRequestClient } from "@/lib/trade-requests/new-request";
import type { StandingExclusion } from "@/lib/trade-requests/new-request-exclusions";

// ticket: standing-exclusion fill (AC-90), account panel (AC-92, AC-111),
// Manage exclusions and Manage Account Restrictions (AC-118, AC-119, AC-121,
// AC-146). Synthetic data.

const CLIENTS: NewRequestClient[] = [
  { id: "c-alex", name: "Maeve Brennan", accounts: [
    { id: "a1", accountNumber: "SYN00001", accountType: "Taxable", balance: 1_500 },
    { id: "a2", accountNumber: "SYN00002", accountType: "Roth IRA", balance: 2_500 }] },
  { id: "c-blair", name: "Lucille Howell", accounts: [{ id: "a3", accountNumber: "SYN00003", accountType: "Traditional IRA", balance: 4_000 }] },
];
const row = (over: Partial<StandingExclusion>): StandingExclusion => ({
  id: "x", ticker: "TSLA", kind: "advisor", reason: "", noBuy: true, noSell: true, createdByName: "Avery Stone", createdAt: "2026-10-01T12:00:00Z", ...over,
});
let standing: Record<string, StandingExclusion[]>;
let accounts: Record<string, StandingExclusion[]>;

const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLTextAreaElement;
const advisor = () => field("Advisor Specific Exclusions");
const client = () => field("Client Requested Exclusions");
const manage = () => screen.getByRole("button", { name: /Manage exclusions/ }) as HTMLButtonElement;
const dialog = () => within(screen.getByTestId("manage-exclusions-dialog"));
const panel = () => within(screen.getByTestId("account-exclusions"));

async function openForm() {
  render(createElement(NewRequestDraftProvider, null, createElement(NewRequestForm)));
  await screen.findByRole("heading", { name: "New Trade Request" });
}
function toggleClient(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /Client \/ Household/ }));
  fireEvent.click(within(screen.getByRole("listbox", { name: "Client list" })).getByRole("checkbox", { name: new RegExp(name) }));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}
const tickAccount = (number: string) => fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(number) }));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
});
beforeEach(() => {
  standing = {
    "c-alex": [row({ id: "s1", ticker: "TSLA", reason: "Concentration risk", noSell: false }), row({ id: "s2", ticker: "AAPL", kind: "client", reason: "Employer stock" })],
    "c-blair": [row({ id: "s3", ticker: "XOM", noBuy: false })],
  };
  accounts = { a1: [row({ id: "r1", ticker: "GME", reason: "" , noSell: false })], a2: [], a3: [row({ id: "r2", ticker: "AMC", reason: "Imported from /data/restrictions.csv" })] };
  actions.load.mockResolvedValue({ ok: true, clients: CLIENTS });
  actions.lookup.mockResolvedValue({ households: [] });
  actions.prior.mockResolvedValue(null);
  actions.clientExclusions.mockImplementation(async (ids: string[]) => ({ ok: true, data: Object.fromEntries(ids.map((id) => [id, standing[id] ?? []])) }));
  actions.accountExclusions.mockImplementation(async (ids: string[]) => ({ ok: true, data: Object.fromEntries(ids.map((id) => [id, accounts[id] ?? []])) }));
  actions.apply.mockImplementation(async (scope: string, id: string) => {
    if (scope === "client") standing[id] = [...(standing[id] ?? []), row({ id: "new", ticker: "NVDA", kind: "client", noBuy: true, noSell: false })];
    else accounts[id] = [...(accounts[id] ?? []), row({ id: "new", ticker: "NVDA", noBuy: false })];
    return { ok: true, data: { exclusions: scope === "client" ? standing[id] : accounts[id], added: 1, removed: 0, edited: 0 } };
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("standing-list fill (AC-90)", () => {
  it("fills the fields from one client's lists, then attributes entries per client when several are selected", async () => {
    await openForm();
    expect(advisor().placeholder).toBe("e.g., TSLA (Concentration risk)");
    expect(client().placeholder).toBe("e.g., AAPL (Employer stock)");
    toggleClient("Maeve Brennan");
    await waitFor(() => expect(advisor().value).toBe("TSLA (DNB - Concentration risk)"));
    expect(client().value).toBe("AAPL (DNB+DNS - Employer stock)");
    expect(actions.clientExclusions).toHaveBeenLastCalledWith(["c-alex"]);
    toggleClient("Lucille Howell");
    await waitFor(() => expect(advisor().value).toBe("TSLA (DNB - Concentration risk – Maeve Brennan); XOM (DNS – Lucille Howell)"));
    expect(client().value).toBe("AAPL (DNB+DNS - Employer stock – Maeve Brennan)");
    expect(actions.clientExclusions).toHaveBeenLastCalledWith(["c-alex", "c-blair"]);
  });

  it("keeps a field the user typed over while refilling the untouched one", async () => {
    await openForm();
    toggleClient("Maeve Brennan");
    await waitFor(() => expect(advisor().value).not.toBe(""));
    fireEvent.change(advisor(), { target: { value: "My own note" } });
    toggleClient("Lucille Howell");
    await waitFor(() => expect(client().value).toBe("AAPL (DNB+DNS - Employer stock – Maeve Brennan)"));
    expect(advisor().value).toBe("My own note");
  });

  it("keeps the fields when everyone is deselected, in manual entry, and when the read fails, noting a failed read", async () => {
    await openForm();
    toggleClient("Maeve Brennan");
    await waitFor(() => expect(advisor().value).not.toBe(""));
    toggleClient("Maeve Brennan");
    await act(async () => undefined);
    expect(advisor().value).toBe("TSLA (DNB - Concentration risk)");
    actions.clientExclusions.mockResolvedValueOnce({ ok: false, message: "Network Error" });
    toggleClient("Lucille Howell");
    await waitFor(() => expect(actions.clientExclusions).toHaveBeenLastCalledWith(["c-blair"]));
    expect((await screen.findByTestId("exclusions-notice")).textContent).toBe("Couldn't load standing exclusions — review the fields.");
    expect(advisor().value).toBe("TSLA (DNB - Concentration risk)");
    fireEvent.change(advisor(), { target: { value: "TSLA (DNB - Concentration risk) " } });
    expect(screen.queryByTestId("exclusions-notice")).toBeNull();
    const calls = actions.clientExclusions.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
    await act(async () => undefined);
    expect(actions.clientExclusions.mock.calls.length).toBe(calls);
  });
});

describe("Manage exclusions (AC-118, AC-119)", () => {
  it("is disabled until a listed client is selected", async () => {
    await openForm();
    expect(manage().disabled).toBe(true);
    expect(manage().title).toBe("Select a client first");
    toggleClient("Maeve Brennan");
    expect(manage().disabled).toBe(false);
    expect(manage().title).toBe("Add or remove standing exclusions for this client without submitting a trade request");
  });

  it("adds, removes and re-sides standing exclusions in one batch, then replaces the fields on close", async () => {
    await openForm();
    toggleClient("Maeve Brennan");
    await waitFor(() => expect(advisor().value).not.toBe(""));
    fireEvent.change(advisor(), { target: { value: "typed over" } });
    fireEvent.click(manage());
    expect(dialog().getByRole("heading", { name: "Manage Exclusions" })).toBeTruthy();
    expect(dialog().getByText("for", { exact: false }).textContent).toBe("for Maeve Brennan");
    await dialog().findByText("TSLA");
    expect(dialog().getByRole("region", { name: "Advisor Specific Exclusions" })).toBeTruthy();
    expect(dialog().getByText("— Concentration risk")).toBeTruthy();
    expect(dialog().getAllByText(/^added by Avery Stone, /)).toHaveLength(2);
    expect(dialog().queryByRole("tablist")).toBeNull();

    const dnb = dialog().getByLabelText("TSLA: do not buy") as HTMLInputElement;
    fireEvent.click(dnb);
    expect(dnb.checked).toBe(true);
    expect(dnb.closest("label")?.title).toBe("At least one of DNB or DNS must stay checked");
    fireEvent.click(dialog().getByLabelText("TSLA: do not sell"));
    expect(dialog().getByText("Side change pending: DNB → DNB+DNS")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Mark AAPL for removal" }));
    expect(dialog().getByText("Marked for removal — click Apply to commit, or click the icon again to keep")).toBeTruthy();

    const clientSection = within(dialog().getByRole("region", { name: "Client Requested Exclusions" }));
    fireEvent.click(clientSection.getByRole("button", { name: /Add row/ }));
    expect(clientSection.getByRole("alert").textContent).toBe("Pick at least one of DNB or DNS to enable Apply.");
    const apply = dialog().getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;
    expect(apply.textContent).toBe("Apply 3 changes");
    expect(apply.disabled).toBe(true);
    fireEvent.change(clientSection.getByLabelText("Ticker for new client exclusion"), { target: { value: "nvda" } });
    fireEvent.click(clientSection.getByLabelText("New client exclusion: do not buy"));
    expect(apply.disabled).toBe(false);
    expect(dialog().getByRole("button", { name: /Discard 3 pending/ })).toBeTruthy();
    fireEvent.click(apply);
    await dialog().findByText("Saved. Added 1.");
    expect(actions.apply).toHaveBeenCalledWith("client", "c-alex", {
      add: [{ ticker: "NVDA", kind: "client", reason: "", noBuy: true, noSell: false }],
      remove: ["s2"], edit: [{ id: "s1", noBuy: true, noSell: true }],
    });
    expect(dialog().getByRole("button", { name: "Apply changes" })).toBeTruthy();
    expect(advisor().value).toBe("typed over");

    fireEvent.click(dialog().getByRole("button", { name: "Close" }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("manage-exclusions-dialog")).toBeNull();
    await waitFor(() => expect(advisor().value).toBe("TSLA (DNB - Concentration risk)"));
    expect(client().value).toBe("AAPL (DNB+DNS - Employer stock); NVDA (DNB)");
    expect(screen.queryByTestId("exclusions-notice")).toBeNull();
  });

  it("keeps the fields and shows a notice when the refresh after a save fails", async () => {
    await openForm();
    toggleClient("Maeve Brennan");
    await waitFor(() => expect(advisor().value).not.toBe(""));
    fireEvent.change(advisor(), { target: { value: "typed over" } });
    fireEvent.click(manage());
    await dialog().findByText("TSLA");
    fireEvent.click(dialog().getByRole("button", { name: "Mark TSLA for removal" }));
    fireEvent.click(dialog().getByRole("button", { name: "Apply 1 change" }));
    await dialog().findByText("Saved. Added 1.");
    actions.clientExclusions.mockRejectedValueOnce(new Error("Network Error"));
    fireEvent.click(dialog().getByRole("button", { name: "Close" }));
    expect((await screen.findByTestId("exclusions-notice")).textContent).toBe("Couldn't refresh exclusions — review the fields.");
    expect(advisor().value).toBe("typed over");
  });

  it("locks the tabs during Apply so the result stays with the client it was saved for (B1)", async () => {
    let resolve!: (value: unknown) => void;
    await openForm();
    toggleClient("Maeve Brennan");
    toggleClient("Lucille Howell");
    fireEvent.click(manage());
    const tabs = within(dialog().getByRole("tablist", { name: "Select client" }));
    await dialog().findByText("TSLA");
    fireEvent.click(dialog().getByRole("button", { name: "Mark TSLA for removal" }));
    actions.apply.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(dialog().getByRole("button", { name: "Apply 1 change" }));
    const blair = tabs.getByRole("tab", { name: /Lucille Howell/ });
    expect(blair.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(blair);
    fireEvent.keyDown(tabs.getByRole("tab", { name: /Maeve Brennan/ }), { key: "ArrowRight" });
    expect(tabs.getByRole("tab", { name: /Maeve Brennan/ }).getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      resolve({ ok: true, data: { exclusions: [row({ id: "a-new", ticker: "NVDA" })], added: 1, removed: 1, edited: 0 } });
    });
    expect(dialog().getByText("Saved. Added 1. Removed 1.")).toBeTruthy();
    expect(blair.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(blair);
    await dialog().findByText("XOM");
    expect(dialog().queryByText("NVDA")).toBeNull();
    expect(dialog().queryByText(/^Saved\./)).toBeNull();
    expect(actions.apply).toHaveBeenCalledTimes(1);
    expect(actions.apply).toHaveBeenCalledWith("client", "c-alex", { add: [], remove: ["s1"], edit: [] });
  });

  it("drops an Apply result when its client left the dialog before the save resolved", async () => {
    let resolve!: (value: unknown) => void;
    await openForm();
    toggleClient("Maeve Brennan");
    toggleClient("Lucille Howell");
    fireEvent.click(manage());
    await dialog().findByText("TSLA");
    fireEvent.click(dialog().getByRole("button", { name: "Mark TSLA for removal" }));
    actions.apply.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(dialog().getByRole("button", { name: "Apply 1 change" }));
    toggleClient("Maeve Brennan");
    await dialog().findByText("XOM");
    await act(async () => {
      resolve({ ok: true, data: { exclusions: [row({ id: "a-new", ticker: "NVDA" })], added: 1, removed: 1, edited: 0 } });
    });
    expect(dialog().getByText("XOM")).toBeTruthy();
    expect(dialog().queryByText("NVDA")).toBeNull();
    expect(dialog().queryByText(/^Saved\./)).toBeNull();
  });

  it("blocks every close path during Apply, then replaces the fields after the save (B2)", async () => {
    let resolve!: (value: unknown) => void;
    await openForm();
    toggleClient("Maeve Brennan");
    await waitFor(() => expect(advisor().value).not.toBe(""));
    fireEvent.click(manage());
    await dialog().findByText("TSLA");
    fireEvent.click(dialog().getByRole("button", { name: "Mark TSLA for removal" }));
    actions.apply.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(dialog().getByRole("button", { name: "Apply 1 change" }));
    const close = dialog().getByRole("button", { name: "Close" }) as HTMLButtonElement;
    const x = dialog().getByRole("button", { name: "Close dialog" }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(x.disabled).toBe(true);
    const element = screen.getByTestId("manage-exclusions-dialog");
    fireEvent(element, new Event("cancel", { cancelable: true }));
    fireEvent.click(element);
    expect(screen.getByTestId("manage-exclusions-dialog")).toBeTruthy();
    expect(window.confirm).not.toHaveBeenCalled();
    standing["c-alex"] = standing["c-alex"].filter((entry) => entry.id !== "s1");
    await act(async () => {
      resolve({ ok: true, data: { exclusions: standing["c-alex"], added: 0, removed: 1, edited: 0 } });
    });
    fireEvent(element, new Event("cancel", { cancelable: true }));
    expect(screen.queryByTestId("manage-exclusions-dialog")).toBeNull();
    await waitFor(() => expect(advisor().value).toBe(""));
    expect(client().value).toBe("AAPL (DNB+DNS - Employer stock)");
  });

  it("keeps a failed save inside the dialog and leaves the fields alone on close", async () => {
    await openForm();
    toggleClient("Maeve Brennan");
    await waitFor(() => expect(advisor().value).not.toBe(""));
    actions.apply.mockResolvedValueOnce({ ok: false, message: "NVDA is already on the client exclusion list for this client." });
    fireEvent.click(manage());
    await dialog().findByText("TSLA");
    fireEvent.click(dialog().getByRole("button", { name: "Mark TSLA for removal" }));
    fireEvent.click(dialog().getByRole("button", { name: "Apply 1 change" }));
    await dialog().findByText("NVDA is already on the client exclusion list for this client.");
    const reads = actions.clientExclusions.mock.calls.length;
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(dialog().getByRole("button", { name: "Close dialog" }));
    expect(window.confirm).toHaveBeenCalledWith("Discard 1 unsaved change for Maeve Brennan?");
    expect(screen.getByTestId("manage-exclusions-dialog")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByTestId("manage-exclusions-dialog")).toBeNull();
    await act(async () => undefined);
    expect(actions.clientExclusions.mock.calls.length).toBe(reads);
  });

  it("gives each household client its own tab and batch with an unsaved badge", async () => {
    await openForm();
    toggleClient("Maeve Brennan");
    toggleClient("Lucille Howell");
    expect(manage().title).toBe("Add or remove standing exclusions for any client in this household — switch tabs inside the modal");
    fireEvent.click(manage());
    expect(dialog().getByText("2 clients in this household — each tab is its own batch")).toBeTruthy();
    const tabs = dialog().getByRole("tablist", { name: "Select client" });
    await dialog().findByText("TSLA");
    fireEvent.click(dialog().getByRole("button", { name: "Mark TSLA for removal" }));
    expect(within(tabs).getByRole("tab", { name: /Maeve Brennan/ }).textContent).toBe("Maeve Brennan1");
    fireEvent.click(within(tabs).getByRole("tab", { name: /Lucille Howell/ }));
    await dialog().findByText("XOM");
    expect(actions.clientExclusions).toHaveBeenLastCalledWith(["c-blair"]);
    expect(dialog().getByRole("button", { name: "Apply changes" })).toBeTruthy();
    fireEvent.click(within(tabs).getByRole("tab", { name: /Maeve Brennan/ }));
    await dialog().findByText("Marked for removal — click Apply to commit, or click the icon again to keep");
    fireEvent(screen.getByTestId("manage-exclusions-dialog"), new Event("cancel", { cancelable: true }));
    expect(window.confirm).toHaveBeenCalledWith("Discard 1 unsaved change for Maeve Brennan?");
    expect(screen.queryByTestId("manage-exclusions-dialog")).toBeNull();
  });
});

describe("account-level exclusions (AC-92, AC-111, AC-121, AC-146)", () => {
  it("shows the selected accounts' standing exclusions, grouped by account with the client when several are selected", async () => {
    await openForm();
    toggleClient("Maeve Brennan");
    expect(panel().getByText("Review Before Submit")).toBeTruthy();
    expect(panel().getByText("No account-specific exclusions on selected accounts.")).toBeTruthy();
    expect(panel().queryByRole("button", { name: /Manage Account Restrictions/ })).toBeNull();
    tickAccount("SYN00001");
    await panel().findByText("GME");
    expect(actions.accountExclusions).toHaveBeenLastCalledWith(["a1"]);
    expect(panel().getByText(/Account-Level Standing Exclusions/).textContent).toBe("Account-Level Standing Exclusions (1 total)");
    expect(panel().getByText("SYN00001").textContent).toBe("SYN00001");
    expect(panel().getByText("DNB")).toBeTruthy();
    expect(panel().getByText("No reason provided")).toBeTruthy();
    toggleClient("Lucille Howell");
    tickAccount("SYN00001");
    tickAccount("SYN00003");
    await panel().findByText("AMC");
    expect(panel().getByText("SYN00003 — Lucille Howell")).toBeTruthy();
    expect(panel().getByText("Imported from Meridian restrictions file")).toBeTruthy();
    expect(panel().getByText("DNB+DNS")).toBeTruthy();
  });

  it("shows loading, not the empty message, while the selected accounts' first read is pending", async () => {
    actions.accountExclusions.mockImplementation(() => new Promise(() => undefined));
    await openForm();
    toggleClient("Maeve Brennan");
    expect(panel().getByText("No account-specific exclusions on selected accounts.")).toBeTruthy();
    tickAccount("SYN00001");
    expect(panel().getByRole("status").textContent).toBe("Loading account exclusions...");
    expect(panel().queryByText("No account-specific exclusions on selected accounts.")).toBeNull();
  });

  it("shows the load failure message (AC-111)", async () => {
    actions.accountExclusions.mockResolvedValue({ ok: false, message: "timeout of 30000ms exceeded" });
    await openForm();
    toggleClient("Maeve Brennan");
    tickAccount("SYN00002");
    expect((await panel().findByRole("alert")).textContent).toBe("Unable to load account-level exclusions.");
  });

  it("opens the same dialog for the selected accounts and refreshes the panel after a saved close", async () => {
    await openForm();
    toggleClient("Maeve Brennan");
    tickAccount("SYN00001");
    tickAccount("SYN00002");
    await panel().findByText("GME");
    fireEvent.click(panel().getByRole("button", { name: /Manage Account Restrictions/ }));
    expect(dialog().getByRole("heading", { name: "Manage Account Restrictions" })).toBeTruthy();
    expect(dialog().getByText("2 accounts selected — each tab is its own batch")).toBeTruthy();
    expect(within(dialog().getByRole("tablist", { name: "Select account" })).getAllByRole("tab").map((tab) => tab.textContent))
      .toEqual(["SYN00001 — Maeve Brennan", "SYN00002 — Maeve Brennan"]);
    await dialog().findByText("GME");
    expect(actions.accountExclusions).toHaveBeenLastCalledWith(["a1"]);
    const advisorSection = within(dialog().getByRole("region", { name: "Advisor Specific Exclusions" }));
    fireEvent.click(advisorSection.getByRole("button", { name: /Add row/ }));
    fireEvent.change(advisorSection.getByLabelText("Ticker for new advisor exclusion"), { target: { value: "nvda" } });
    fireEvent.click(advisorSection.getByLabelText("New advisor exclusion: do not sell"));
    fireEvent.click(dialog().getByRole("button", { name: "Apply 1 change" }));
    await dialog().findByText("Saved. Added 1.");
    expect(actions.apply).toHaveBeenCalledWith("account", "a1", { add: [{ ticker: "NVDA", kind: "advisor", reason: "", noBuy: false, noSell: true }], remove: [], edit: [] });
    const reads = actions.accountExclusions.mock.calls.length;
    fireEvent.click(dialog().getByRole("button", { name: "Close" }));
    await panel().findByText("NVDA");
    expect(actions.accountExclusions.mock.calls.length).toBe(reads + 1);
    expect(panel().getByText(/Account-Level Standing Exclusions/).textContent).toBe("Account-Level Standing Exclusions (2 total)");
  });
});
