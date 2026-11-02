// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ load: vi.fn(), lookup: vi.fn(), prior: vi.fn() }));
vi.mock("@/app/(authenticated)/trade-requests/new/actions", () => ({
  loadNewRequestClients: actions.load,
  lookupNewRequestHouseholds: actions.lookup,
  loadPriorAllocation: actions.prior,
  loadClientExclusions: async () => ({ ok: true, data: {} }),
  loadAccountExclusions: async () => ({ ok: true, data: {} }),
  applyExclusionBatch: async () => ({ ok: false, message: "unused" }),
}));

import { NewRequestDraftProvider } from "@/components/trade-requests/form/NewRequestDraft";
import { NewRequestForm } from "@/components/trade-requests/form/NewRequestForm";
import type { HouseholdResolveResult, NewRequestClient } from "@/lib/trade-requests/new-request";

const ulid = (n: number) => `01TRW11SYNTHETIC${String(n).padStart(10, "0")}`;
const acct = (n: number, balance: number, accountType = "Taxable") => ({ id: ulid(n), accountNumber: `SYN${String(n).padStart(5, "0")}`, accountType, balance });
const CLIENTS: NewRequestClient[] = [
  { id: "c-alex", name: "Maeve Brennan", accounts: [acct(1, 1500), acct(2, 2500, "Roth IRA")] },
  { id: "c-blair", name: "Lucille Howell", accounts: [acct(3, 4000, "Traditional IRA")] },
  { id: "c-morgan", name: "Esta Barrows", accounts: [acct(4, 900)] },
];
const BRENNAN = {
  householdId: 7101, householdName: "Brennan Family Household", selectedAccountIds: [], clientIds: ["c-alex", "c-blair"],
  accounts: [
    { accountId: ulid(1), accountNumber: "SYN00001", accountTitle: "Maeve Brennan Individual", clientId: "c-alex" },
    { accountId: ulid(2), accountNumber: "SYN00002", accountTitle: "Maeve Brennan Roth", clientId: "c-alex" },
    { accountId: ulid(3), accountNumber: "SYN00003", accountTitle: "Lucille Howell IRA", clientId: "c-blair" },
  ],
};
const CARVER = { householdId: 7102, householdName: "Carver Household", selectedAccountIds: [], clientIds: ["c-morgan"],
  accounts: [{ accountId: ulid(4), accountNumber: "SYN00004", accountTitle: "Esta Barrows Joint", clientId: "c-morgan" },
    { accountId: ulid(5), accountNumber: null, accountTitle: "Abdullah Beatty Trust", clientId: null }] };

function renderForm(onSubmit?: (draft: unknown) => void) {
  return render(createElement(NewRequestDraftProvider, null, createElement(NewRequestForm, { onSubmit })));
}
/** Enter as a browser would treat it: the key event, then implicit submission of the enclosing form. */
function pressEnter(input: HTMLElement) {
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  const form = (input as HTMLInputElement).form;
  if (form) fireEvent.submit(form);
}
const submit = () => screen.getByRole("button", { name: "Generate Plan & Submit" });
async function pickClients(...names: string[]) {
  fireEvent.click(screen.getByRole("button", { name: /Client \/ Household/ }));
  const list = screen.getByRole("listbox", { name: "Client list" });
  for (const name of names) fireEvent.click(within(list).getByRole("checkbox", { name: new RegExp(name) }));
}
/** Priority plus the Initial Funding allocation inputs, so these tests isolate the selection gates. */
const choosePriority = () => {
  fireEvent.change(screen.getByLabelText(/^Priority/), { target: { value: "Standard" } });
  fireEvent.change(screen.getByLabelText("Liquidation Approval"), { target: { value: "Yes" } });
  fireEvent.change(screen.getByLabelText("Client Risk Score"), { target: { value: "12" } });
  fireEvent.change(screen.getByLabelText(/^Strategy Rationale/), { target: { value: "Synthetic rationale" } });
};
const waitLookup = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });

