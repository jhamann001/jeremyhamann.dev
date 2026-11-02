// @vitest-environment jsdom
import { createElement, useState } from "react";
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

import { NewRequestDraftProvider, useNewRequestDraft } from "@/components/trade-requests/form/NewRequestDraft";
import { NewRequestForm } from "@/components/trade-requests/form/NewRequestForm";
import type { NewRequestClient, NewRequestDraft } from "@/lib/trade-requests/new-request";
import type { PriorAllocation } from "@/lib/trade-requests/new-request-allocation";

const CLIENTS: NewRequestClient[] = [
  { id: "c-alex", name: "Maeve Brennan", accounts: [
    { id: "a1", accountNumber: "SYN00001", accountType: "Taxable", balance: 1_500 },
    { id: "a2", accountNumber: "SYN00002", accountType: "Roth IRA", balance: 2_500 }] },
  { id: "c-blair", name: "Lucille Howell", accounts: [{ id: "a3", accountNumber: "SYN00003", accountType: "Traditional IRA", balance: 4_000 }] },
];
const PRIOR: PriorAllocation = {
  riskProfile: 15, baseAllocation: { equity: 70, fixed: 27, cash: 3 },
  equityStrategies: [{ id: 7, benchmark: "IWM", allocation: 60, rationale: "small caps" }, { id: 8, benchmark: "EFA", allocation: 40, rationale: "intl" }],
};

const field = (name: RegExp | string) => screen.getByLabelText(name) as HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
const change = (name: RegExp | string, value: string) => fireEvent.change(field(name), { target: { value } });
const headings = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
const submitButton = () => screen.getByRole("button", { name: /Submit/ }) as HTMLButtonElement;
const rationales = () => screen.getAllByLabelText(/^Strategy Rationale/) as HTMLTextAreaElement[];
const tile = (key: string) => screen.getByTestId(`base-allocation-${key}`).textContent;
const prompt = () => screen.queryByRole("region", { name: "This client has an existing allocation on file." });

async function openForm() {
  render(createElement(NewRequestDraftProvider, null, createElement(NewRequestForm)));
  await screen.findByRole("heading", { name: "New Trade Request" });
}
function select(client: string, numbers: string[]) {
  fireEvent.click(screen.getByRole("button", { name: /Client \/ Household/ }));
  fireEvent.click(within(screen.getByRole("listbox", { name: "Client list" })).getByRole("checkbox", { name: new RegExp(client) }));
  for (const number of numbers) fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(number) }));
}

