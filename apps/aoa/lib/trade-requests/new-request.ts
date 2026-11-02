// New Request form: pure draft state, selection rules, caps, household helpers
// and the Submit gate registry. No React, no service calls.

import {
  cashDepositInputsProvided,
  complianceInputsProvided,
  initialAllocationInputs,
  riskScoreProvided,
  strategiesProvided,
  strategyRationalesProvided,
  type AllocationInputs,
} from "./new-request-allocation";
import { initialExclusionInputs, type ExclusionInputs } from "./new-request-exclusions";
import {
  initialTradeTypeInputs,
  liquidateInputsProvided,
  priorityProvided,
  raiseCashInputsProvided,
  type TradeTypeInputs,
} from "./new-request-trade-types";

export const NEW_REQUEST_COPY = {
  pageTitle: "New Request",
  cardTitle: "New Trade Request",
  connected: "Connected to Warehouse",
  connectedTitle: "Client data loaded live from Warehouse",
  loading: "Connecting to Warehouse API...",
  loadFailed: "Failed to load client data",
  loadFailedDefault: "Failed to load clients",
  clientContext: "Client & Account Context",
  enterManually: "Enter manually",
  enterManuallyTitle: "Enter client details not in Warehouse",
  useList: "Use Warehouse list",
  useListTitle: "Switch back to Warehouse client list",
  clientLabel: "Client / Household",
  selectClients: "Select client(s)...",
  searchClients: "Search clients...",
  noClients: "No clients found",
  clientList: "Client list",
  manualClientLabel: "Client Name (Manual)",
  manualClientPlaceholder: "e.g., Norene Pruitt",
  manualAccounts: "Accounts (Manual Entry)",
  manualAccountNumber: "Account #",
  manualAccountValue: "Account value ($)",
  addAccount: "Add Account",
  removeAccount: "Remove account",
  selectAccounts: "Select Accounts",
  total: "Total:",
  includeQuestion: "Include them in this trade?",
  includeAll: "Include all",
  choose: "Choose…",
  dismiss: "Dismiss",
  dismissSidecar: "Dismiss household sidecar",
  householdRegion: "Household sidecar",
  continue: "Continue",
  notTagged: "The trade will not be tagged to a single household.",
  submitInitialFunding: "Generate Plan & Submit",
  submitOther: "Submit Trade Request",
  submitResubmit: "Resubmit to Trader",
  submitting: "Submitting...",
} as const;

