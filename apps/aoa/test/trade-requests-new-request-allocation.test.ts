import { describe, expect, it } from "vitest";
import {
  NEW_REQUEST_SUBMIT_GATES,
  clientsById,
  initialNewRequestDraft,
  newRequestSubmitEnabled,
  type NewRequestDraft,
} from "@/lib/trade-requests/new-request";
import {
  MAX_RATIONALE_CHARS,
  allocationChoiceSettled,
  allocationRationaleRequired,
  cashDepositInputsProvided,
  defaultEquityStrategies,
  equityTotal,
  initialAllocationInputs,
  isMaterialAllocationChange,
  moneyMarketMismatch,
  moneyMarketTarget,
  previousAllocationLoading,
  previousAllocationPromptVisible,
  priorAllocationClientId,
  priorAllocationKey,
  priorAllocationSummary,
  rationaleCount,
  rationaleCountTone,
  riskAllocation,
  strategiesProvided,
  strategyRationalesProvided,
  withPreviousAllocationApplied,
  withPreviousAllocationDeclined,
  withPriorAllocationLoaded,
  withPriorAllocationTarget,
  withStrategyAdded,
  withStrategyRemoved,
  withStrategyUpdated,
  type PriorAllocation,
} from "@/lib/trade-requests/new-request-allocation";
import { fullFormSectionsVisible, withTradeType } from "@/lib/trade-requests/new-request-trade-types";

const byId = clientsById([
  { id: "c-alex", name: "Maeve Brennan", accounts: [
    { id: "a1", accountNumber: "SYN00001", accountType: "Taxable", balance: 1_000 },
    { id: "a2", accountNumber: "SYN00002", accountType: "Roth IRA", balance: 2_000 }] },
  { id: "c-blair", name: "Lucille Howell", accounts: [{ id: "a3", accountNumber: "SYN00003", accountType: "Traditional IRA", balance: 3_000 }] },
]);
const PRIOR: PriorAllocation = {
  riskProfile: 12, baseAllocation: { equity: 61, fixed: 34.5, cash: 4.5 },
  equityStrategies: [{ id: 1, benchmark: "SPY", allocation: 60, rationale: "core" }, { id: 2, benchmark: "EFA", allocation: 40, rationale: "intl" }],
};
const strategy = (benchmark: string, allocation = "100", rationale = "") => ({ id: 1, benchmark, allocation, rationale });
const complete: Partial<NewRequestDraft> = {
  clientIds: ["c-alex"], selectedAccounts: ["SYN00001"], priority: "Standard", liquidationApproval: "Yes", riskProfile: 12,
  equityStrategies: [strategy("SPY", "100", "Synthetic rationale")],
};
const draft = (patch: Partial<NewRequestDraft> = {}): NewRequestDraft => ({ ...initialNewRequestDraft(), ...complete, ...patch });
const ctx = (patch: Partial<NewRequestDraft> = {}) => ({ draft: draft(patch), clientsById: byId });
const enabled = (patch: Partial<NewRequestDraft> = {}) => newRequestSubmitEnabled(ctx(patch));
/** A Rebalance draft whose prior allocation has loaded for the first client. */
const loaded = (patch: Partial<NewRequestDraft> = {}, prior: PriorAllocation | null = PRIOR) => {
  const base = withTradeType(draft(), "Rebalance");
  const key = priorAllocationKey(base);
  return { ...withPriorAllocationLoaded(withPriorAllocationTarget(base, key), key, prior), ...patch };
};

describe("defaults (AC-136) and the base allocation (AC-95)", () => {
  it("starts a new request with one strategy, SPY at 100%, no risk score and the choice unanswered", () => {
    expect(initialAllocationInputs()).toMatchObject({
      formMode: "new", riskProfile: null, usePreviousAllocation: null, equityStrategies: [{ id: 1, benchmark: "SPY", allocation: "100", rationale: "" }],
    });
    expect(initialNewRequestDraft().equityStrategies).toEqual(defaultEquityStrategies());
  });

  it("assigns the service's base allocation to each risk score", () => {
    expect(riskAllocation(1)).toEqual({ equity: 0, fixed: 0, cash: 100 });
    expect(riskAllocation(6)).toEqual({ equity: 43, fixed: 49.5, cash: 7.5 });
    expect(riskAllocation(12)).toEqual({ equity: 61, fixed: 34.5, cash: 4.5 });
    expect(riskAllocation(25)).toEqual({ equity: 100, fixed: 0, cash: 0 });
    for (let score = 1; score <= 25; score++) {
      const { equity, fixed, cash } = riskAllocation(score);
      expect(equity + fixed + cash).toBeCloseTo(100);
    }
  });
});