beforeEach(() => {
  actions.load.mockResolvedValue({ ok: true, clients: CLIENTS });
  actions.lookup.mockResolvedValue({ households: [] });
  actions.prior.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Initial Funding mandate and strategies", () => {
  it("shows the mandate and one SPY strategy at 100% with the base allocation for the chosen risk score (AC-95, AC-136)", async () => {
    await openForm();
    expect(headings()).toEqual([
      "1. Client & Account Context", "2. Mandate & Base Allocation", "3. Equity Strategy Construction",
      "4. Compliance, Exclusions & Execution", "5. Workflow & Advisor Notes",
    ]);
    const risk = field("Client Risk Score");
    expect([...risk.options].map((o) => o.textContent)).toEqual(["— Select risk score —", ...Array.from({ length: 25 }, (_, i) => `Level ${i + 1} / 25`)]);
    expect(screen.getByText("Determines base asset allocation.")).toBeTruthy();
    expect([tile("equity"), tile("fixed"), tile("cash")]).toEqual(["Equity—", "Fixed Inc.—", "Cash—"]);
    change("Client Risk Score", "6");
    expect([tile("equity"), tile("fixed"), tile("cash")]).toEqual(["Equity43%", "Fixed Inc.49.5%", "Cash7.5%"]);
    expect(screen.getByText(/equity allocation across strategies/).textContent).toBe("Distribute the 43% equity allocation across strategies.");
    expect(screen.getAllByTestId("equity-strategy")).toHaveLength(1);
    expect(field("Benchmark / Strategy").value).toBe("SPY");
    expect(field("Benchmark / Strategy").placeholder).toBe("Search or type ticker...");
    expect(field("% of Equity").value).toBe("100");
    expect(screen.getByTestId("equity-total").textContent).toBe("100% / 100%");
    expect(screen.queryByRole("button", { name: "Remove equity strategy" })).toBeNull();
  });

  it("gates Submit on approval, risk score, benchmarks, the 100% total and every rationale (AC-33, AC-38)", async () => {
    await openForm();
    select("Maeve Brennan", ["SYN00001"]);
    change(/^Priority/, "Standard");
    expect(submitButton().disabled).toBe(true);
    change("Liquidation Approval", "Yes");
    change("Client Risk Score", "12");
    expect(submitButton().disabled).toBe(true);
    const label = screen.getByText("Strategy Rationale (Reg BI)", { exact: false });
    expect(label.getAttribute("title")).toBe("Required when setting a new or materially changed allocation.");
    expect(label.textContent).toBe("Strategy Rationale (Reg BI) *");
    expect(rationales()[0].placeholder).toBe("Why SPY is in the client's best interest...");
    fireEvent.change(rationales()[0], { target: { value: "   " } });
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(rationales()[0], { target: { value: "Core exposure" } });
    expect(submitButton().disabled).toBe(false);
    change("% of Equity", "90");
    expect(screen.getByTestId("equity-total").textContent).toBe("90% / 100% — must equal 100%");
    expect(submitButton().disabled).toBe(true);
    change("% of Equity", "100");
    fireEvent.change(field("Benchmark / Strategy"), { target: { value: "  " } });
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute("type")).toBe("button");
  });

  it("adds up to three strategies, removes them, and picks a preset benchmark (AC-135)", async () => {
    await openForm();
    const add = () => screen.getByRole("button", { name: /Add Another Equity Strategy/ });
    expect(add().textContent).toBe("+ Add Another Equity Strategy (1/3)");
    fireEvent.click(add());
    expect(add().textContent).toBe("+ Add Another Equity Strategy (2/3)");
    fireEvent.click(add());
    expect(screen.getAllByTestId("equity-strategy")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Add Another Equity Strategy/ })).toBeNull();
    expect(rationales()[1].placeholder).toBe("Why this strategy is in the client's best interest...");
    const second = screen.getAllByRole("combobox", { name: "Benchmark / Strategy" })[1];
    fireEvent.focus(second);
    fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: "EFA – Developed International" }));
    expect((second as HTMLInputElement).value).toBe("EFA");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove equity strategy" })[2]);
    expect(screen.getAllByTestId("equity-strategy")).toHaveLength(2);
    expect(add()).toBeTruthy();
  });

  it("counts rationale characters against 5,000 and accepts no more (AC-145, AC-147)", async () => {
    await openForm();
    const box = rationales()[0];
    expect(box.maxLength).toBe(5000);
    expect(screen.getByText("0 / 5,000").getAttribute("aria-live")).toBe("polite");
    fireEvent.change(box, { target: { value: "Core exposure" } });
    expect(screen.getByText("13 / 5,000")).toBeTruthy();
    fireEvent.change(box, { target: { value: "x".repeat(5_010) } });
    expect(rationales()[0].value).toHaveLength(5_000);
    expect(screen.getByText("5,000 / 5,000")).toBeTruthy();
  });
});

