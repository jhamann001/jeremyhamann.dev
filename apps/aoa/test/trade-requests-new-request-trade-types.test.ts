import { describe, expect, it } from "vitest";
import {
  clientsById,
  hasAccountSelection,
  initialNewRequestDraft,
  newRequestSubmitEnabled,
  withAccountToggled,
  withClients,
  withManualMode,
  type NewRequestDraft,
} from "@/lib/trade-requests/new-request";
import {
  ESG_OPTIONS,
  PRIORITIES,
  defaultEsgFilters,
  fullFormSectionsVisible,
  isFullFormTradeType,
  liquidateInputsProvided,
  raiseCashInputsProvided,
  toggleEsgFilter,
  withTradeType,
} from "@/lib/trade-requests/new-request-trade-types";

const byId = clientsById([{ id: "c-alex", name: "Maeve Brennan", accounts: [{ id: "a1", accountNumber: "SYN00001", accountType: "Taxable", balance: 1_000 }] }]);
const draft = (patch: Partial<NewRequestDraft>): NewRequestDraft => ({
  ...initialNewRequestDraft(), clientIds: ["c-alex"], selectedAccounts: ["SYN00001"], priority: "Standard", ...patch,
});
const enabled = (patch: Partial<NewRequestDraft>) => newRequestSubmitEnabled({ draft: draft(patch), clientsById: byId });

describe("initial state", () => {
  it("starts with no priority, Other residence, no approval, ESG None and empty per-type inputs", () => {
    expect(initialNewRequestDraft()).toMatchObject({
      tradeType: "Initial Funding", priority: "", residence: "Other", liquidationApproval: "", tradeAmount: "", depositAccount: "",
      rebalanceAll: false, raiseCashReason: "", liquidityDeadline: "", liquidateOption: "", liquidatePositions: "", advisorNotes: "",
      esgFilters: defaultEsgFilters(),
    });
    expect(defaultEsgFilters()).toMatchObject({ none: true, other: false, otherDescription: "" });
  });

  it("offers the priorities Urgent, Standard and Low (AC-131)", () => {
    expect(PRIORITIES).toEqual(["Urgent", "Standard", "Low"]);
  });

  it("lists the seven ESG filters in the standalone order (AC-93)", () => {
    expect(ESG_OPTIONS.map((option) => option.label)).toEqual(["Fossil Fuels", "Tobacco", "Weapons", "Alcohol", "Gambling", "Other", "None"]);
  });
});

describe("priority gate", () => {
  it("keeps Submit disabled until a priority is chosen, for every trade type", () => {
    expect(enabled({ priority: "" })).toBe(false);
    expect(enabled({ priority: "Urgent", liquidationApproval: "Yes", riskProfile: 12,
      equityStrategies: [{ id: 1, benchmark: "SPY", allocation: "100", rationale: "Synthetic rationale" }] })).toBe(true);
    expect(enabled({ ...withTradeType(draft({}), "Raise Cash"), priority: "", tradeAmount: "$5,000", raiseCashReason: "Tax" })).toBe(false);
  });
});

describe("Raise Cash gate (AC-35, AC-132)", () => {
  const raise = (patch: Partial<NewRequestDraft>) => ({ ...withTradeType(draft({}), "Raise Cash"), ...patch });
  it("needs a trade amount and a non-blank reason; the deadline stays optional", () => {
    expect(raiseCashInputsProvided(raise({}))).toBe(false);
    expect(raiseCashInputsProvided(raise({ tradeAmount: "$50,000" }))).toBe(false);
    expect(raiseCashInputsProvided(raise({ tradeAmount: "$50,000", raiseCashReason: "   " }))).toBe(false);
    expect(raiseCashInputsProvided(raise({ tradeAmount: "", raiseCashReason: "Distribution" }))).toBe(false);
    expect(raiseCashInputsProvided(raise({ tradeAmount: "   ", raiseCashReason: "Distribution" }))).toBe(false);
    expect(raiseCashInputsProvided(raise({ tradeAmount: "$50,000", raiseCashReason: "Distribution" }))).toBe(true);
    expect(enabled(raise({ tradeAmount: "$50,000", raiseCashReason: "Distribution", liquidityDeadline: "" }))).toBe(true);
    expect(enabled(raise({ tradeAmount: "$50,000", raiseCashReason: "Distribution", liquidityDeadline: "2026-11-02" }))).toBe(true);
  });

  it("still needs client and accounts", () => {
    expect(enabled(raise({ tradeAmount: "1", raiseCashReason: "x", selectedAccounts: [] }))).toBe(false);
  });

  it("does not apply to other trade types", () => {
    expect(raiseCashInputsProvided(draft({ tradeType: "Rebalance" }))).toBe(true);
  });
});

