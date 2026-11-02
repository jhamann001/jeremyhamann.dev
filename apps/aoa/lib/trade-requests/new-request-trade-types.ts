// New Request form: trade-type inputs, priority, compliance inputs, ESG
// filters and advisor notes. Pure state helpers and Submit gate predicates;
// no React, no service calls. The values live on NewRequestDraft.

import type { NewRequestDraft, TradeType } from "./new-request";
import { allocationChoiceSettled } from "./new-request-allocation";

export const TRADE_TYPE_COPY = {
  tradeType: "Trade Type",
  priority: "Priority",
  selectPriority: "Select a priority",
  cashRaiseDetails: "Cash Raise Details",
  cashAmount: "Cash Amount to Raise ($)",
  cashAmountHelp: "Target amount of cash to generate from selling securities",
  cashAmountPlaceholder: "e.g., $50,000",
  liquidityDeadline: "Liquidity Deadline",
  liquidityDeadlineHelp: "Date the cash must be settled, if applicable",
  raiseCashReason: "Reason for Cash Raise",
  raiseCashReasonHelp: "Purpose of the cash generation request",
  raiseCashReasonPlaceholder: "e.g., Client distribution, tax payment, fee payment...",
  liquidationDetails: "Liquidation Details",
  liquidateOptions: "Liquidate Options",
  selectLiquidateOption: "Select liquidation option",
  positions: "Positions to Liquidate",
  positionsPlaceholder: "e.g., AAPL, MSFT, TSLA",
  depositDetails: "Deposit Details",
  depositAmount: "Deposit Amount",
  depositAmountPlaceholder: "e.g., $150,000",
  depositAccount: "Account Holding Deposit",
  selectDepositAccount: "Select account...",
  rebalanceAll: "Also rebalance all selected accounts to target allocation",
  rebalanceAllOn: "The engine will redistribute holdings across all selected accounts for this client to match the target allocation.",
  rebalanceAllOff: "Only the deposit account will receive trades. Other selected accounts remain unchanged.",
  executionPlanLead: "Execution plan:",
  executionPlan: "A detailed plan is not generated on submit for cash deposits. After you submit, a trader will verify holdings and generate the execution plan.",
  rebalanceAllOnNoPlan: "A trader will rebalance all selected accounts for this client to the target allocation.",
  cashDepositNoteNoPlan: "After you submit, a trader will verify holdings and place the trades.",
  newDeposits: "New Deposits (Optional)",
  newDepositsHelp: "If cash is being deposited alongside the rebalance, enter the details below. Leave blank if no deposits.",
  newDepositAmountPlaceholder: "$0",
  noDeposit: "No deposit",
  compliance: "Compliance, Exclusions & Execution",
  residence: "State Residence",
  residenceTitle: "Used for municipal bond tax optimization",
  liquidationApproval: "Liquidation Approval",
  liquidationApprovalTitle: "Confirms client approves selling existing holdings",
  selectApproval: "Select...",
  esg: "ESG Filters (Direct Indexing)",
  esgTitle: "Exclude sectors from the direct indexing universe",
  esgOtherPlaceholder: "Specify custom ESG filter...",
  esgOtherLabel: "Custom ESG filter",
  notes: "Workflow & Advisor Notes",
  advisorNotes: "Advisor Compliance & Execution Notes",
  advisorNotesPlaceholder: "e.g., Prioritize sale of lowest basis tax lots first. Maintain 3% minimum cash position post-trade.",
} as const;

