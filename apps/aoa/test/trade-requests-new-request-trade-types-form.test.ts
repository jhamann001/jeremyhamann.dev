// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import type { NewRequestClient } from "@/lib/trade-requests/new-request";
import { NoPlanCopyProvider } from "@/components/trade-requests/form/NoPlanCopy";
import { tradeRequestsNoPlanCopyEnabled } from "@/lib/flags";
import { initialNewRequestDraft, newRequestSubmitLabel } from "@/lib/trade-requests/new-request";
import { cashDepositNote, rebalanceAllText } from "@/lib/trade-requests/new-request-trade-types";

const CLIENTS: NewRequestClient[] = [
  { id: "c-alex", name: "Maeve Brennan", accounts: [
    { id: "a1", accountNumber: "SYN00001", accountType: "Taxable", balance: 1_500 },
    { id: "a2", accountNumber: "SYN00002", accountType: "Roth IRA", balance: 2_500 }] },
];

const onSubmit = vi.fn();
const field = (name: RegExp | string) => screen.getByLabelText(name) as HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
const change = (name: RegExp | string, value: string) => fireEvent.change(field(name), { target: { value } });
const headings = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
const submitButton = () => screen.getByRole("button", { name: /Submit/ }) as HTMLButtonElement;
const optionsOf = (name: RegExp | string) => [...field(name).options].map((o) => o.textContent);

async function openForm() {
  render(createElement(NewRequestDraftProvider, null, createElement(NewRequestForm, { onSubmit })));
  await screen.findByRole("heading", { name: "New Trade Request" });
}
function selectAlexAccount(number = "SYN00001") {
  fireEvent.click(screen.getByRole("button", { name: /Client \/ Household/ }));
  fireEvent.click(within(screen.getByRole("listbox", { name: "Client list" })).getByRole("checkbox", { name: /Maeve Brennan/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(number) }));
}
/** The Initial Funding, Rebalance and Cash Deposit inputs of AC-33 (rationales required without a prior allocation). */
function completeAllocation() {
  change("Liquidation Approval", "Yes");
  change("Client Risk Score", "12");
  fireEvent.change(screen.getByLabelText(/^Strategy Rationale/), { target: { value: "Synthetic rationale" } });
}
const esgGroup = () => screen.getByRole("group", { name: "ESG Filters (Direct Indexing)" });
const esgBox = (label: string) => within(esgGroup()).getByRole("checkbox", { name: label }) as HTMLInputElement;

beforeEach(() => {
  actions.load.mockResolvedValue({ ok: true, clients: CLIENTS });
  actions.lookup.mockResolvedValue({ households: [] });
  actions.prior.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("section 1 Trade Type and Priority", () => {
  it("offers the five trade types (Initial Funding first) and the priorities with a placeholder (AC-131)", async () => {
    await openForm();
    expect(optionsOf("Trade Type")).toEqual(["Initial Funding", "Rebalance", "Cash Deposit", "Raise Cash", "Liquidate"]);
    expect(field("Trade Type").value).toBe("Initial Funding");
    expect(optionsOf(/^Priority/)).toEqual(["Select a priority", "Urgent", "Standard", "Low"]);
    expect(field(/^Priority/).value).toBe("");
    expect(field(/^Priority/).getAttribute("aria-required")).toBe("true");
  });

  it("orders sections for Initial Funding and keeps Submit disabled until a priority is chosen", async () => {
    await openForm();
    expect(headings()).toEqual([
      "1. Client & Account Context", "2. Mandate & Base Allocation", "3. Equity Strategy Construction",
      "4. Compliance, Exclusions & Execution", "5. Workflow & Advisor Notes",
    ]);
    selectAlexAccount();
    completeAllocation();
    expect(submitButton().disabled).toBe(true);
    change(/^Priority/, "Urgent");
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().getAttribute("type")).toBe("button");
  });
});

describe("Raise Cash (AC-35, AC-132)", () => {
  it("shows Cash Raise Details once an account is selected and gates Submit on amount, reason and priority", async () => {
    await openForm();
    change("Trade Type", "Raise Cash");
    expect(headings()).toEqual(["1. Client & Account Context", "2. Workflow & Advisor Notes"]);
    selectAlexAccount();
    expect(headings()).toEqual(["1. Client & Account Context", "2. Cash Raise Details", "3. Workflow & Advisor Notes"]);
    expect(screen.getByText("Target amount of cash to generate from selling securities")).toBeTruthy();
    expect(screen.getByText("Date the cash must be settled, if applicable")).toBeTruthy();
    expect(screen.getByText("Purpose of the cash generation request")).toBeTruthy();
    expect(field(/^Cash Amount to Raise/).placeholder).toBe("e.g., $50,000");
    expect(field(/^Reason for Cash Raise/).placeholder).toBe("e.g., Client distribution, tax payment, fee payment...");
    const deadline = field("Liquidity Deadline");
    expect(deadline.type).toBe("date");
    expect(deadline.getAttribute("aria-required")).toBeNull();

    change(/^Priority/, "Standard");
    expect(submitButton().disabled).toBe(true);
    change(/^Cash Amount to Raise/, "$50,000");
    expect(submitButton().disabled).toBe(true);
    change(/^Reason for Cash Raise/, "   ");
    expect(submitButton().disabled).toBe(true);
    change(/^Reason for Cash Raise/, "Client distribution");
    expect(submitButton().disabled).toBe(false);
    change("Liquidity Deadline", "2026-11-02");
    expect(field("Liquidity Deadline").value).toBe("2026-11-02");
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ tradeType: "Raise Cash", tradeAmount: "$50,000", liquidityDeadline: "2026-11-02" });
  });

  it("changing the trade type clears the Raise Cash inputs", async () => {
    await openForm();
    change("Trade Type", "Raise Cash");
    selectAlexAccount();
    change(/^Cash Amount to Raise/, "$50,000");
    change("Trade Type", "Liquidate");
    change("Trade Type", "Raise Cash");
    expect(field(/^Cash Amount to Raise/).value).toBe("");
  });
});

