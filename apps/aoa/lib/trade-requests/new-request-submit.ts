// New Request form: what Submit sends, the edit and clone forms' prefill, and
// the detail view's Edit & Resubmit and Clone availability. Pure; no React,
// no service calls.

import {
  TRADE_TYPES,
  initialNewRequestDraft,
  selectedClients,
  selectedManualAccounts,
  parseManualBalance,
  type HouseholdResolveResult,
  type NewRequestContext,
  type NewRequestDraft,
  type TradeType,
} from "./new-request";
import { defaultEquityStrategies } from "./new-request-allocation";
import {
  ESG_OPTIONS,
  LIQUIDATE_OPTIONS,
  LIQUIDATION_APPROVALS,
  PRIORITIES,
  RESIDENCES,
  defaultEsgFilters,
  isFullFormTradeType,
  type EsgFilters,
} from "./new-request-trade-types";
import type { TradeRequest } from "./request-types";
import { TRADE_REQUESTS_ROUTES } from "./routes";

export const SUBMIT_COPY = {
  failed: "Failed to submit request. Please try again.",
  resubmitTitle: (id: string) => `Resubmit: ${id}`,
  cloneTitle: (id: string) => `Clone from ${id}`,
  cancel: "Cancel",
  editAndResubmit: "Edit & Resubmit",
  editAndResubmitTitle: "Revise and resubmit this request for trader review",
  cloneToNew: "Clone to New Request",
  cloneToNewTitle: "Create a new request pre-filled from this one",
} as const;

/** A create or resubmit call's result; `id` is the request the service returned, when it returned one. */
export type SubmitOutcome = { ok: true; id: string | null } | { ok: false; message: string };

export type NewRequestFormMode = NewRequestDraft["formMode"];
export type SourceFormMode = Exclude<NewRequestFormMode, "new">;

export function editRequestRoute(id: string): string {
  return `${TRADE_REQUESTS_ROUTES.newRequest}/edit/${encodeURIComponent(id)}`;
}

export function cloneRequestRoute(id: string): string {
  return `${TRADE_REQUESTS_ROUTES.newRequest}/clone/${encodeURIComponent(id)}`;
}

/** AC-46: offered to ADVISOR users on a Needs Info request (the service decides whose request it may be, AC-26). */
export function canEditAndResubmit(role: string, status: string): boolean {
  return role === "ADVISOR" && status === "Needs Info";
}

/** AC-47: offered only to ADVISOR users on a Rejected request. */
export function canCloneToNewRequest(role: string, status: string): boolean {
  return role === "ADVISOR" && status === "Rejected";
}

export function newRequestFormTitle(mode: NewRequestFormMode, sourceId: string | null, newTitle: string): string {
  if (mode === "edit" && sourceId) return SUBMIT_COPY.resubmitTitle(sourceId);
  if (mode === "clone" && sourceId) return SUBMIT_COPY.cloneTitle(sourceId);
  return newTitle;
}

/** Business Rules → Failure messages: the service text or failure description, else the default (AC-8, AC-144). */
export function submitFailureMessage(message: string | null | undefined): string {
  return message?.trim() ? message : SUBMIT_COPY.failed;
}

/** One pending key per form identity; an edit sends none (resubmission is checked by version instead). */
export function idempotencyStorageKey(mode: NewRequestFormMode, sourceId: string | null): string | null {
  if (mode === "edit") return null;
  return mode === "clone" && sourceId ? `trade-requests:idempotency:clone-${sourceId}` : "trade-requests:idempotency:new";
}

const pick = <T extends string>(values: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : null;
const text = (value: unknown) => (typeof value === "string" ? value : "");

function esgFromRequest(stored: TradeRequest["esgFilters"] | null | undefined): EsgFilters {
  if (!stored || typeof stored !== "object") return defaultEsgFilters();
  const filters = { ...defaultEsgFilters(), otherDescription: text(stored.otherDescription) };
  for (const { key } of ESG_OPTIONS) filters[key] = stored[key] === true;
  return filters;
}

/** A date input holds yyyy-mm-dd. */
function dateInput(value: string | null | undefined): string {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value ?? "");
  return match ? match[0] : "";
}

/**
 * AC-18 and AC-91: the edit and clone forms start from every field of the
 * source request, including its recorded exclusions. Selection is listed
 * (not manual) as in the standalone form; stored values the form does not
 * offer start unchosen.
 */