describe("Submit gates for Initial Funding, Rebalance and Cash Deposit (AC-33, AC-34)", () => {
  it("registers TRW-14's gates after the earlier ones", () => {
    expect(NEW_REQUEST_SUBMIT_GATES.filter((g) => g.owner === "TRW-14").map((g) => g.id))
      .toEqual(["full-form-compliance", "risk-score", "strategies", "strategy-rationales", "cash-deposit"]);
  });

  it("Initial Funding needs approval, a risk score, benchmarks and a 100% total", () => {
    expect(enabled()).toBe(true);
    expect(enabled({ liquidationApproval: "" })).toBe(false);
    expect(enabled({ riskProfile: null })).toBe(false);
    expect(enabled({ equityStrategies: [strategy("  ", "100", "x")] })).toBe(false);
    expect(enabled({ equityStrategies: [strategy("SPY", "90", "x")] })).toBe(false);
    expect(enabled({ equityStrategies: [strategy("SPY", "60", "x"), { id: 2, benchmark: "EFA", allocation: "40", rationale: "y" }] })).toBe(true);
    expect(enabled({ clientIds: [], selectedAccounts: [] })).toBe(false);
    expect(enabled({ priority: "" })).toBe(false);
  });

  it("Rebalance has the same gates", () => {
    const rebalance = loaded({ riskProfile: 12, equityStrategies: [strategy("SPY", "100", "x")] });
    expect(newRequestSubmitEnabled({ draft: rebalance, clientsById: byId })).toBe(true);
    expect(newRequestSubmitEnabled({ draft: { ...rebalance, liquidationApproval: "" }, clientsById: byId })).toBe(false);
    expect(newRequestSubmitEnabled({ draft: { ...rebalance, riskProfile: null }, clientsById: byId })).toBe(false);
  });

  it("Cash Deposit also needs a non-blank amount and a deposit account", () => {
    const deposit = (patch: Partial<NewRequestDraft>) => ({ ...withTradeType(draft(), "Cash Deposit"), ...patch });
    expect(cashDepositInputsProvided(deposit({}))).toBe(false);
    expect(cashDepositInputsProvided(deposit({ tradeAmount: "   ", depositAccount: "SYN00001" }))).toBe(false);
    expect(cashDepositInputsProvided(deposit({ tradeAmount: "$150,000", depositAccount: "" }))).toBe(false);
    expect(cashDepositInputsProvided(deposit({ tradeAmount: "$150,000", depositAccount: "SYN00001" }))).toBe(true);
    expect(newRequestSubmitEnabled({ draft: deposit({ tradeAmount: "$150,000", depositAccount: "SYN00001" }), clientsById: byId })).toBe(true);
    expect(newRequestSubmitEnabled({ draft: deposit({ tradeAmount: "$150,000", depositAccount: "SYN00001", riskProfile: null }), clientsById: byId }))
      .toBe(false);
  });

  it("does not apply to Raise Cash or Liquidate", () => {
    const raise = { ...withTradeType(draft({ liquidationApproval: "", riskProfile: null, equityStrategies: [] }), "Raise Cash"),
      tradeAmount: "1", raiseCashReason: "x" };
    expect(strategiesProvided(raise)).toBe(true);
    expect(newRequestSubmitEnabled({ draft: raise, clientsById: byId })).toBe(true);
  });

  it("totals typed percentages, counting blanks as zero", () => {
    expect(equityTotal(draft({ equityStrategies: [strategy("SPY", "50"), { id: 2, benchmark: "EFA", allocation: "", rationale: "" }] }))).toBe(50);
  });
});