describe("Liquidate (AC-36, AC-37)", () => {
  it("needs an option, and described positions for Specific Positions", async () => {
    await openForm();
    change("Trade Type", "Liquidate");
    selectAlexAccount();
    change(/^Priority/, "Low");
    expect(headings()).toEqual(["1. Client & Account Context", "2. Liquidation Details", "3. Workflow & Advisor Notes"]);
    expect(optionsOf(/^Liquidate Options/)).toEqual(["Select liquidation option", "Entire Account", "Specific Positions"]);
    expect(submitButton().disabled).toBe(true);
    change(/^Liquidate Options/, "Entire Account");
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByLabelText(/^Positions to Liquidate/)).toBeNull();
    change(/^Liquidate Options/, "Specific Positions");
    expect(field(/^Positions to Liquidate/).placeholder).toBe("e.g., AAPL, MSFT, TSLA");
    expect(submitButton().disabled).toBe(true);
    change(/^Positions to Liquidate/, "AAPL, MSFT");
    expect(submitButton().disabled).toBe(false);
  });
});

describe("Cash Deposit (AC-133, AC-134)", () => {
  it("shows the deposit inputs, the rebalance-all option with its explanation, and the execution-plan note", async () => {
    await openForm();
    change("Trade Type", "Cash Deposit");
    selectAlexAccount();
    fireEvent.click(screen.getByRole("checkbox", { name: /SYN00002/ }));
    await waitFor(() => expect(headings()).toEqual([
      "1. Client & Account Context", "2. Deposit Details", "3. Mandate & Base Allocation", "4. Equity Strategy Construction",
      "5. Compliance, Exclusions & Execution", "6. Workflow & Advisor Notes",
    ]));
    expect(field(/^Deposit Amount/).placeholder).toBe("e.g., $150,000");
    expect(optionsOf(/^Account Holding Deposit/)).toEqual(["Select account...", "SYN00001", "SYN00002"]);
    const option = screen.getByRole("checkbox", { name: "Also rebalance all selected accounts to target allocation" }) as HTMLInputElement;
    expect(option.checked).toBe(false);
    expect(screen.getByText("Only the deposit account will receive trades. Other selected accounts remain unchanged.")).toBeTruthy();
    fireEvent.click(option);
    expect(option.checked).toBe(true);
    expect(screen.getByText("The engine will redistribute holdings across all selected accounts for this client to match the target allocation.")).toBeTruthy();
    const note = screen.getByRole("note");
    expect(note.textContent).toBe(
      "Execution plan: A detailed plan is not generated on submit for cash deposits. After you submit, a trader will verify holdings and generate the execution plan.",
    );
  });
});

describe("Cash Deposit deposit account follows the selection", () => {
  it("clears when its account is unticked", async () => {
    await openForm();
    change("Trade Type", "Cash Deposit");
    selectAlexAccount();
    fireEvent.click(screen.getByRole("checkbox", { name: /SYN00002/ }));
    change(/^Account Holding Deposit/, "SYN00002");
    expect(field(/^Account Holding Deposit/).value).toBe("SYN00002");
    fireEvent.click(screen.getByRole("checkbox", { name: /SYN00002/ }));
    expect(field(/^Account Holding Deposit/).value).toBe("");
    expect(optionsOf(/^Account Holding Deposit/)).toEqual(["Select account...", "SYN00001"]);
  });
});