export function draftFromRequest(request: TradeRequest, mode: SourceFormMode): NewRequestDraft {
  const risk = request.riskProfile;
  return {
    ...initialNewRequestDraft(),
    formMode: mode,
    clientIds: request.clientIds?.length ? [...request.clientIds] : request.clientId ? [request.clientId] : [],
    selectedAccounts: [...(request.selectedAccounts ?? [])],
    tradeType: pick<TradeType>(TRADE_TYPES, request.tradeType) ?? "Initial Funding",
    priority: pick(PRIORITIES, request.priority) ?? "",
    tradeAmount: text(request.tradeAmount),
    depositAccount: text(request.depositAccount),
    rebalanceAll: request.rebalanceAll === true,
    raiseCashReason: text(request.raiseCashReason),
    liquidityDeadline: dateInput(request.liquidityDeadline),
    liquidateOption: pick(LIQUIDATE_OPTIONS, request.liquidateOption) ?? "",
    liquidatePositions: text(request.liquidatePositions),
    residence: pick(RESIDENCES.map((entry) => entry.value), request.residence) ?? "Other",
    liquidationApproval: pick(LIQUIDATION_APPROVALS, request.liquidationApproval) ?? "",
    esgFilters: esgFromRequest(request.esgFilters),
    advisorNotes: text(request.advisorNotes),
    riskProfile: typeof risk === "number" && Number.isInteger(risk) && risk >= 1 && risk <= 25 ? risk : null,
    equityStrategies: request.equityStrategies?.length
      ? request.equityStrategies.map((strategy) => ({
        id: strategy.id, benchmark: text(strategy.benchmark), allocation: String(strategy.allocation ?? ""), rationale: text(strategy.rationale),
      }))
      : defaultEquityStrategies(),
    advisorExclusions: text(request.advisorExclusions),
    clientExclusions: text(request.clientExclusions),
  };
}

type AccountData = { accountNumber: string; accountType: string; balance: number };

/** The create and resubmit body (the service's CreateTradeRequestPayload); the caller adds the key or version. */
export type NewRequestPayload = {
  clientId: string;
  clientName: string;
  clientIds?: string[];
  clientNames?: string[];
  tradeType: TradeType;
  tradeAmount: string;
  depositAccount: string;
  rebalanceAll: boolean;
  selectedAccounts: string[];
  accountsData?: AccountData[];
  priority: string;
  advisorNotes: string;
  residence: string;
  liquidationApproval: string;
  advisorExclusions: string;
  clientExclusions: string;
  esgFilters: EsgFilters;
  riskProfile: number | null;
  equityStrategies: Array<{ id: number; benchmark: string; allocation: number; rationale: string }>;
  raiseCashReason: string;
  liquidityDeadline: string | null;
  liquidateOption: string;
  liquidatePositions: string;
  existingId: string | null;
  isClone: boolean;
  manualEntry?: true;
  manualAccounts?: AccountData[];
  assetLocationMode: string;
  householdId: number | null;
  householdName: string | null;
};

const NO_HOUSEHOLD = { householdId: null, householdName: null };

/**
 * AC-126: the firm household is recorded only when every selected account
 * resolves to the same one; never for manual entry or a resubmission (the
 * service keeps the tag from creation).
 */
export function householdTagForSubmit(
  context: NewRequestContext, households: HouseholdResolveResult | null,
): { householdId: number | null; householdName: string | null } {
  const { draft } = context;
  if (draft.manualMode || draft.formMode === "edit" || !households) return NO_HOUSEHOLD;
  const accounts = selectedClients(context).flatMap((client) => client.accounts);
  const ids = draft.selectedAccounts
    .map((number) => accounts.find((account) => account.accountNumber === number)?.id)
    .filter((id): id is string => !!id);
  if (ids.length === 0) return NO_HOUSEHOLD;
  const byAccount = new Map<string, { id: number; name: string }>();
  for (const household of households.households) {
    for (const account of household.accounts) byAccount.set(account.accountId, { id: household.householdId, name: household.householdName });
  }
  const tags = ids.map((id) => byAccount.get(id));
  const first = tags[0];
  if (!first || tags.some((tag) => !tag || tag.id !== first.id)) return NO_HOUSEHOLD;
  return { householdId: first.id, householdName: first.name };
}