describe("rationale rules (AC-38, AC-71, AC-72)", () => {
  it("Initial Funding always requires a non-blank rationale", () => {
    expect(allocationRationaleRequired(draft())).toBe(true);
    expect(enabled({ equityStrategies: [strategy("SPY", "100", "   ")] })).toBe(false);
  });

  it("Rebalance and Cash Deposit require it for a manual client, while loading, or with no prior allocation", () => {
    const manual = withTradeType(draft({ manualMode: true, clientIds: [] }), "Rebalance");
    expect(allocationRationaleRequired(withPriorAllocationTarget(manual, priorAllocationKey(manual)))).toBe(true);
    const base = withTradeType(draft(), "Cash Deposit");
    const loading = withPriorAllocationTarget(base, priorAllocationKey(base));
    expect(loading.priorAllocation.status).toBe("loading");
    expect(allocationRationaleRequired(loading)).toBe(true);
    expect(allocationRationaleRequired(loaded({}, null))).toBe(true);
  });

  it("Rebalance with an unchanged prior allocation makes the rationale optional; a material change requires it", () => {
    const same = loaded(withPreviousAllocationApplied(loaded()));
    expect(allocationRationaleRequired(same)).toBe(false);
    const rationaleFree = { ...same, equityStrategies: same.equityStrategies.map((s) => ({ ...s, rationale: "" })) };
    expect(strategyRationalesProvided({ draft: rationaleFree, clientsById: byId })).toBe(true);
    expect(allocationRationaleRequired({ ...same, riskProfile: 13 })).toBe(true);
    expect(allocationRationaleRequired(withStrategyUpdated(same, 1, { allocation: "55" }))).toBe(true);
    expect(allocationRationaleRequired({ ...same, riskProfile: null })).toBe(false);
  });

  it("compares as Business Rules → Material change", () => {
    const base = { riskProfile: 12, baseAllocation: { equity: 61, fixed: 34.5, cash: 4.5 }, equityStrategies: [
      { benchmark: "SPY", allocation: 60 }, { benchmark: "EFA", allocation: 40 }] };
    expect(isMaterialAllocationChange(base, base)).toBe(false);
    expect(isMaterialAllocationChange({ ...base, equityStrategies: [
      { benchmark: " efa ", allocation: "40.005" }, { benchmark: "spy", allocation: 60 }] }, base)).toBe(false);
    expect(isMaterialAllocationChange({ ...base, riskProfile: 13 }, base)).toBe(true);
    expect(isMaterialAllocationChange({ ...base, baseAllocation: { equity: 61.02, fixed: 34.5, cash: 4.5 } }, base)).toBe(true);
    expect(isMaterialAllocationChange({ ...base, equityStrategies: [{ benchmark: "SPY", allocation: 100 }] }, base)).toBe(true);
    expect(isMaterialAllocationChange({ ...base, equityStrategies: [
      { benchmark: "SPY", allocation: 60 }, { benchmark: "EEM", allocation: 40 }] }, base)).toBe(true);
    expect(isMaterialAllocationChange({ ...base, equityStrategies: [
      { benchmark: "SPY", allocation: 59.9 }, { benchmark: "EFA", allocation: 40.1 }] }, base)).toBe(true);
  });
});