describe("Rebalance New Deposits (AC-148)", () => {
  it("shows the optional inputs only once an account is selected", async () => {
    await openForm();
    change("Trade Type", "Rebalance");
    expect(screen.queryByText("New Deposits (Optional)", { exact: false })).toBeNull();
    selectAlexAccount();
    await waitFor(() => expect(headings()).toEqual([
      "1. Client & Account Context", "2. New Deposits (Optional)", "3. Mandate & Base Allocation", "4. Equity Strategy Construction",
      "5. Compliance, Exclusions & Execution", "6. Workflow & Advisor Notes",
    ]));
    expect(screen.getByText("If cash is being deposited alongside the rebalance, enter the details below. Leave blank if no deposits.")).toBeTruthy();
    expect(field("Deposit Amount").placeholder).toBe("$0");
    expect(optionsOf("Account Holding Deposit")).toEqual(["No deposit", "SYN00001"]);
    change(/^Priority/, "Standard");
    completeAllocation();
    expect(submitButton().disabled).toBe(false);
  });
});

describe("compliance inputs and ESG filters (AC-93, AC-94, AC-137, AC-139)", () => {
  it("shows residence, approval and the seven ESG filters for full-form types only", async () => {
    await openForm();
    expect(optionsOf("State Residence")).toEqual(["Other / Not Applicable", "New York (NY) - Muni Preference", "California (CA) - Muni Preference"]);
    expect(screen.getByText("State Residence").getAttribute("title")).toBe("Used for municipal bond tax optimization");
    expect(optionsOf("Liquidation Approval")).toEqual(["Select...", "Yes", "No"]);
    expect(screen.getByText("Liquidation Approval").getAttribute("title")).toBe("Confirms client approves selling existing holdings");
    expect(screen.getByText("ESG Filters (Direct Indexing)").getAttribute("title")).toBe("Exclude sectors from the direct indexing universe");
    expect(within(esgGroup()).getAllByRole("checkbox").map((box) => box.closest("label")?.textContent))
      .toEqual(["Fossil Fuels", "Tobacco", "Weapons", "Alcohol", "Gambling", "Other", "None"]);
    expect(esgBox("None").checked).toBe(true);
    selectAlexAccount();
    for (const type of ["Rebalance", "Cash Deposit"]) {
      change("Trade Type", type);
      expect(await screen.findByRole("group", { name: "ESG Filters (Direct Indexing)" })).toBeTruthy();
    }
    for (const type of ["Raise Cash", "Liquidate"]) {
      change("Trade Type", type);
      expect(screen.queryByRole("group", { name: "ESG Filters (Direct Indexing)" })).toBeNull();
      expect(screen.queryByLabelText("State Residence")).toBeNull();
    }
  });

  it("Other accepts a description; None clears everything; another filter clears None", async () => {
    await openForm();
    fireEvent.click(esgBox("Tobacco"));
    expect(esgBox("Tobacco").checked).toBe(true);
    expect(esgBox("None").checked).toBe(false);
    fireEvent.click(esgBox("Other"));
    const other = screen.getByRole("textbox", { name: "Custom ESG filter" }) as HTMLInputElement;
    expect(other.placeholder).toBe("Specify custom ESG filter...");
    fireEvent.change(other, { target: { value: "Palm oil" } });
    expect(other.value).toBe("Palm oil");
    fireEvent.click(esgBox("None"));
    expect(esgBox("None").checked).toBe(true);
    expect(esgBox("Tobacco").checked).toBe(false);
    expect(esgBox("Other").checked).toBe(false);
    expect(screen.queryByRole("textbox", { name: "Custom ESG filter" })).toBeNull();
    fireEvent.click(esgBox("Other"));
    expect((screen.getByRole("textbox", { name: "Custom ESG filter" }) as HTMLInputElement).value).toBe("");
    expect(esgBox("None").checked).toBe(false);
  });

  it("keeps residence and approval values and the notes field with its placeholder", async () => {
    await openForm();
    change("State Residence", "NY");
    change("Liquidation Approval", "Yes");
    expect(field("State Residence").value).toBe("NY");
    expect(field("Liquidation Approval").value).toBe("Yes");
    const notes = field("Advisor Compliance & Execution Notes");
    expect(notes.placeholder).toBe("e.g., Prioritize sale of lowest basis tax lots first. Maintain 3% minimum cash position post-trade.");
    fireEvent.change(notes, { target: { value: "Lowest basis first" } });
    expect(notes.value).toBe("Lowest basis first");
  });
});