export const MAX_SELECTED_ACCOUNTS = 50;
export const MAX_SELECTED_CLIENTS = 50;
export const ACCOUNT_TYPES = ["Taxable", "Joint", "Traditional IRA", "Roth IRA"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const TRADE_TYPES = ["Initial Funding", "Rebalance", "Cash Deposit", "Raise Cash", "Liquidate"] as const;
export type TradeType = (typeof TRADE_TYPES)[number];

export type NewRequestAccount = { id: string; accountNumber: string; accountType: string; balance: number };
export type NewRequestClient = { id: string; name: string; accounts: NewRequestAccount[] };
export type ManualAccount = { id: string; accountNumber: string; accountType: AccountType; balance: string };

export type HouseholdAccount = {
  accountId: string; accountNumber: string | null; accountTitle: string; clientId: string | null;
};
export type HouseholdResolution = {
  householdId: number; householdName: string; accounts: HouseholdAccount[]; selectedAccountIds: string[]; clientIds: string[];
};
export type HouseholdResolveResult = { households: HouseholdResolution[] };

export type NewRequestClientsLoad =
  | { ok: true; clients: NewRequestClient[] }
  | { ok: false; outcome: "not_set_up" | "failed" | "not_allowed"; message: string };
/** null means "keep what the form already shows" (no visible outcome, as in the standalone form). */
export type NewRequestHouseholdsLoad = HouseholdResolveResult | null;

/**
 * The whole form draft. Later form work orders add their fields here and in
 * initialNewRequestDraft(); anything a Submit gate reads (including async
 * loading state) lives in the draft so gates stay pure.
 * Trade-type, priority, compliance, ESG and notes fields: TradeTypeInputs
 * in new-request-trade-types.ts. Change tradeType only through withTradeType().
 * Mandate, strategies and the previous-allocation state: AllocationInputs in
 * new-request-allocation.ts.
 * Advisor and client exclusion fields: ExclusionInputs in
 * new-request-exclusions.ts.
 */
export type NewRequestDraft = TradeTypeInputs & AllocationInputs & ExclusionInputs & {
  /** Selection order; clientIds[0] is the first selected client. */
  clientIds: string[];
  /** Account numbers of the selected listed accounts. */
  selectedAccounts: string[];
  manualMode: boolean;
  manualClientName: string;
  manualAccounts: ManualAccount[];
  manualSelectedIds: string[];
  tradeType: TradeType;
  dismissedHouseholdKey: string | null;
};

export function initialNewRequestDraft(): NewRequestDraft {
  return {
    clientIds: [], selectedAccounts: [], manualMode: false, manualClientName: "", manualAccounts: [], manualSelectedIds: [],
    tradeType: "Initial Funding", dismissedHouseholdKey: null, ...initialTradeTypeInputs(), ...initialAllocationInputs(),
    ...initialExclusionInputs(),
  };
}

export type NewRequestContext = { draft: NewRequestDraft; clientsById: ReadonlyMap<string, NewRequestClient> };

export function clientsById(clients: readonly NewRequestClient[]): Map<string, NewRequestClient> {
  return new Map(clients.map((client) => [client.id, client]));
}

export function selectedClients(context: NewRequestContext): NewRequestClient[] {
  return context.draft.clientIds.map((id) => context.clientsById.get(id)).filter((client): client is NewRequestClient => !!client);
}

/** Every account of every selected client, grouped by client in selection order. */
export function accountsForClients(context: NewRequestContext): Array<{ client: NewRequestClient; accounts: NewRequestAccount[] }> {
  return selectedClients(context).map((client) => ({ client, accounts: client.accounts }));
}

/** A client change clears the account selection and the deposit account, as in the standalone form. */
export function withClients(draft: NewRequestDraft, clientIds: string[]): NewRequestDraft {
  return { ...draft, clientIds, selectedAccounts: [], depositAccount: "" };
}

export function toggleValue(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

/** Unticking the deposit account also clears it, so it never points at an unselected account. */
export function withAccountToggled(draft: NewRequestDraft, accountNumber: string): NewRequestDraft {
  const selectedAccounts = toggleValue(draft.selectedAccounts, accountNumber);
  return { ...draft, selectedAccounts, depositAccount: selectedAccounts.includes(draft.depositAccount) ? draft.depositAccount : "" };
}

export function withManualMode(draft: NewRequestDraft, manualMode: boolean): NewRequestDraft {
  return manualMode
    ? { ...draft, manualMode, clientIds: [], selectedAccounts: [], depositAccount: "" }
    : { ...draft, manualMode, manualClientName: "", manualAccounts: [], manualSelectedIds: [] };
}

export function parseManualBalance(raw: string): number {
  return parseFloat(raw.replace(/[^0-9.]/g, "")) || 0;
}

/** Business Rules → Manual accounts: a non-blank number and a balance above zero. */
export function manualAccountProvided(account: ManualAccount): boolean {
  return account.accountNumber.trim().length > 0 && parseManualBalance(account.balance) > 0;
}

export function selectedManualAccounts(draft: NewRequestDraft): ManualAccount[] {
  return draft.manualAccounts.filter((account) => draft.manualSelectedIds.includes(account.id));
}

export function selectedAccountCount(draft: NewRequestDraft): number {
  return draft.manualMode ? draft.manualSelectedIds.length : draft.selectedAccounts.length;
}

export function hasClientAndAccounts({ draft }: NewRequestContext): boolean {
  if (draft.manualMode) {
    const chosen = selectedManualAccounts(draft);
    return draft.manualClientName.trim().length > 0 && chosen.length > 0 && chosen.every(manualAccountProvided);
  }
  return draft.clientIds.length > 0 && draft.selectedAccounts.length > 0;
}

/** The standalone form's "account selected" test, which reveals the trade-type sections. */
export function hasAccountSelection(draft: NewRequestDraft): boolean {
  if (!draft.manualMode) return draft.selectedAccounts.length > 0;
  const chosen = selectedManualAccounts(draft);
  return chosen.length > 0 && chosen.every(manualAccountProvided);
}

/** AC-40 wins over AC-109 when both limits are exceeded. */
export function newRequestCapWarning({ draft }: NewRequestContext): string | null {
  const accounts = selectedAccountCount(draft);
  if (accounts > MAX_SELECTED_ACCOUNTS) {
    return `You have selected ${accounts} accounts. Please reduce to ${MAX_SELECTED_ACCOUNTS} or fewer to submit.`;
  }
  if (!draft.manualMode && draft.clientIds.length > MAX_SELECTED_CLIENTS) {
    return `You have selected ${draft.clientIds.length} clients. Please reduce to ${MAX_SELECTED_CLIENTS} or fewer to submit.`;
  }
  return null;
}

export type NewRequestSubmitGate = { id: string; owner: string; holds: (context: NewRequestContext) => boolean };

/**
 * Shared surface "New Request form Submit enabled state": Submit is enabled
 * only when every registered gate holds. Each form work order appends its own
 * gate here; none removes or overrides another's.
 */
export const NEW_REQUEST_SUBMIT_GATES: readonly NewRequestSubmitGate[] = [
  { id: "selection", owner: "TRW-11", holds: hasClientAndAccounts },
  { id: "caps", owner: "TRW-11", holds: (context) => newRequestCapWarning(context) === null },
  { id: "priority", owner: "TRW-13", holds: ({ draft }) => priorityProvided(draft) },
  { id: "raise-cash", owner: "TRW-13", holds: ({ draft }) => raiseCashInputsProvided(draft) },
  { id: "liquidate", owner: "TRW-13", holds: ({ draft }) => liquidateInputsProvided(draft) },
  { id: "full-form-compliance", owner: "TRW-14", holds: ({ draft }) => complianceInputsProvided(draft) },
  { id: "risk-score", owner: "TRW-14", holds: ({ draft }) => riskScoreProvided(draft) },
  { id: "strategies", owner: "TRW-14", holds: ({ draft }) => strategiesProvided(draft) },
  { id: "strategy-rationales", owner: "TRW-14", holds: strategyRationalesProvided },
  { id: "cash-deposit", owner: "TRW-14", holds: ({ draft }) => cashDepositInputsProvided(draft) },
];

export function newRequestSubmitEnabled(
  context: NewRequestContext,
  gates: readonly NewRequestSubmitGate[] = NEW_REQUEST_SUBMIT_GATES,
): boolean {
  return gates.every((gate) => gate.holds(context));
}

/** With the no-plan copy switch on (ticket) Initial Funding reads like every other new request. */
export function newRequestSubmitLabel(draft: NewRequestDraft, submitting = false, noPlanCopy = false): string {
  if (submitting) return NEW_REQUEST_COPY.submitting;
  if (draft.formMode === "edit") return NEW_REQUEST_COPY.submitResubmit;
  return draft.tradeType === "Initial Funding" && !noPlanCopy ? NEW_REQUEST_COPY.submitInitialFunding : NEW_REQUEST_COPY.submitOther;
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function formatCurrency(value: number): string {
  return Number.isFinite(value) ? currency.format(value) : "$0";
}

export function listedTotal(context: NewRequestContext): number {
  const chosen = new Set(context.draft.selectedAccounts);
  return selectedClients(context)
    .flatMap((client) => client.accounts)
    .filter((account) => chosen.has(account.accountNumber))
    .reduce((sum, account) => sum + account.balance, 0);
}

export function manualTotal(draft: NewRequestDraft): number {
  return selectedManualAccounts(draft).reduce((sum, account) => sum + parseManualBalance(account.balance), 0);
}

const ULID = /^[0-9A-Z]{26}$/;

/** Selected account numbers translated to account ids; only ids the household route accepts. */
export function selectedAccountUlids(context: NewRequestContext): string[] {
  const ids: string[] = [];
  const clients = selectedClients(context);
  for (const number of context.draft.selectedAccounts) {
    const account = clients.flatMap((client) => client.accounts).find((entry) => entry.accountNumber === number);
    if (account && ULID.test(account.id)) ids.push(account.id);
  }
  return ids;
}

/** The household lookup's inputs, or null when the form must not ask (manual entry or nothing selected). */
export function householdLookupInput(context: NewRequestContext): { clientIds: string[]; accountIds: string[] } | null {
  if (context.draft.manualMode) return null;
  if (context.draft.clientIds.length === 0 && context.draft.selectedAccounts.length === 0) return null;
  return { clientIds: [...context.draft.clientIds], accountIds: selectedAccountUlids(context) };
}

/** Changes whenever the resolved households or any of their accounts change (AC-125). */
export function householdResolutionKey(resolution: HouseholdResolveResult | null): string | null {
  if (!resolution) return null;
  return [...resolution.households]
    .sort((a, b) => a.householdId - b.householdId)
    .map((household) => `H${household.householdId}:${household.accounts.map((account) => account.accountId).sort().join("|")}`)
    .join(";;");
}

export type HouseholdWithUnselected = { household: HouseholdResolution; missing: HouseholdAccount[] };

export function householdsWithUnselected(resolution: HouseholdResolveResult, selectedIds: readonly string[]): HouseholdWithUnselected[] {
  const selected = new Set(selectedIds);
  return resolution.households
    .map((household) => ({ household, missing: household.accounts.filter((account) => !selected.has(account.accountId)) }))
    .filter((row) => row.missing.length > 0);
}

export function otherClientCount(missing: readonly HouseholdAccount[]): number {
  return new Set(missing.map((account) => account.clientId).filter((id): id is string => id !== null)).size;
}

/** AC-123: adds the chosen household accounts, and their clients if not yet selected. */
export function mergeHouseholdSelection(
  draft: NewRequestDraft, resolution: HouseholdResolveResult, chosen: readonly HouseholdAccount[],
): NewRequestDraft {
  const numberById = new Map<string, string>();
  for (const household of resolution.households) {
    for (const account of household.accounts) if (account.accountNumber) numberById.set(account.accountId, account.accountNumber);
  }
  const addedClients = [...new Set(chosen.map((account) => account.clientId).filter((id): id is string => !!id && !draft.clientIds.includes(id)))];
  const addedAccounts = chosen
    .map((account) => numberById.get(account.accountId))
    .filter((number): number is string => !!number && !draft.selectedAccounts.includes(number));
  return {
    ...draft,
    clientIds: addedClients.length > 0 ? [...draft.clientIds, ...addedClients] : draft.clientIds,
    selectedAccounts: addedAccounts.length > 0 ? [...draft.selectedAccounts, ...addedAccounts] : draft.selectedAccounts,
  };
}