describe("money-market rule (AC-73, AC-74)", () => {
  const mmk = (benchmark: string, patch: Partial<NewRequestDraft> = {}) => moneyMarketMismatch(ctx(patch), strategy(benchmark));

  it("ignores ordinary benchmarks and the template ticker of every selected account", () => {
    expect(mmk("SPY")).toBeNull();
    expect(mmk("vmsxx")).toBeNull();
    expect(mmk("VYFXX", { residence: "NY" })).toBeNull();
    expect(mmk("SWVXX", { selectedAccounts: ["SYN00002"] })).toBeNull();
  });

  it("names the entered and expected tickers and the mismatched account types", () => {
    expect(mmk("SPAXX")).toEqual({ entered: "SPAXX", expected: ["VMSXX"], mismatchedTypes: ["Taxable"] });
    const both = mmk("SWVXX", { selectedAccounts: ["SYN00001", "SYN00002"], residence: "CA" });
    expect(both).toEqual({ entered: "SWVXX", expected: ["VCTXX", "SWVXX"], mismatchedTypes: ["Taxable"] });
    expect(moneyMarketTarget(both!, "CA", ["Taxable", "Roth IRA"])).toBe("the selected Taxable account in CA");
    const iras = mmk("VMSXX", { clientIds: ["c-alex", "c-blair"], selectedAccounts: ["SYN00002", "SYN00003"], residence: "NY" });
    expect(iras?.mismatchedTypes).toEqual(["Roth IRA", "Traditional IRA"]);
    expect(moneyMarketTarget(iras!, "NY", ["Roth IRA", "Traditional IRA"])).toBe("the selected Roth IRA / Traditional IRA accounts");
  });

  it("before any account is selected, warns for a ticker no account type could expect under the residence", () => {
    const none = mmk("VYFXX", { selectedAccounts: [] });
    expect(none).toEqual({ entered: "VYFXX", expected: ["VMSXX", "SWVXX"], mismatchedTypes: [] });
    expect(moneyMarketTarget(none!, "Other", [])).toBe("the non-state-preference residence on this request");
    expect(mmk("SWVXX", { selectedAccounts: [] })).toBeNull();
  });

  it("uses manual account types in manual mode", () => {
    const manual = { manualMode: true, clientIds: [], selectedAccounts: [], manualClientName: "Sam", manualSelectedIds: ["m1"],
      manualAccounts: [{ id: "m1", accountNumber: "M1", accountType: "Roth IRA" as const, balance: "10" }] };
    expect(mmk("SWVXX", manual)).toBeNull();
    expect(mmk("VMSXX", manual)?.mismatchedTypes).toEqual(["Roth IRA"]);
  });

  it("requires that strategy's rationale even when the allocation is unchanged", () => {
    const same = withPreviousAllocationApplied(loaded({}, { ...PRIOR, equityStrategies: [{ id: 1, benchmark: "SPAXX", allocation: 100, rationale: "" }] }));
    expect(allocationRationaleRequired(same)).toBe(false);
    const cleared = { ...same, equityStrategies: [strategy("SPAXX", "100", "")] };
    expect(strategyRationalesProvided({ draft: cleared, clientsById: byId })).toBe(false);
    expect(strategyRationalesProvided({ draft: { ...cleared, equityStrategies: [strategy("SPAXX", "100", "Parking cash")] }, clientsById: byId }))
      .toBe(true);
  });
});