describe("no-plan copy switch (ticket)", () => {
  const CASH_NOTE = "After you submit, a trader will verify holdings and place the trades.";
  const REBALANCE_ON = "A trader will rebalance all selected accounts for this client to the target allocation.";
  const TODAY_NOTE = "Execution plan: A detailed plan is not generated on submit for cash deposits. After you submit, a trader will verify holdings and generate the execution plan.";
  const TODAY_REBALANCE_ON = "The engine will redistribute holdings across all selected accounts for this client to match the target allocation.";

  async function openFormWithSwitch(enabled: boolean) {
    const form = createElement(NewRequestDraftProvider, null, createElement(NewRequestForm, { onSubmit }));
    render(createElement(NoPlanCopyProvider, { enabled, children: form }));
    await screen.findByRole("heading", { name: "New Trade Request" });
  }
  async function openCashDeposit(enabled: boolean) {
    await openFormWithSwitch(enabled);
    change("Trade Type", "Cash Deposit");
    selectAlexAccount();
    await screen.findByRole("heading", { name: "2. Deposit Details" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Also rebalance all selected accounts to target allocation" }));
  }
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is on only when the epic master and the switch are both exactly \"1\"", () => {
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "");
    vi.stubEnv("TRADE_REQUESTS_NO_PLAN_COPY", "1");
    expect(tradeRequestsNoPlanCopyEnabled()).toBe(false);
    vi.stubEnv("EPIC_TRADE_REQUESTS_BACKEND_MOVE", "1");
    vi.stubEnv("TRADE_REQUESTS_NO_PLAN_COPY", "");
    expect(tradeRequestsNoPlanCopyEnabled()).toBe(false);
    vi.stubEnv("TRADE_REQUESTS_NO_PLAN_COPY", "true");
    expect(tradeRequestsNoPlanCopyEnabled()).toBe(false);
    vi.stubEnv("TRADE_REQUESTS_NO_PLAN_COPY", "1");
    expect(tradeRequestsNoPlanCopyEnabled()).toBe(true);
  });

  it("selects the Cash Deposit note and the rebalance-all text by switch position (AC-12, AC-13)", () => {
    expect(cashDepositNote(true)).toEqual({ lead: null, text: CASH_NOTE });
    expect(cashDepositNote(false)).toEqual({ lead: "Execution plan:", text: TODAY_NOTE.slice("Execution plan: ".length) });
    expect(rebalanceAllText(true, true)).toBe(REBALANCE_ON);
    expect(rebalanceAllText(true, false)).toBe(TODAY_REBALANCE_ON);
    expect(rebalanceAllText(false, true)).toBe("Only the deposit account will receive trades. Other selected accounts remain unchanged.");
    expect(rebalanceAllText(false, false)).toBe("Only the deposit account will receive trades. Other selected accounts remain unchanged.");
  });

  it("labels Initial Funding \"Submit Trade Request\" with the switch on and leaves the other labels alone (AC-90)", () => {
    const draft = initialNewRequestDraft();
    expect(newRequestSubmitLabel(draft, false, true)).toBe("Submit Trade Request");
    expect(newRequestSubmitLabel({ ...draft, formMode: "clone" }, false, true)).toBe("Submit Trade Request");
    expect(newRequestSubmitLabel({ ...draft, formMode: "edit" }, false, true)).toBe("Resubmit to Trader");
    expect(newRequestSubmitLabel(draft, true, true)).toBe("Submitting...");
    expect(newRequestSubmitLabel(draft)).toBe("Generate Plan & Submit");
    expect(newRequestSubmitLabel(draft, false, false)).toBe("Generate Plan & Submit");
  });

  it("switch on: the Cash Deposit form names a trader, not the engine or an execution plan (AC-12, AC-13)", async () => {
    await openCashDeposit(true);
    expect(screen.getByRole("note").textContent).toBe(CASH_NOTE);
    expect(screen.getByText(REBALANCE_ON)).toBeTruthy();
    expect(screen.queryByText(/engine/i)).toBeNull();
    expect(screen.queryByText(/execution plan/i)).toBeNull();
  });

  it("switch on: the Initial Funding submit button reads \"Submit Trade Request\" (AC-90)", async () => {
    await openFormWithSwitch(true);
    expect(field("Trade Type").value).toBe("Initial Funding");
    expect(submitButton().textContent).toBe("Submit Trade Request");
    expect(screen.queryByRole("button", { name: "Generate Plan & Submit" })).toBeNull();
  });

  it("switch off: today's note, rebalance-all text and Initial Funding label are unchanged", async () => {
    await openFormWithSwitch(false);
    expect(submitButton().textContent).toBe("Generate Plan & Submit");
    cleanup();
    await openCashDeposit(false);
    expect(screen.getByRole("note").textContent).toBe(TODAY_NOTE);
    expect(screen.getByText(TODAY_REBALANCE_ON)).toBeTruthy();
  });
});
