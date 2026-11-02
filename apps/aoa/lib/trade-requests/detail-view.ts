import type {
  TradeRequest, TradeRequestAccount, TradeRequestAccountExclusion, TradeRequestAuditEntry, TradeRequestClient, TradeRequestExporter,
} from "./request-types";

// Standalone copy (trade-request client/src/components/RequestModal.tsx, App.tsx), verbatim.
export const REQUEST_DETAIL_COPY = {
  tabDetails: "Request Details",
  tabAudit: "Audit Trail",
  tabChecklist: "Pre-approval Checklist",
  downloadPdf: "Download PDF",
  downloadPdfTitle: "Download as PDF",
  close: "Close",
  rejectedTitle: "Request Rejected and Locked",
  rejectedBody: "For SEC compliance, this record is permanently locked. The advisor must submit a new request.",
  notFound: "Request not found. It may have been removed or you may not have access.",
  loadFailed: "Failed to load request. Please try again.",
  pdfFailed: "PDF export failed. Please try again.",
  retry: "Retry",
  backToQueue: "Back to Queue",
} as const;

export type RequestDetailTab = "details" | "audit" | "checklist";

const ESG_LABELS: Record<string, string> = {
  fossilFuels: "Fossil Fuels",
  tobacco: "Tobacco",
  weapons: "Weapons",
  alcohol: "Alcohol",
  gambling: "Gambling",
  other: "Other",
};

// Workspace sub-routes that share the /trade-requests/<segment> shape; their
// static routes take precedence once present, and they are never request ids.
const RESERVED_SEGMENTS = new Set(["queue", "new"]);

/** The id reaches the service as one path segment; dot segments and workspace sub-routes never do. */
export function isLoadableRequestId(id: string): boolean {
  return id.length > 0 && id !== "." && !id.includes("..") && !RESERVED_SEGMENTS.has(id.toLowerCase());
}

export function householdLabel(request: Pick<TradeRequest, "clientName" | "clientNames">): string {
  return request.clientNames?.length > 1 ? request.clientNames.join(" & ") : request.clientName;
}

export function isHousehold(request: Pick<TradeRequest, "clientIds">): boolean {
  return request.clientIds?.length > 1;
}

/**
 * The standalone order: the selected accounts of the request's clients from
 * the client list; when none of its clients is listed, the account details
 * stored on the request.
 */
const optionalArray = (value: unknown) => value == null || Array.isArray(value);

// Every field the page and the dialog read without a guard; a row missing one
// shows the failure screen (or, from the queue, loads the request) instead of
// throwing during render.
export function isTradeRequest(value: unknown): value is TradeRequest {
  const row = value as Partial<TradeRequest> | null;
  return row != null && typeof row === "object"
    && typeof row.id === "string" && typeof row.clientName === "string" && typeof row.status === "string"
    && Array.isArray(row.auditLog) && Array.isArray(row.selectedAccounts)
    && optionalArray(row.clientIds) && optionalArray(row.clientNames) && optionalArray(row.accountMetadata)
    && optionalArray(row.equityStrategies);
}

/** The signed-in person as the PDF's exporter: their name, else their email. */
export function tradeRequestExporter(user: { name?: string | null; email?: string | null } | null | undefined): TradeRequestExporter {
  const email = user?.email ?? "";
  return { name: user?.name?.trim() || email, email };
}

export function resolveSelectedAccounts(request: TradeRequest, clients: TradeRequestClient[] | null): TradeRequestAccount[] {
  const ids = request.clientIds?.length ? request.clientIds : [request.clientId];
  const byId = new Map((clients ?? []).map((client) => [client.id, client]));
  const listed = ids.map((id) => byId.get(id)).filter((client): client is TradeRequestClient => Boolean(client));
  if (listed.length > 0) {
    return listed.flatMap((client) => client.accounts ?? []).filter((account) => request.selectedAccounts.includes(account.accountNumber));
  }
  return (request.accountMetadata ?? [])
    .filter((account) => request.selectedAccounts.includes(account.accountNumber))
    .map((account) => ({
      id: account.accountId || account.accountNumber,
      clientId: request.clientId,
      accountNumber: account.accountNumber,
      accountType: account.accountType,
      balance: account.balance,
    }));
}

export function activeEsgFilters(filters: TradeRequest["esgFilters"] | null | undefined): string[] {
  return Object.entries(filters ?? {})
    .filter(([key, value]) => value && key !== "none" && key !== "otherDescription")
    .map(([key]) => (key === "other" && filters?.otherDescription ? `${ESG_LABELS[key]}: ${filters.otherDescription}` : ESG_LABELS[key] || key));
}

export function residenceLabel(residence: string): string {
  if (residence === "NY") return "New York (NY) - Muni Preference";
  if (residence === "CA") return "California (CA) - Muni Preference";
  return "Other / Not Applicable";
}

export function strategyTotal(request: Pick<TradeRequest, "equityStrategies">): number {
  return (request.equityStrategies ?? []).reduce((sum, strategy) => sum + strategy.allocation, 0);
}

/** Newest first; entries with the same time keep the service's order. */
export function auditNewestFirst(entries: TradeRequestAuditEntry[] | null | undefined): TradeRequestAuditEntry[] {
  const time = (entry: TradeRequestAuditEntry) => {
    const value = Date.parse(entry.date);
    return Number.isNaN(value) ? -Infinity : value;
  };
  return (entries ?? []).map((entry, index) => ({ entry, index }))
    .sort((a, b) => time(b.entry) - time(a.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

export type PdfAccountExclusion = {
  accountNumber: string;
  kind: "advisor" | "client";
  ticker: string;
  reason: string;
  noBuy: boolean;
  noSell: boolean;
};

export function uniqueAccountIds(accounts: TradeRequestAccount[]): string[] {
  return [...new Set(accounts.map((account) => account.id).filter(Boolean))];
}

/** Account-level exclusions keyed by account id, flattened in the selected accounts' order. */
export function pdfAccountExclusions(
  accounts: TradeRequestAccount[],
  byAccountId: Record<string, TradeRequestAccountExclusion[]>,
): PdfAccountExclusion[] {
  const accountNumberById = new Map(accounts.map((account) => [account.id, account.accountNumber]));
  return uniqueAccountIds(accounts).flatMap((accountId) => {
    const accountNumber = accountNumberById.get(accountId);
    if (!accountNumber) return [];
    return (byAccountId[accountId] ?? []).map((exclusion) => ({
      accountNumber, kind: exclusion.kind, ticker: exclusion.ticker, reason: exclusion.reason,
      noBuy: exclusion.noBuy, noSell: exclusion.noSell,
    }));
  });
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function formatCurrency(value: number): string {
  return Number.isFinite(value) ? currency.format(value) : "$0";
}