describe("Liquidate gate (AC-36, AC-37)", () => {
  const liquidate = (patch: Partial<NewRequestDraft>) => ({ ...withTradeType(draft({}), "Liquidate"), ...patch });
  it("needs an option, and positions for Specific Positions", () => {
    expect(liquidateInputsProvided(liquidate({}))).toBe(false);
    expect(liquidateInputsProvided(liquidate({ liquidateOption: "Entire Account" }))).toBe(true);
    expect(liquidateInputsProvided(liquidate({ liquidateOption: "Specific Positions" }))).toBe(false);
    expect(liquidateInputsProvided(liquidate({ liquidateOption: "Specific Positions", liquidatePositions: "  " }))).toBe(false);
    expect(liquidateInputsProvided(liquidate({ liquidateOption: "Specific Positions", liquidatePositions: "AAPL, MSFT" }))).toBe(true);
    expect(enabled(liquidate({ liquidateOption: "Entire Account" }))).toBe(true);
    expect(enabled(liquidate({ liquidateOption: "Entire Account", priority: "" }))).toBe(false);
    expect(enabled(liquidate({ liquidateOption: "Entire Account", clientIds: [], selectedAccounts: [] }))).toBe(false);
  });

  it("does not apply to other trade types", () => {
    expect(liquidateInputsProvided(draft({ tradeType: "Cash Deposit" }))).toBe(true);
  });
});

describe("trade-type change and client change", () => {
  it("clears the per-type inputs and sets the rebalance-all default", () => {
    const filled = draft({
      tradeType: "Cash Deposit", tradeAmount: "$1", depositAccount: "SYN00001", rebalanceAll: true, raiseCashReason: "r",
      liquidityDeadline: "2026-11-02", liquidateOption: "Entire Account", liquidatePositions: "AAPL", advisorNotes: "keep",
      residence: "NY", liquidationApproval: "Yes",
    });
    expect(withTradeType(filled, "Raise Cash")).toMatchObject({
      tradeType: "Raise Cash", tradeAmount: "", depositAccount: "", rebalanceAll: false, raiseCashReason: "", liquidityDeadline: "",
      liquidateOption: "", liquidatePositions: "", advisorNotes: "keep", residence: "NY", liquidationApproval: "Yes", priority: "Standard",
    });
    expect(withTradeType(filled, "Rebalance").rebalanceAll).toBe(true);
    expect(withTradeType(filled, "Initial Funding").rebalanceAll).toBe(true);
    expect(withTradeType(filled, "Cash Deposit").rebalanceAll).toBe(false);
  });

  it("a client change clears the deposit account", () => {
    expect(withClients(draft({ depositAccount: "SYN00001" }), ["c-alex"]).depositAccount).toBe("");
  });

  it("unticking the deposit account or switching to manual entry clears it; other toggles keep it", () => {
    const deposit = draft({ tradeType: "Cash Deposit", selectedAccounts: ["SYN00001", "SYN00002"], depositAccount: "SYN00002" });
    expect(withAccountToggled(deposit, "SYN00002")).toMatchObject({ selectedAccounts: ["SYN00001"], depositAccount: "" });
    expect(withAccountToggled(deposit, "SYN00001")).toMatchObject({ selectedAccounts: ["SYN00002"], depositAccount: "SYN00002" });
    expect(withAccountToggled(deposit, "SYN00003").depositAccount).toBe("SYN00002");
    expect(withManualMode(deposit, true).depositAccount).toBe("");
  });
});

describe("ESG filters (AC-137, AC-139)", () => {
  it("None clears every other filter and the Other description", () => {
    const busy = { ...defaultEsgFilters(), none: false, tobacco: true, other: true, otherDescription: "Palm oil" };
    expect(toggleEsgFilter(busy, "none")).toEqual(defaultEsgFilters());
  });

  it("any other filter clears None", () => {
    for (const key of ["fossilFuels", "tobacco", "weapons", "alcohol", "gambling", "other"] as const) {
      const next = toggleEsgFilter(defaultEsgFilters(), key);
      expect(next[key]).toBe(true);
      expect(next.none).toBe(false);
    }
  });

  it("unchecking Other clears its description; unchecking a filter keeps None cleared", () => {
    const withOther = { ...toggleEsgFilter(defaultEsgFilters(), "other"), otherDescription: "Palm oil" };
    expect(toggleEsgFilter(withOther, "other")).toMatchObject({ other: false, otherDescription: "", none: false });
    expect(toggleEsgFilter(toggleEsgFilter(defaultEsgFilters(), "weapons"), "weapons")).toMatchObject({ weapons: false, none: false });
  });
});

describe("visibility helpers", () => {
  it("full-form sections are for Initial Funding, Rebalance and Cash Deposit", () => {
    expect(["Initial Funding", "Rebalance", "Cash Deposit", "Raise Cash", "Liquidate"].map((t) => isFullFormTradeType(t as never)))
      .toEqual([true, true, true, false, false]);
    expect(fullFormSectionsVisible(draft({ tradeType: "Liquidate" }))).toBe(false);
  });

  it("an account counts as selected when listed, or when every selected manual account is complete", () => {
    expect(hasAccountSelection(draft({}))).toBe(true);
    expect(hasAccountSelection(draft({ selectedAccounts: [] }))).toBe(false);
    const manual = draft({ manualMode: true, manualAccounts: [{ id: "m1", accountNumber: "M1", accountType: "Taxable", balance: "0" }], manualSelectedIds: ["m1"] });
    expect(hasAccountSelection(manual)).toBe(false);
    expect(hasAccountSelection({ ...manual, manualAccounts: [{ ...manual.manualAccounts[0], balance: "10" }] })).toBe(true);
  });
});