export type PayloadOptions = {
  households: HouseholdResolveResult | null;
  /** The source request in edit and clone: names for clients the list no longer has, and its asset-location mode. */
  source?: Pick<TradeRequest, "id" | "clientId" | "clientName" | "clientIds" | "clientNames" | "assetLocationMode"> | null;
  now?: number;
};

/**
 * What Submit sends, as the standalone form builds it. Values of a trade type
 * other than the selected one stay on the draft but are not sent; the
 * Rebalance "New Deposits" values are never sent (AC-152).
 */
export function buildNewRequestPayload(context: NewRequestContext, { households, source = null, now = Date.now() }: PayloadOptions): NewRequestPayload {
  const { draft } = context;
  const full = isFullFormTradeType(draft.tradeType);
  const raiseCash = draft.tradeType === "Raise Cash";
  const liquidate = draft.tradeType === "Liquidate";
  const listed = selectedClients(context);
  const sourceNames = new Map<string, string>();
  if (source) {
    (source.clientIds ?? []).forEach((id, index) => { if (source.clientNames?.[index]) sourceNames.set(id, source.clientNames[index]); });
    if (source.clientId && !sourceNames.has(source.clientId)) sourceNames.set(source.clientId, source.clientName);
  }
  const nameOf = (id: string) => context.clientsById.get(id)?.name ?? sourceNames.get(id) ?? id;
  const several = !draft.manualMode && draft.clientIds.length > 1;
  const manual = selectedManualAccounts(draft);
  const manualDetails = manual.map((account) => ({
    accountNumber: account.accountNumber, accountType: account.accountType, balance: parseManualBalance(account.balance),
  }));
  const listedAccounts = listed.flatMap((client) => client.accounts).filter((account) => draft.selectedAccounts.includes(account.accountNumber));
  const tag = householdTagForSubmit(context, households);
  const firstId = draft.clientIds[0] ?? "";

  return {
    clientId: draft.manualMode ? `manual-${now}` : firstId,
    clientName: draft.manualMode ? draft.manualClientName : several ? draft.clientIds.map(nameOf).join(" & ") : firstId ? nameOf(firstId) : "",
    ...(several ? { clientIds: [...draft.clientIds], clientNames: draft.clientIds.map(nameOf) } : {}),
    tradeType: draft.tradeType,
    tradeAmount: draft.tradeType === "Cash Deposit" || raiseCash ? draft.tradeAmount : "",
    depositAccount: draft.tradeType === "Cash Deposit" ? draft.depositAccount : "",
    rebalanceAll: draft.tradeType === "Initial Funding" || draft.tradeType === "Rebalance" ? true : draft.rebalanceAll,
    selectedAccounts: draft.manualMode ? manual.map((account) => account.accountNumber || account.id) : [...draft.selectedAccounts],
    ...(!draft.manualMode && listed.length > 0
      ? { accountsData: listedAccounts.map(({ accountNumber, accountType, balance }) => ({ accountNumber, accountType, balance })) }
      : {}),
    priority: draft.priority,
    advisorNotes: draft.advisorNotes,
    residence: full ? draft.residence : "Other",
    liquidationApproval: full ? draft.liquidationApproval : "",
    advisorExclusions: full ? draft.advisorExclusions : "",
    clientExclusions: full ? draft.clientExclusions : "",
    esgFilters: full ? { ...draft.esgFilters } : defaultEsgFilters(),
    riskProfile: full ? draft.riskProfile : null,
    equityStrategies: full
      ? draft.equityStrategies.map((strategy) => ({
        id: strategy.id, benchmark: strategy.benchmark, allocation: parseFloat(strategy.allocation) || 0, rationale: strategy.rationale,
      }))
      : [],
    raiseCashReason: raiseCash ? draft.raiseCashReason : "",
    liquidityDeadline: raiseCash && draft.liquidityDeadline ? draft.liquidityDeadline : null,
    liquidateOption: liquidate ? draft.liquidateOption : "",
    liquidatePositions: liquidate ? draft.liquidatePositions : "",
    existingId: draft.formMode === "edit" && source ? source.id : null,
    isClone: draft.formMode === "clone",
    ...(draft.manualMode ? { manualEntry: true as const, manualAccounts: manualDetails } : {}),
    assetLocationMode: full && source?.assetLocationMode ? source.assetLocationMode : "priority",
    householdId: tag.householdId,
    householdName: tag.householdName,
  };
}