beforeEach(() => {
  actions.load.mockResolvedValue({ ok: true, clients: CLIENTS });
  actions.lookup.mockResolvedValue({ households: [] });
  actions.prior.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("New Request form shell and selection", () => {
  it("shows the loading line, then the card, the Warehouse pill and section 1", async () => {
    let resolve!: (value: unknown) => void;
    actions.load.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderForm();
    expect(screen.getByRole("status").textContent).toBe("Connecting to Warehouse API...");
    await act(async () => resolve({ ok: true, clients: CLIENTS }));
    expect(screen.getByRole("heading", { name: "New Trade Request" })).toBeTruthy();
    expect(screen.getByText("Connected to Warehouse").closest("[title]")?.getAttribute("title")).toBe("Client data loaded live from Warehouse");
    expect(screen.getAllByRole("heading", { level: 3 })[0].textContent).toBe("1. Client & Account Context");
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the client-list failure text above the message (AC-82)", async () => {
    actions.load.mockResolvedValue({ ok: false, outcome: "failed", message: "Failed to load clients" });
    renderForm();
    const alert = await screen.findByRole("alert");
    expect([...alert.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["Failed to load client data", "Failed to load clients"]);
    expect(screen.queryByRole("heading", { name: "New Trade Request" })).toBeNull();
  });

  it("shows the not-set-up card when the service cannot confirm the person", async () => {
    actions.load.mockResolvedValue({ ok: false, outcome: "not_set_up", message: "x" });
    renderForm();
    expect(await screen.findByText("Your account is not set up for Trade Requests — contact Operations.")).toBeTruthy();
  });

  it("offers every account of every selected client, grouped by client, with chips and a total (AC-39)", async () => {
    renderForm();
    await screen.findByRole("heading", { name: "New Trade Request" });
    await pickClients("Maeve Brennan", "Lucille Howell");
    expect(screen.getByText("Client / Household (2)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Maeve Brennan" })).toBeTruthy();
    const group = screen.getByRole("group", { name: "Select Accounts" });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(3);
    expect(within(group).getByText("Maeve Brennan")).toBeTruthy();
    expect(within(group).getByText("Lucille Howell")).toBeTruthy();
    fireEvent.click(within(group).getByRole("checkbox", { name: /SYN00002/ }));
    fireEvent.click(within(group).getByRole("checkbox", { name: /SYN00003/ }));
    expect(within(group).getByText("Total: $6,500")).toBeTruthy();
    choosePriority();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it("searches clients and says when none match", async () => {
    renderForm();
    await screen.findByRole("heading", { name: "New Trade Request" });
    fireEvent.click(screen.getByRole("button", { name: /Client \/ Household/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search clients..." }), { target: { value: "zzz" } });
    expect(screen.getByText("No clients found")).toBeTruthy();
  });

  it("accepts manual entry with name, account number, type and a balance above zero (AC-41)", async () => {
    renderForm();
    await screen.findByRole("heading", { name: "New Trade Request" });
    const toggle = screen.getByRole("button", { name: "Enter manually" });
    expect(toggle.getAttribute("title")).toBe("Enter client details not in Warehouse");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Use Warehouse list" }).getAttribute("title")).toBe("Switch back to Warehouse client list");
    fireEvent.change(screen.getByLabelText("Client Name (Manual)"), { target: { value: "Sam Synthetic" } });
    choosePriority();
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));
    const type = screen.getByRole("combobox", { name: "Account type" }) as HTMLSelectElement;
    expect([...type.options].map((o) => o.value)).toEqual(["Taxable", "Joint", "Traditional IRA", "Roth IRA"]);
    expect(type.value).toBe("Taxable");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select manual account 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Account #" }), { target: { value: "MAN-1" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Account value ($)" }), { target: { value: "0" } });
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Account value ($)" }), { target: { value: "25,000" } });
    expect(screen.getByText("Total: $25,000")).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    expect(actions.lookup).not.toHaveBeenCalled();
  });
});

describe("Submit is only the Submit button", () => {
  it("Enter in the client search does not submit; clicking Submit does", async () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);
    await screen.findByRole("heading", { name: "New Trade Request" });
    await pickClients("Maeve Brennan");
    fireEvent.click(screen.getByRole("checkbox", { name: /SYN00001/ }));
    choosePriority();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    expect(submit().getAttribute("type")).toBe("button");
    const search = screen.getByRole("combobox", { name: "Search clients..." });
    fireEvent.change(search, { target: { value: "Brennan" } });
    pressEnter(search);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(submit());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ clientIds: ["c-alex"], selectedAccounts: ["SYN00001"] });
  });

  it("Enter in the manual name, Account # and Account value fields does not submit", async () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);
    await screen.findByRole("heading", { name: "New Trade Request" });
    fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
    const name = screen.getByLabelText("Client Name (Manual)");
    fireEvent.change(name, { target: { value: "Sam Synthetic" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Account" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select manual account 1" }));
    const number = screen.getByRole("textbox", { name: "Account #" });
    const value = screen.getByRole("textbox", { name: "Account value ($)" });
    fireEvent.change(number, { target: { value: "MAN-1" } });
    fireEvent.change(value, { target: { value: "25000" } });
    choosePriority();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    for (const field of [name, number, value]) pressEnter(field);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a disabled Submit never calls onSubmit", async () => {
    const onSubmit = vi.fn();
    renderForm(onSubmit);
    await screen.findByRole("heading", { name: "New Trade Request" });
    fireEvent.click(submit());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("household prompt and warning", () => {
  it("prompts for one household, lists accounts under Choose, and includes the chosen ones (AC-122, AC-123, AC-142)", async () => {
    actions.lookup.mockResolvedValue({ households: [BRENNAN] } satisfies HouseholdResolveResult);
    renderForm();
    await screen.findByRole("heading", { name: "New Trade Request" });
    await pickClients("Maeve Brennan");
    const group = screen.getByRole("group", { name: "Select Accounts" });
    fireEvent.click(within(group).getByRole("checkbox", { name: /SYN00001/ }));
    fireEvent.click(within(group).getByRole("checkbox", { name: /SYN00002/ }));
    await waitLookup();
    expect(actions.lookup).toHaveBeenLastCalledWith(["c-alex"], [ulid(1), ulid(2)]);
    const prompt = screen.getByRole("region", { name: "Household sidecar" });
    expect(prompt.textContent).toContain("1 sibling account in 1 other client — part of household Brennan Family Household");
    expect(prompt.textContent).toContain("Include them in this trade?");
    expect(within(prompt).getByRole("button", { name: "Include all" })).toBeTruthy();
    expect(within(prompt).getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(within(prompt).getByRole("button", { name: "Dismiss household sidecar" })).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: "Choose…" }));
    expect(within(prompt).getByRole("checkbox", { name: "Lucille Howell IRA · SYN00003" })).toBeTruthy();
    const includeChosen = within(prompt).getByRole("button", { name: "Include selected (1)" });
    fireEvent.click(within(prompt).getByRole("checkbox", { name: "Lucille Howell IRA · SYN00003" }));
    expect((within(prompt).getByRole("button", { name: "Include selected (0)" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(prompt).getByRole("checkbox", { name: "Lucille Howell IRA · SYN00003" }));
    fireEvent.click(includeChosen);
    expect(screen.getByText("Client / Household (2)")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /SYN00003/ }) as HTMLInputElement).checked).toBe(true);
    await waitLookup();
    expect(screen.queryByRole("region", { name: "Household sidecar" })).toBeNull();
  });

  it("warns when the selection spans two households and adds nothing (AC-124), then stays dismissed (AC-125)", async () => {
    actions.lookup.mockResolvedValue({ households: [BRENNAN, CARVER] });
    renderForm();
    await screen.findByRole("heading", { name: "New Trade Request" });
    await pickClients("Maeve Brennan", "Esta Barrows");
    await waitLookup();
    const warning = screen.getByRole("region", { name: "Household sidecar" });
    expect(warning.textContent).toContain("Selection spans 2 firm households");
    expect(warning.textContent).toContain("Brennan Family Household — 3 sibling accounts not in this trade");
    expect(warning.textContent).toContain("Carver Household — 2 sibling accounts not in this trade");
    expect(warning.textContent).toContain("The trade will not be tagged to a single household.");
    fireEvent.click(within(warning).getByRole("button", { name: "Continue" }));
    expect(screen.queryByRole("region", { name: "Household sidecar" })).toBeNull();
    expect(screen.getAllByRole("checkbox", { checked: true }).filter((c) => /SYN/.test(c.closest("label")?.textContent ?? ""))).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox", { name: /SYN00001/ }));
    await waitLookup();
    expect(screen.queryByRole("region", { name: "Household sidecar" })).toBeNull();
    actions.lookup.mockResolvedValue({ households: [BRENNAN] });
    fireEvent.click(screen.getByRole("checkbox", { name: /SYN00004/ }));
    await waitLookup();
    await waitFor(() => expect(screen.getByRole("region", { name: "Household sidecar" }).textContent).toContain("Brennan Family Household"));
  });

  it("shows nothing when every household account is selected (AC-142)", async () => {
    actions.lookup.mockResolvedValue({ households: [{ ...BRENNAN, accounts: BRENNAN.accounts.slice(0, 2) }] });
    renderForm();
    await screen.findByRole("heading", { name: "New Trade Request" });
    await pickClients("Maeve Brennan");
    fireEvent.click(screen.getByRole("checkbox", { name: /SYN00001/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /SYN00002/ }));
    await waitLookup();
    expect(screen.queryByRole("region", { name: "Household sidecar" })).toBeNull();
  });
});
