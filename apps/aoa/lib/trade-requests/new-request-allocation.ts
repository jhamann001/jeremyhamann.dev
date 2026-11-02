// New Request form: previous allocation, mandate and base allocation, equity
// strategies and the rationale rules. Pure state helpers and Submit gate
// predicates; no React, no service calls. The values live on NewRequestDraft.

import type { NewRequestContext, NewRequestDraft } from "./new-request";

export const ALLOCATION_COPY = {
  priorOnFile: "This client has an existing allocation on file.",
  usePrevious: "Yes, use previous allocation",
  startFresh: "No, start fresh",
  priorLoading: "Loading previous allocation data",
  mandate: "Mandate & Base Allocation",
  riskScore: "Client Risk Score",
  selectRiskScore: "— Select risk score —",
  riskScoreHelp: "Determines base asset allocation.",
  baseAllocation: "Resulting Base Allocation",
  equity: "Equity",
  fixed: "Fixed Inc.",
  cash: "Cash",
  unset: "—",
  equityStrategy: "Equity Strategy Construction",
  mustEqual: " — must equal 100%",
  benchmark: "Benchmark / Strategy",
  benchmarkPlaceholder: "Search or type ticker...",
  percentOfEquity: "% of Equity",
  removeStrategy: "Remove equity strategy",
  rationale: "Strategy Rationale (Reg BI)",
  optional: "(Optional)",
  rationaleRequiredTitle: "Required when setting a new or materially changed allocation.",
  rationaleOptionalTitle: "Optional because this allocation matches the last approved or completed allocation.",
  overrideTail: "Provide a Strategy Rationale below to override.",
} as const;

export const MAX_EQUITY_STRATEGIES = 3;
export const MAX_RATIONALE_CHARS = 5000;
export const RISK_SCORES = Array.from({ length: 25 }, (_, index) => index + 1);

export type BaseAllocation = { equity: number; fixed: number; cash: number };

/** Stock / bond / cash percentages per risk level, as in the service ("Asset Allocation Profiles Final 7.4.2025"). */
const RISK_TABLE: readonly BaseAllocation[] = [
  { equity: 0, fixed: 0, cash: 100 }, { equity: 10, fixed: 40, cash: 50 }, { equity: 20, fixed: 60, cash: 20 },
  { equity: 30, fixed: 58, cash: 12 }, { equity: 40, fixed: 52, cash: 8 }, { equity: 43, fixed: 49.5, cash: 7.5 },
  { equity: 46, fixed: 47, cash: 7 }, { equity: 49, fixed: 44.5, cash: 6.5 }, { equity: 52, fixed: 42, cash: 6 },
  { equity: 55, fixed: 39.5, cash: 5.5 }, { equity: 58, fixed: 37, cash: 5 }, { equity: 61, fixed: 34.5, cash: 4.5 },
  { equity: 64, fixed: 32, cash: 4 }, { equity: 67, fixed: 29.5, cash: 3.5 }, { equity: 70, fixed: 27, cash: 3 },
  { equity: 73, fixed: 24.5, cash: 2.5 }, { equity: 76, fixed: 22, cash: 2 }, { equity: 79, fixed: 19.5, cash: 1.5 },
  { equity: 82, fixed: 17, cash: 1 }, { equity: 85, fixed: 14.5, cash: 0.5 }, { equity: 88, fixed: 12, cash: 0 },
  { equity: 91, fixed: 9, cash: 0 }, { equity: 94, fixed: 6, cash: 0 }, { equity: 97, fixed: 3, cash: 0 },
  { equity: 100, fixed: 0, cash: 0 },
];

export function riskAllocation(score: number): BaseAllocation {
  return { ...RISK_TABLE[Math.max(0, Math.min(24, Math.round(score) - 1))] };
}