export const PRIORITIES = ["Urgent", "Standard", "Low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const LIQUIDATE_OPTIONS = ["Entire Account", "Specific Positions"] as const;
export type LiquidateOption = (typeof LIQUIDATE_OPTIONS)[number];
export const RESIDENCES = [
  { value: "Other", label: "Other / Not Applicable" },
  { value: "NY", label: "New York (NY) - Muni Preference" },
  { value: "CA", label: "California (CA) - Muni Preference" },
] as const;
export type Residence = (typeof RESIDENCES)[number]["value"];
export const LIQUIDATION_APPROVALS = ["Yes", "No"] as const;
export type LiquidationApproval = (typeof LIQUIDATION_APPROVALS)[number];

export type EsgFilters = {
  fossilFuels: boolean; tobacco: boolean; weapons: boolean; alcohol: boolean; gambling: boolean;
  other: boolean; otherDescription: string; none: boolean;
};
export type EsgKey = Exclude<keyof EsgFilters, "otherDescription">;
export const ESG_OPTIONS: ReadonlyArray<{ key: EsgKey; label: string }> = [
  { key: "fossilFuels", label: "Fossil Fuels" },
  { key: "tobacco", label: "Tobacco" },
  { key: "weapons", label: "Weapons" },
  { key: "alcohol", label: "Alcohol" },
  { key: "gambling", label: "Gambling" },
  { key: "other", label: "Other" },
  { key: "none", label: "None" },
];
export function defaultEsgFilters(): EsgFilters {
  return { fossilFuels: false, tobacco: false, weapons: false, alcohol: false, gambling: false, other: false, otherDescription: "", none: true };
}

/**
 * Trade-type and common input state carried on NewRequestDraft.
 *
 * - `tradeAmount` and `depositAccount` are shared, as in the standalone form:
 *   Raise Cash amount; Cash Deposit amount and deposit account; Rebalance
 *   "New Deposits" amount and account (shown, never sent — AC-152).
 * - `rebalanceAll` is the Cash Deposit option; Initial Funding and Rebalance
 *   always rebalance every selected account when submitted.
 * - Raise Cash: `raiseCashReason`, optional `liquidityDeadline` (yyyy-mm-dd).
 * - Liquidate: `liquidateOption`, `liquidatePositions` (Specific Positions).
 * - Initial Funding, Rebalance, Cash Deposit: `residence`,
 *   `liquidationApproval`, `esgFilters`. Every type: `priority`, `advisorNotes`.
 *
 * "" means "not chosen yet" for every select.
 * Values of hidden types persist on the draft; when building the payload, TRW-15 must default the compliance fields (residence, liquidationApproval, esgFilters) for Raise Cash and Liquidate.
 */
export type TradeTypeInputs = {
  priority: Priority | "";
  tradeAmount: string;
  depositAccount: string;
  rebalanceAll: boolean;
  raiseCashReason: string;
  liquidityDeadline: string;
  liquidateOption: LiquidateOption | "";
  liquidatePositions: string;
  residence: Residence;
  liquidationApproval: LiquidationApproval | "";
  esgFilters: EsgFilters;
  advisorNotes: string;
};

export function initialTradeTypeInputs(): TradeTypeInputs {
  return {
    priority: "", tradeAmount: "", depositAccount: "", rebalanceAll: false, raiseCashReason: "", liquidityDeadline: "",
    liquidateOption: "", liquidatePositions: "", residence: "Other", liquidationApproval: "", esgFilters: defaultEsgFilters(),
    advisorNotes: "",
  };
}

/** Initial Funding, Rebalance and Cash Deposit carry an allocation and the compliance inputs. */
export function isFullFormTradeType(tradeType: TradeType): boolean {
  return tradeType === "Initial Funding" || tradeType === "Rebalance" || tradeType === "Cash Deposit";
}

/** The rebalance-all explanation; with the no-plan copy switch on it names a trader, not the engine (ticket). */
export function rebalanceAllText(rebalanceAll: boolean, noPlanCopy: boolean): string {
  if (!rebalanceAll) return TRADE_TYPE_COPY.rebalanceAllOff;
  return noPlanCopy ? TRADE_TYPE_COPY.rebalanceAllOnNoPlan : TRADE_TYPE_COPY.rebalanceAllOn;
}

/** The Cash Deposit note; with the no-plan copy switch on it has no "Execution plan:" lead (ticket). */
export function cashDepositNote(noPlanCopy: boolean): { lead: string | null; text: string } {
  return noPlanCopy
    ? { lead: null, text: TRADE_TYPE_COPY.cashDepositNoteNoPlan }
    : { lead: TRADE_TYPE_COPY.executionPlanLead, text: TRADE_TYPE_COPY.executionPlan };
}

/** A trade-type change clears the per-type inputs, as in the standalone form. */
export function withTradeType(draft: NewRequestDraft, tradeType: TradeType): NewRequestDraft {
  return {
    ...draft, tradeType, tradeAmount: "", depositAccount: "", rebalanceAll: tradeType === "Rebalance" || tradeType === "Initial Funding",
    raiseCashReason: "", liquidityDeadline: "", liquidateOption: "", liquidatePositions: "",
  };
}

/** AC-137 (None clears the rest and the Other description) and AC-139 (anything else clears None). */
export function toggleEsgFilter(filters: EsgFilters, key: EsgKey): EsgFilters {
  if (key === "none") return defaultEsgFilters();
  if (key === "other") return { ...filters, other: !filters.other, otherDescription: filters.other ? "" : filters.otherDescription, none: false };
  return { ...filters, [key]: !filters[key], none: false };
}

export function priorityProvided(draft: NewRequestDraft): boolean {
  return draft.priority !== "";
}

/** AC-35: a trade amount and a non-blank reason. */
export function raiseCashInputsProvided(draft: NewRequestDraft): boolean {
  if (draft.tradeType !== "Raise Cash") return true;
  return draft.tradeAmount.trim().length > 0 && draft.raiseCashReason.trim().length > 0;
}

/** AC-36 and AC-37: an option, and described positions for Specific Positions. */
export function liquidateInputsProvided(draft: NewRequestDraft): boolean {
  if (draft.tradeType !== "Liquidate") return true;
  if (draft.liquidateOption === "") return false;
  return draft.liquidateOption !== "Specific Positions" || draft.liquidatePositions.trim().length > 0;
}

/** Whether the allocation and compliance sections are shown; a new Rebalance or Cash Deposit waits for the previous-allocation answer. */
export function fullFormSectionsVisible(draft: NewRequestDraft): boolean {
  return isFullFormTradeType(draft.tradeType) && allocationChoiceSettled(draft);
}