describe("money-market warning (AC-73, AC-74)", () => {
  it("names the entered and expected tickers and makes that rationale required", async () => {
    await openForm();
    select("Maeve Brennan", ["SYN00001", "SYN00002"]);
    change("State Residence", "NY");
    fireEvent.change(field("Benchmark / Strategy"), { target: { value: "SWVXX" } });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "SWVXX doesn’t match the selected Taxable account in NY. Expected: VYFXX or SWVXX. Provide a Strategy Rationale below to override.",
    );
    expect(within(alert).getByText("SWVXX").tagName).toBe("STRONG");
    expect(screen.getByText("Strategy Rationale (Reg BI)", { exact: false }).getAttribute("title"))
      .toBe("Required because SWVXX doesn't match the selected account type / residence. Document why this MMK is being used.");
    fireEvent.change(field("Benchmark / Strategy"), { target: { value: "SPY" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("previous allocation (AC-96 to AC-99, AC-71, AC-72)", () => {
  async function rebalanceFor(client: string, numbers: string[]) {
    await openForm();
    change("Trade Type", "Rebalance");
    select(client, numbers);
  }

  it("announces the load, then prompts with the risk level and strategies and hides the mandate until answered", async () => {
    let resolve: (value: PriorAllocation) => void = () => undefined;
    actions.prior.mockReturnValue(new Promise<PriorAllocation>((r) => { resolve = r; }));
    await rebalanceFor("Maeve Brennan", ["SYN00001"]);
    expect(await screen.findByText("Loading previous allocation data")).toBeTruthy();
    expect(actions.prior).toHaveBeenCalledWith("c-alex");
    expect(screen.queryByLabelText("Client Risk Score")).toBeNull();
    await act(async () => resolve(PRIOR));
    const region = prompt()!;
    expect(region.textContent).toContain("Risk Level 15 — IWM (60%), EFA (40%)");
    expect(within(region).getByRole("button", { name: "Yes, use previous allocation" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "No, start fresh" })).toBeTruthy();
    expect(headings()).toEqual(["1. Client & Account Context", "2. New Deposits (Optional)", "3. Workflow & Advisor Notes"]);
    expect(screen.queryByLabelText("Client Risk Score")).toBeNull();
    expect(screen.queryByRole("group", { name: "ESG Filters (Direct Indexing)" })).toBeNull();
  });

  it("Yes fills the risk score and strategies; the unchanged allocation makes rationales optional, a change requires them", async () => {
    actions.prior.mockResolvedValue(PRIOR);
    await rebalanceFor("Maeve Brennan", ["SYN00001"]);
    fireEvent.click(await screen.findByRole("button", { name: "Yes, use previous allocation" }));
    expect(prompt()).toBeNull();
    expect(field("Client Risk Score").value).toBe("15");
    expect(screen.getAllByRole("combobox", { name: "Benchmark / Strategy" }).map((b) => (b as HTMLInputElement).value)).toEqual(["IWM", "EFA"]);
    expect(rationales().map((r) => r.value)).toEqual(["small caps", "intl"]);
    change(/^Priority/, "Standard");
    change("Liquidation Approval", "Yes");
    for (const box of rationales()) fireEvent.change(box, { target: { value: "" } });
    const label = screen.getAllByText("Strategy Rationale (Reg BI)", { exact: false })[0];
    expect(label.textContent).toBe("Strategy Rationale (Reg BI) (Optional)");
    expect(label.getAttribute("title")).toBe("Optional because this allocation matches the last approved or completed allocation.");
    expect(submitButton().disabled).toBe(false);
    change("Client Risk Score", "16");
    expect(submitButton().disabled).toBe(true);
    expect(screen.getAllByText("Strategy Rationale (Reg BI)", { exact: false })[0].textContent).toBe("Strategy Rationale (Reg BI) *");
  });

  it("No shows the inputs without the prior values", async () => {
    actions.prior.mockResolvedValue(PRIOR);
    await rebalanceFor("Maeve Brennan", ["SYN00001"]);
    fireEvent.click(await screen.findByRole("button", { name: "No, start fresh" }));
    expect(field("Client Risk Score").value).toBe("");
    expect(field("Benchmark / Strategy").value).toBe("SPY");
    expect(field("% of Equity").value).toBe("100");
    expect(rationales()[0].value).toBe("");
    expect(headings()).toEqual([
      "1. Client & Account Context", "2. New Deposits (Optional)", "3. Mandate & Base Allocation", "4. Equity Strategy Construction",
      "5. Compliance, Exclusions & Execution", "6. Workflow & Advisor Notes",
    ]);
  });

  it("with no prior allocation available (none, or an advisor without the client) shows the inputs and requires rationales", async () => {
    await rebalanceFor("Lucille Howell", ["SYN00003"]);
    expect(await screen.findByLabelText("Client Risk Score")).toBeTruthy();
    expect(prompt()).toBeNull();
    change(/^Priority/, "Standard");
    change("Liquidation Approval", "No");
    change("Client Risk Score", "10");
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(rationales()[0], { target: { value: "New mandate" } });
    expect(submitButton().disabled).toBe(false);
  });

  it("asks for the first selected client only and keeps the answer when the form remounts", async () => {
    actions.prior.mockResolvedValue(PRIOR);
    let toggle: (show: boolean) => void = () => undefined;
    function Host() {
      const [show, setShow] = useState(true);
      toggle = setShow;
      return createElement(NewRequestDraftProvider, null, show ? createElement(NewRequestForm) : null);
    }
    render(createElement(Host));
    await screen.findByRole("heading", { name: "New Trade Request" });
    change("Trade Type", "Cash Deposit");
    fireEvent.click(screen.getByRole("button", { name: /Client \/ Household/ }));
    const list = within(screen.getByRole("listbox", { name: "Client list" }));
    fireEvent.click(list.getByRole("checkbox", { name: /Lucille Howell/ }));
    fireEvent.click(list.getByRole("checkbox", { name: /Maeve Brennan/ }));
    await waitFor(() => expect(actions.prior).toHaveBeenCalledWith("c-blair"));
    expect(actions.prior).not.toHaveBeenCalledWith("c-alex");
    fireEvent.click(await screen.findByRole("button", { name: "Yes, use previous allocation" }));
    act(() => toggle(false));
    act(() => toggle(true));
    await screen.findByRole("heading", { name: "New Trade Request" });
    expect(field("Client Risk Score").value).toBe("15");
    expect(prompt()).toBeNull();
    expect(actions.prior).toHaveBeenCalledTimes(1);
  });

  it("drops a prior allocation that arrives after the first client changed, leaving the draft untouched", async () => {
    const held: Record<string, (value: PriorAllocation | null) => void> = {};
    actions.prior.mockImplementation((id: string) => new Promise<PriorAllocation | null>((r) => { held[id] = r; }));
    let latest: NewRequestDraft | null = null;
    function Probe() {
      latest = useNewRequestDraft().draft;
      return null;
    }
    render(createElement(NewRequestDraftProvider, null, createElement(NewRequestForm), createElement(Probe)));
    await screen.findByRole("heading", { name: "New Trade Request" });
    change("Trade Type", "Rebalance");
    fireEvent.click(screen.getByRole("button", { name: /Client \/ Household/ }));
    const list = () => within(screen.getByRole("listbox", { name: "Client list" }));
    fireEvent.click(list().getByRole("checkbox", { name: /Maeve Brennan/ }));
    await waitFor(() => expect(held["c-alex"]).toBeTypeOf("function"));
    fireEvent.click(list().getByRole("checkbox", { name: /Maeve Brennan/ }));
    fireEvent.click(list().getByRole("checkbox", { name: /Lucille Howell/ }));
    await waitFor(() => expect(held["c-blair"]).toBeTypeOf("function"));
    const before = latest!;
    expect(before.priorAllocation).toEqual({ key: "client:Rebalance:c-blair", status: "loading", allocation: null });
    await act(async () => held["c-alex"](PRIOR));
    expect(latest).toBe(before);
    expect(prompt()).toBeNull();
    expect(screen.getByText("Loading previous allocation data")).toBeTruthy();
    await act(async () => held["c-blair"](null));
    expect(latest!.priorAllocation).toEqual({ key: "client:Rebalance:c-blair", status: "settled", allocation: null });
    expect(prompt()).toBeNull();
    expect(field("Client Risk Score").value).toBe("");
  });

  it("manual entry shows the inputs directly and requires rationales; no lookup is made", async () => {
    await openForm();
    change("Trade Type", "Rebalance");
    fireEvent.click(screen.getByRole("button", { name: "Enter manually" }));
    expect(await screen.findByLabelText("Client Risk Score")).toBeTruthy();
    expect(screen.getByText("Strategy Rationale (Reg BI)", { exact: false }).textContent).toBe("Strategy Rationale (Reg BI) *");
    expect(actions.prior).not.toHaveBeenCalled();
  });

  it("Cash Deposit also needs the amount and deposit account (AC-34)", async () => {
    await openForm();
    change("Trade Type", "Cash Deposit");
    select("Maeve Brennan", ["SYN00001"]);
    await screen.findByLabelText("Client Risk Score");
    change(/^Priority/, "Urgent");
    change("Liquidation Approval", "Yes");
    change("Client Risk Score", "12");
    fireEvent.change(rationales()[0], { target: { value: "Deposit mandate" } });
    expect(submitButton().disabled).toBe(true);
    change(/^Deposit Amount/, "   ");
    change(/^Account Holding Deposit/, "SYN00001");
    expect(submitButton().disabled).toBe(true);
    change(/^Deposit Amount/, "$150,000");
    expect(submitButton().disabled).toBe(false);
  });
});