export const PRESET_BENCHMARKS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "URTH", label: "URTH – MSCI World" },
  { value: "SPY", label: "SPY – S&P 500" },
  { value: "IWB", label: "IWB – Russell 1000" },
  { value: "IWV", label: "IWV – Russell 3000" },
  { value: "ACWI", label: "ACWI – MSCI All Country World" },
  { value: "DIA", label: "DIA – Dow Jones Industrial" },
  { value: "QQQ", label: "QQQ – Nasdaq 100" },
  { value: "IWM", label: "IWM – Russell 2000" },
  { value: "SPMD", label: "SPMD – S&P 400 Mid Cap" },
  { value: "EQAL", label: "EQAL – Russell 1000 Equal Weight" },
  { value: "DBEF", label: "DBEF – Developed ex-US Hedged" },
  { value: "EFA", label: "EFA – Developed International" },
  { value: "EEM", label: "EEM – Emerging Markets" },
  { value: "IWD", label: "IWD – Russell 1000 Value" },
];

export const TEMPLATE_MMK_TICKERS = ["SWVXX", "VMSXX", "VYFXX", "VCTXX"] as const;
export type TemplateMmkTicker = (typeof TEMPLATE_MMK_TICKERS)[number];
export const KNOWN_MMK_TICKERS: readonly string[] = [
  ...TEMPLATE_MMK_TICKERS, "VUSXX", "SWKXX", "VMFXX", "VMRXX", "FZFXX", "SPAXX", "SPRXX", "FDRXX", "PCOXX", "BUPXX", "GMMXX",
];
const ALL_ACCOUNT_TYPES = ["Taxable", "Joint", "Traditional IRA", "Roth IRA"] as const;
const isIra = (accountType: string) => accountType === "Traditional IRA" || accountType === "Roth IRA";

/** The template money-market ticker for an account type and residence (IRAs ignore residence). */
export function allowedCashTicker(accountType: string, residence: string): TemplateMmkTicker {
  if (isIra(accountType)) return "SWVXX";
  if (residence === "NY") return "VYFXX";
  if (residence === "CA") return "VCTXX";
  return "VMSXX";
}

export function isKnownMmkTicker(symbol: string): boolean {
  return KNOWN_MMK_TICKERS.includes(symbol.trim().toUpperCase());
}

export type EquityStrategyInput = { id: number; benchmark: string; allocation: string; rationale: string };
export type PriorAllocation = {
  riskProfile: number;
  baseAllocation: BaseAllocation;
  equityStrategies: Array<{ id: number; benchmark: string; allocation: number; rationale: string }>;
};
/**
 * `key` names what the prior allocation was loaded for (see
 * priorAllocationKey); a settled state with a null allocation means none is
 * available to the user (none on file, no access, or the read failed).
 */
export type PriorAllocationState = { key: string; status: "loading" | "settled"; allocation: PriorAllocation | null };

/**
 * Allocation state carried on NewRequestDraft.
 *
 * - `formMode`: "new" for a new request; TRW-15 sets "edit" or "clone",
 *   which skips the previous-allocation prompt and shows the mandate inputs.
 * - `riskProfile`: 1–25, null until chosen.
 * - `equityStrategies`: one to three; `allocation` is the typed percentage
 *   (the service coerces it to a number).
 * - `priorAllocation`: the first selected client's prior allocation for
 *   Rebalance and Cash Deposit; change it only through the loader helpers.
 * - `usePreviousAllocation`: the prompt answer, null while unanswered.
 */
export type AllocationInputs = {
  formMode: "new" | "edit" | "clone";
  riskProfile: number | null;
  equityStrategies: EquityStrategyInput[];
  priorAllocation: PriorAllocationState;
  usePreviousAllocation: boolean | null;
};

const NO_PRIOR_KEY = "none";

export function defaultEquityStrategies(): EquityStrategyInput[] {
  return [{ id: 1, benchmark: "SPY", allocation: "100", rationale: "" }];
}

export function initialAllocationInputs(): AllocationInputs {
  return {
    formMode: "new", riskProfile: null, equityStrategies: defaultEquityStrategies(),
    priorAllocation: { key: NO_PRIOR_KEY, status: "settled", allocation: null }, usePreviousAllocation: null,
  };
}

const allocationTradeType = (draft: NewRequestDraft) =>
  draft.tradeType === "Initial Funding" || draft.tradeType === "Rebalance" || draft.tradeType === "Cash Deposit";

/** Rebalance and Cash Deposit compare against the first selected client's prior allocation. */
export function comparesPriorAllocation(draft: NewRequestDraft): boolean {
  return draft.tradeType === "Rebalance" || draft.tradeType === "Cash Deposit";
}