describe("previous allocation (AC-96 to AC-99)", () => {
  it("keys the load on the trade type, the first selected client and manual entry", () => {
    expect(priorAllocationKey(draft())).toBe("none");
    const rebalance = withTradeType(draft({ clientIds: ["c-blair", "c-alex"] }), "Rebalance");
    expect(priorAllocationKey(rebalance)).toBe("client:Rebalance:c-blair");
    expect(priorAllocationClientId(rebalance, priorAllocationKey(rebalance))).toBe("c-blair");
    expect(priorAllocationKey({ ...rebalance, tradeType: "Cash Deposit" })).toBe("client:Cash Deposit:c-blair");
    expect(priorAllocationKey({ ...rebalance, clientIds: [] })).toBe("none");
    expect(priorAllocationKey({ ...rebalance, manualMode: true, clientIds: [] })).toBe("manual:Rebalance");
    expect(priorAllocationClientId(rebalance, "manual:Rebalance")).toBeNull();
  });

  it("shows the prompt once loaded and hides the mandate inputs until answered", () => {
    const base = withTradeType(draft(), "Rebalance");
    const loading = withPriorAllocationTarget(base, priorAllocationKey(base));
    expect(previousAllocationLoading(loading)).toBe(true);
    expect(previousAllocationPromptVisible(loading)).toBe(false);
    expect(fullFormSectionsVisible(loading)).toBe(false);
    const ready = loaded();
    expect(previousAllocationPromptVisible(ready)).toBe(true);
    expect(allocationChoiceSettled(ready)).toBe(false);
    expect(fullFormSectionsVisible(ready)).toBe(false);
    expect(priorAllocationSummary(PRIOR)).toBe("Risk Level 12 — SPY (60%), EFA (40%)");
  });

  it("treats no prior allocation (none, no access, failure) as answered No, and a manual client as No", () => {
    const none = loaded({}, null);
    expect(none.usePreviousAllocation).toBe(false);
    expect(previousAllocationPromptVisible(none)).toBe(false);
    expect(fullFormSectionsVisible(none)).toBe(true);
    const manual = withTradeType(draft({ manualMode: true, clientIds: [] }), "Cash Deposit");
    expect(withPriorAllocationTarget(manual, priorAllocationKey(manual)).usePreviousAllocation).toBe(false);
  });

  it("treats the stored state as loading until the loader catches up with a new first client or trade type", () => {
    const answered = withPreviousAllocationApplied(loaded());
    const unchanged = { ...answered, equityStrategies: answered.equityStrategies.map((s) => ({ ...s, rationale: "" })) };
    expect(allocationRationaleRequired(unchanged)).toBe(false);
    for (const moved of [{ ...unchanged, clientIds: ["c-blair"] }, { ...unchanged, tradeType: "Cash Deposit" as const }]) {
      expect(moved.priorAllocation.key).not.toBe(priorAllocationKey(moved));
      expect(allocationRationaleRequired(moved)).toBe(true);
      expect(previousAllocationLoading(moved)).toBe(true);
      expect(strategyRationalesProvided({ draft: moved, clientsById: byId })).toBe(false);
    }
    const unanswered = { ...loaded(), clientIds: ["c-blair"] };
    expect(previousAllocationPromptVisible(loaded())).toBe(true);
    expect(previousAllocationPromptVisible(unanswered)).toBe(false);
    expect(previousAllocationLoading(unanswered)).toBe(true);
  });

  it("ignores a load that finished after the target changed", () => {
    const ready = loaded();
    const moved = withPriorAllocationTarget(ready, "client:Rebalance:c-blair");
    expect(withPriorAllocationLoaded(moved, "client:Rebalance:c-alex", PRIOR)).toBe(moved);
  });

  it("Yes fills the risk score and strategies; No clears them to the defaults", () => {
    const yes = withPreviousAllocationApplied(loaded({ riskProfile: 3 }));
    expect(yes.usePreviousAllocation).toBe(true);
    expect(yes.riskProfile).toBe(12);
    expect(yes.equityStrategies).toEqual([
      { id: 1, benchmark: "SPY", allocation: "60", rationale: "core" }, { id: 2, benchmark: "EFA", allocation: "40", rationale: "intl" }]);
    expect(fullFormSectionsVisible(yes)).toBe(true);
    const no = withPreviousAllocationDeclined(loaded({ riskProfile: 3, equityStrategies: [strategy("QQQ")] }));
    expect(no).toMatchObject({ usePreviousAllocation: false, riskProfile: null, equityStrategies: defaultEquityStrategies() });
    expect(fullFormSectionsVisible(no)).toBe(true);
  });

  it("does not prompt outside new requests or for Initial Funding", () => {
    expect(previousAllocationPromptVisible({ ...loaded(), formMode: "edit" })).toBe(false);
    expect(allocationChoiceSettled({ ...loaded(), formMode: "clone" })).toBe(true);
    expect(previousAllocationPromptVisible(draft())).toBe(false);
    expect(allocationChoiceSettled(draft())).toBe(true);
  });
});

describe("strategies (AC-135, AC-145, AC-147)", () => {
  it("adds up to three strategies and removes by id", () => {
    const two = withStrategyAdded(draft());
    expect(two.equityStrategies).toEqual([strategy("SPY", "100", "Synthetic rationale"), { id: 2, benchmark: "", allocation: "0", rationale: "" }]);
    const three = withStrategyAdded(two);
    expect(withStrategyAdded(three)).toBe(three);
    expect(withStrategyRemoved(three, 2).equityStrategies.map((s) => s.id)).toEqual([1, 3]);
  });

  it("keeps a rationale to 5,000 characters and counts it", () => {
    const long = withStrategyUpdated(draft(), 1, { rationale: "x".repeat(MAX_RATIONALE_CHARS + 25) });
    expect(long.equityStrategies[0].rationale).toHaveLength(MAX_RATIONALE_CHARS);
    expect(rationaleCount(long.equityStrategies[0].rationale)).toBe("5,000 / 5,000");
    expect(rationaleCount("abc")).toBe("3 / 5,000");
    expect(rationaleCountTone("x".repeat(4_499))).toBe("muted");
    expect(rationaleCountTone("x".repeat(4_500))).toBe("caution");
    expect(rationaleCountTone("x".repeat(5_000))).toBe("danger");
  });
});
