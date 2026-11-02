// Client-safe: how the Asset Transfer workspace reads a transfer against the
// AOA records it is linked to (deal, client directory, Apex account feed,
// tracker, Operations fee requests, Trade Requests, custodian library).
import { FEE_REQUEST_KIND_LABELS, type TransferFeeRequest } from "@/lib/data/acat-fee-requests-view";

export type ConnectedClient = {
  sfId: string;
  name: string;
  householdSfId: string | null;
  householdName: string | null;
};

export type LinkedDealFacts = {
  clientFirstName: string;
  clientLastName: string;
  householdName: string | null;
  householdSfId: string | null;
};

export type StoredClientFacts = {
  client_first_name: string;
  client_last_name: string;
  household_name: string | null;
  household_sf_id: string | null;
};

export type ClientNameSource = "directory" | "deal" | "recorded";

/** A linked client wins, then a linked deal; the copied fields are used only when neither is linked. */
export function connectedIdentity(
  stored: StoredClientFacts,
  client: ConnectedClient | null,
  deal: LinkedDealFacts | null,
): { name: string; householdName: string | null; householdSfId: string | null; source: ClientNameSource } {
  if (client) {
    return {
      name: client.name || `${stored.client_first_name} ${stored.client_last_name}`.trim(),
      householdName: client.householdName ?? deal?.householdName ?? stored.household_name,
      householdSfId: client.householdSfId ?? deal?.householdSfId ?? stored.household_sf_id,
      source: "directory",
    };
  }
  if (deal) {
    return {
      name: `${deal.clientFirstName} ${deal.clientLastName}`.trim(),
      householdName: deal.householdName ?? stored.household_name,
      householdSfId: deal.householdSfId ?? stored.household_sf_id,
      source: "deal",
    };
  }
  return {
    name: `${stored.client_first_name} ${stored.client_last_name}`.trim(),
    householdName: stored.household_name,
    householdSfId: stored.household_sf_id,
    source: "recorded",
  };
}

/** A recorded receiving account read against the client's Apex accounts. */
export type ReconciledReceivingAccount = {
  id: string;
  label: string;
  status: "OPEN" | "TO_OPEN";
  /** "apex": a same-type Apex account decides the status. "manual": Apex has no matching account. */
  source: "apex" | "manual";
  apexMasked: string | null;
};

/** The intake writes `${type} · ${title}`; older rows may only carry a type. */
export function accountTypeFromLabel(label: string): string {
  return label.split(" · ")[0]?.trim() ?? "";
}

export type ControlNumberCheck =
  | { state: "none" }
  | { state: "tracker-only"; tracker: string }
  | { state: "match"; tracker: string }
  | { state: "mismatch"; tracker: string; typed: string };

const compact = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, "").toUpperCase();

/** Compares a typed or recorded control number with the tracker's. */
export function controlNumberCheck(typed: string | null | undefined, tracker: string | null | undefined): ControlNumberCheck {
  const trackerValue = (tracker ?? "").trim();
  if (!trackerValue) return { state: "none" };
  const typedValue = (typed ?? "").trim();
  if (!typedValue) return { state: "tracker-only", tracker: trackerValue };
  return compact(typedValue) === compact(trackerValue)
    ? { state: "match", tracker: trackerValue }
    : { state: "mismatch", tracker: trackerValue, typed: typedValue };
}

export function feeRequestLabel(request: TransferFeeRequest): string {
  return [
    FEE_REQUEST_KIND_LABELS[request.kind],
    request.feeAmount ? `$${request.feeAmount}` : null,
    request.status.charAt(0) + request.status.slice(1).toLowerCase(),
    `submitted ${request.submittedAt.slice(0, 10)}`,
  ].filter(Boolean).join(" · ");
}

/** "unlinked": the transfer has no client id, or the id is not a client in the directory. */
export type ClientFeeRequests =
  | { state: "unlinked" }
  | { state: "unavailable" }
  | { state: "ready"; requests: TransferFeeRequest[]; truncated: boolean };

export type TradeRequestOption = { id: string; status: string | null; tradeType: string | null; createdAt: string | null };

export type ClientTradeRequests =
  | { state: "unlinked" }
  | { state: "unavailable" }
  | { state: "ready"; requests: TradeRequestOption[] };

export function tradeRequestLabel(request: TradeRequestOption): string {
  return [request.tradeType ?? "Trade request", request.status, request.createdAt?.slice(0, 10), request.id].filter(Boolean).join(" · ");
}

export type RosterPerson = { name: string; email: string };

export type CustodianOption = { id: string; name: string };

export type DealOption = {
  id: string;
  sfDealId: string | null;
  name: string;
  amount: number;
  stage: string;
  clientSfId: string | null;
  accountLast4: string | null;
  transferringFirm: string | null;
  /** The transfer already linked to this deal, if any. A deal links one transfer. */
  linkedTransferId: string | null;
};

/** The workspace detail's view of the records a transfer is connected to. */
export type TransferConnections = {
  client: { name: string; householdName: string | null; source: ClientNameSource };
  directoryClient: ConnectedClient | null;
  custodian: CustodianOption | null;
  roster: RosterPerson[];
  feeRequests: ClientFeeRequests;
  tradeRequests: ClientTradeRequests;
  receiving: ReconciledReceivingAccount[];
  trackerControlNumber: string | null;
};