/** What the prior allocation must be loaded for; changes with the trade type, the first selected client and manual entry. */
export function priorAllocationKey(draft: NewRequestDraft): string {
  if (!comparesPriorAllocation(draft)) return NO_PRIOR_KEY;
  if (draft.manualMode) return `manual:${draft.tradeType}`;
  const first = draft.clientIds[0];
  return first ? `client:${draft.tradeType}:${first}` : NO_PRIOR_KEY;
}

/** The client to load for a key, or null when nothing is loaded. */
export function priorAllocationClientId(draft: NewRequestDraft, key: string): string | null {
  return key.startsWith("client:") ? draft.clientIds[0] ?? null : null;
}

/** Starts a load for a client key; a manual first client answers "No", anything else clears the choice. */
export function withPriorAllocationTarget(draft: NewRequestDraft, key: string): NewRequestDraft {
  if (key.startsWith("client:")) {
    return { ...draft, priorAllocation: { key, status: "loading", allocation: null }, usePreviousAllocation: null };
  }
  return {
    ...draft, priorAllocation: { key, status: "settled", allocation: null },
    usePreviousAllocation: key.startsWith("manual:") ? false : null,
  };
}

/** Records a finished load for the key it was started for; none available answers "No". */
export function withPriorAllocationLoaded(draft: NewRequestDraft, key: string, allocation: PriorAllocation | null): NewRequestDraft {
  if (draft.priorAllocation.key !== key) return draft;
  return {
    ...draft, priorAllocation: { key, status: "settled", allocation },
    usePreviousAllocation: allocation ? draft.usePreviousAllocation : false,
  };
}

/**
 * Until the loader catches up with a changed first client or trade type, the
 * stored state belongs to the previous key and counts as still loading.
 */
export function priorAllocationPending(draft: NewRequestDraft): boolean {
  return draft.priorAllocation.status === "loading" || draft.priorAllocation.key !== priorAllocationKey(draft);
}

export function previousAllocationPromptVisible(draft: NewRequestDraft): boolean {
  const prior = draft.priorAllocation;
  return draft.formMode === "new" && comparesPriorAllocation(draft) && !priorAllocationPending(draft) && !!prior.allocation
    && draft.usePreviousAllocation === null;
}

export function previousAllocationLoading(draft: NewRequestDraft): boolean {
  return draft.formMode === "new" && comparesPriorAllocation(draft) && draft.clientIds.length > 0 && priorAllocationPending(draft);
}

/** AC-98: for a new Rebalance or Cash Deposit request the mandate inputs wait for the previous-allocation answer. */
export function allocationChoiceSettled(draft: NewRequestDraft): boolean {
  return !comparesPriorAllocation(draft) || draft.formMode !== "new" || draft.usePreviousAllocation !== null;
}

/** AC-97 */
export function withPreviousAllocationApplied(draft: NewRequestDraft): NewRequestDraft {
  const prior = draft.priorAllocation.allocation;
  if (!prior) return draft;
  return {
    ...draft, usePreviousAllocation: true, riskProfile: prior.riskProfile,
    equityStrategies: prior.equityStrategies.length > 0
      ? prior.equityStrategies.map((strategy) => ({ ...strategy, allocation: String(strategy.allocation) }))
      : defaultEquityStrategies(),
  };
}

/** AC-99 */
export function withPreviousAllocationDeclined(draft: NewRequestDraft): NewRequestDraft {
  return { ...draft, usePreviousAllocation: false, riskProfile: null, equityStrategies: defaultEquityStrategies() };
}

export function withStrategyAdded(draft: NewRequestDraft): NewRequestDraft {
  if (draft.equityStrategies.length >= MAX_EQUITY_STRATEGIES) return draft;
  const id = Math.max(0, ...draft.equityStrategies.map((strategy) => strategy.id)) + 1;
  return { ...draft, equityStrategies: [...draft.equityStrategies, { id, benchmark: "", allocation: "0", rationale: "" }] };
}

export function withStrategyRemoved(draft: NewRequestDraft, id: number): NewRequestDraft {
  return { ...draft, equityStrategies: draft.equityStrategies.filter((strategy) => strategy.id !== id) };
}

/** AC-147: a rationale never holds more than 5,000 characters. */
export function withStrategyUpdated(
  draft: NewRequestDraft, id: number, patch: Partial<Omit<EquityStrategyInput, "id">>,
): NewRequestDraft {
  const next = patch.rationale === undefined ? patch : { ...patch, rationale: patch.rationale.slice(0, MAX_RATIONALE_CHARS) };
  return { ...draft, equityStrategies: draft.equityStrategies.map((strategy) => (strategy.id === id ? { ...strategy, ...next } : strategy)) };
}

export function equityTotal(draft: NewRequestDraft): number {
  return draft.equityStrategies.reduce((sum, strategy) => sum + (parseFloat(strategy.allocation) || 0), 0);
}

export function baseAllocationFor(draft: NewRequestDraft): BaseAllocation | null {
  return draft.riskProfile === null ? null : riskAllocation(draft.riskProfile);
}

type ComparedStrategy = { benchmark: string; allocation: number | string };
type ComparedAllocation = { riskProfile: number; baseAllocation: BaseAllocation; equityStrategies: readonly ComparedStrategy[] };
const TOLERANCE = 0.01;
const differs = (a: number, b: number) => Math.abs(a - b) > TOLERANCE;
const normalise = (benchmark: string) => benchmark.trim().toLocaleLowerCase();
const tuples = (strategies: readonly ComparedStrategy[]) => strategies
  .map((strategy) => ({ benchmark: normalise(strategy.benchmark), allocation: Number(strategy.allocation) }))
  .sort((a, b) => a.benchmark.localeCompare(b.benchmark) || a.allocation - b.allocation);

/** Business Rules → Material change, as the service and the standalone form compute it. */
export function isMaterialAllocationChange(current: ComparedAllocation, previous: ComparedAllocation): boolean {
  if (current.riskProfile !== previous.riskProfile) return true;
  if (
    differs(current.baseAllocation.equity, previous.baseAllocation.equity)
    || differs(current.baseAllocation.fixed, previous.baseAllocation.fixed)
    || differs(current.baseAllocation.cash, previous.baseAllocation.cash)
  ) return true;
  if (current.equityStrategies.length !== previous.equityStrategies.length) return true;
  const now = tuples(current.equityStrategies);
  const before = tuples(previous.equityStrategies);
  return now.some((tuple, index) => tuple.benchmark !== before[index].benchmark || differs(tuple.allocation, before[index].allocation));
}

/** AC-38, AC-71, AC-72: whether every strategy needs a rationale. */
export function allocationRationaleRequired(draft: NewRequestDraft): boolean {
  if (draft.tradeType === "Initial Funding") return true;
  if (!comparesPriorAllocation(draft)) return false;
  const prior = draft.priorAllocation;
  if (draft.manualMode || priorAllocationPending(draft) || !prior.allocation) return true;
  return draft.riskProfile !== null && isMaterialAllocationChange(
    { riskProfile: draft.riskProfile, baseAllocation: riskAllocation(draft.riskProfile), equityStrategies: draft.equityStrategies },
    prior.allocation,
  );
}

export function selectedAccountTypes({ draft, clientsById }: NewRequestContext): string[] {
  if (draft.manualMode) {
    return draft.manualAccounts.filter((account) => draft.manualSelectedIds.includes(account.id)).map((account) => account.accountType);
  }
  const chosen = new Set(draft.selectedAccounts);
  return draft.clientIds
    .flatMap((id) => clientsById.get(id)?.accounts ?? [])
    .filter((account) => chosen.has(account.accountNumber))
    .map((account) => account.accountType);
}

export type MoneyMarketMismatch = { entered: string; expected: TemplateMmkTicker[]; mismatchedTypes: string[] };

/**
 * AC-73, AC-74: a recognized money-market benchmark that is not the template
 * ticker for every selected account (before any account is selected: not a
 * template ticker reachable under the residence).
 */
export function moneyMarketMismatch(context: NewRequestContext, strategy: EquityStrategyInput): MoneyMarketMismatch | null {
  const symbol = strategy.benchmark.trim().toUpperCase();
  if (!isKnownMmkTicker(symbol)) return null;
  const residence = context.draft.residence;
  const types = selectedAccountTypes(context);
  if (types.length === 0) {
    const possible = [...new Set(ALL_ACCOUNT_TYPES.map((type) => allowedCashTicker(type, residence)))];
    return possible.includes(symbol as TemplateMmkTicker) ? null : { entered: symbol, expected: possible, mismatchedTypes: [] };
  }
  const expected = new Set<TemplateMmkTicker>();
  const mismatchedTypes: string[] = [];
  for (const type of types) {
    const allowed = allowedCashTicker(type, residence);
    expected.add(allowed);
    if (allowed !== symbol && !mismatchedTypes.includes(type)) mismatchedTypes.push(type);
  }
  return mismatchedTypes.length > 0 ? { entered: symbol, expected: [...expected], mismatchedTypes } : null;
}

/** The middle of the warning: "the selected {types} account(s)[ in {residence}]" or "the {residence} residence on this request". */
export function moneyMarketTarget(mismatch: MoneyMarketMismatch, residence: string, accountTypes: readonly string[]): string {
  if (mismatch.mismatchedTypes.length === 0) {
    return `the ${residence === "Other" ? "non-state-preference" : residence} residence on this request`;
  }
  const plural = mismatch.mismatchedTypes.length > 1 ? "s" : "";
  const where = residence !== "Other" && !accountTypes.every(isIra) ? ` in ${residence}` : "";
  return `the selected ${mismatch.mismatchedTypes.join(" / ")} account${plural}${where}`;
}

export function moneyMarketRequiredTitle(mismatch: MoneyMarketMismatch): string {
  return `Required because ${mismatch.entered} doesn't match the selected account type / residence. Document why this MMK is being used.`;
}

export function strategyRationaleRequired(context: NewRequestContext, strategy: EquityStrategyInput): boolean {
  return allocationRationaleRequired(context.draft) || moneyMarketMismatch(context, strategy) !== null;
}

export function rationalePlaceholder(strategy: EquityStrategyInput): string {
  return `Why ${strategy.benchmark || "this strategy"} is in the client's best interest...`;
}

export function priorAllocationSummary(prior: PriorAllocation): string {
  return `Risk Level ${prior.riskProfile} — ${prior.equityStrategies.map((s) => `${s.benchmark} (${s.allocation}%)`).join(", ")}`;
}

export function rationaleCount(rationale: string): string {
  return `${rationale.length.toLocaleString("en-US")} / ${MAX_RATIONALE_CHARS.toLocaleString("en-US")}`;
}

export function rationaleCountTone(rationale: string): "muted" | "caution" | "danger" {
  if (rationale.length >= MAX_RATIONALE_CHARS) return "danger";
  return rationale.length >= MAX_RATIONALE_CHARS * 0.9 ? "caution" : "muted";
}

/** AC-33: residence and liquidation approval for Initial Funding, Rebalance and Cash Deposit. */
export function complianceInputsProvided(draft: NewRequestDraft): boolean {
  return !allocationTradeType(draft) || (draft.residence.length > 0 && draft.liquidationApproval !== "");
}

/** AC-33: a risk score. */
export function riskScoreProvided(draft: NewRequestDraft): boolean {
  return !allocationTradeType(draft) || draft.riskProfile !== null;
}

/** AC-33: every strategy has a non-blank benchmark and the percentages total 100. */
export function strategiesProvided(draft: NewRequestDraft): boolean {
  if (!allocationTradeType(draft)) return true;
  return draft.equityStrategies.every((strategy) => strategy.benchmark.trim().length > 0) && equityTotal(draft) === 100;
}

/** AC-38, AC-71, AC-72, AC-73: every required rationale is non-blank. */
export function strategyRationalesProvided(context: NewRequestContext): boolean {
  if (!allocationTradeType(context.draft)) return true;
  return context.draft.equityStrategies.every(
    (strategy) => !strategyRationaleRequired(context, strategy) || strategy.rationale.trim().length > 0,
  );
}

/** AC-34: a non-blank trade amount and a deposit account. */
export function cashDepositInputsProvided(draft: NewRequestDraft): boolean {
  if (draft.tradeType !== "Cash Deposit") return true;
  return draft.tradeAmount.trim().length > 0 && draft.depositAccount !== "";
}
