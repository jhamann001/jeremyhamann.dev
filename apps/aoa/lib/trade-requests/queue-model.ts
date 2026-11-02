// Pure Home and Trading Queue rules shared by the server reads, the route
// handlers and the client components. Mirrors the standalone app
// (client/src/components/TradingQueue.tsx, client/src/hooks/useTradeRequests.ts).

export const QUEUE_COPY = {
  homeTitle: (firstName: string) => `Welcome back, ${firstName}`,
  homeDescription: "Here's a snapshot of your trade activity.",
  statsError: "Unable to load stats.",
  retry: "Retry",
  quickActions: "Quick Actions",
  newRequestCard: "New Trade Request",
  newRequestDescription: "Submit a new trade request for a client account.",
  queueCard: "Trading Queue",
  queueReviewerDescription: "Review and manage all pending trade requests.",
  queueAdvisorDescription: "View all trade requests and their status.",
  queueTitle: "Global Trading Queue",
  loading: "Loading requests...",
  searchPlaceholder: "Search all requests (ID, client, type, advisor, submitter, status)…",
  searchLabel: "Search trade requests",
  caption: "All trade requests across advisors",
  refreshFailed: "Unable to refresh — showing last loaded data.",
  noMatches: "No requests match your search.",
  noRequests: "No active trade requests found.",
  loadMore: "Load More",
  loadingMore: "Loading...",
  loadFailed: "Failed to load requests",
  loadMoreFailed: "Failed to load more requests",
  countsFailed: "Failed to load request counts",
  signedOut: "Your session has ended. Sign in again to continue.",
  signIn: "Sign in",
  viewRequest: (id: string) => `View request ${id}`,
} as const;

export const COUNT_TILES = [
  { key: "total", label: "Total Requests", hint: "All submitted trade requests" },
  { key: "pendingReview", label: "Pending Review", hint: "Awaiting trader review" },
  { key: "needsInfo", label: "Needs Info", hint: "Returned to advisor for clarification" },
  { key: "approved", label: "Approved / Done", hint: "Approved or completed requests" },
] as const;

export const QUEUE_POLL_INTERVAL_MS = 30_000;
export const QUEUE_SEARCH_DELAY_MS = 300;
export const QUEUE_SEARCH_MAX = 200;
export const QUEUE_CURSOR_MAX = 200;

/** Firm-wide counts; `approved` is Approved plus Completed (the service sums them). */
export type TradeRequestCounts = { total: number; pendingReview: number; needsInfo: number; approved: number };

/**
 * One request as the service lists it. The queue reads the named fields; the
 * whole entry is kept so the request detail can show it without another load.
 */
export type TradeRequestListEntry = {
  id: string;
  clientName: string;
  clientNames: string[];
  advisor: string;
  submittedBy: string;
  tradeType: string;
  status: string;
  date: string;
  updatedAt: string;
  [field: string]: unknown;
};

export type TradeRequestPage = { data: TradeRequestListEntry[]; nextCursor: string | null };

export type QueueSortKey = "id" | "household" | "tradeType" | "date" | "advisor" | "submittedBy" | "status";
export type QueueSortDir = "asc" | "desc";
export type QueueSort = { key: QueueSortKey; dir: QueueSortDir };
export const DEFAULT_QUEUE_SORT: QueueSort = { key: "date", dir: "desc" };

export type QueueColumn = { key: QueueSortKey; label: string };
const LEADING_COLUMNS: QueueColumn[] = [
  { key: "id", label: "Request ID" },
  { key: "household", label: "Household" },
  { key: "tradeType", label: "Trade Type" },
  { key: "date", label: "Date" },
];
const REVIEWER_COLUMNS: QueueColumn[] = [
  { key: "advisor", label: "Advisor" },
  { key: "submittedBy", label: "Submitted by" },
];
const STATUS_COLUMN: QueueColumn = { key: "status", label: "Status" };

export function queueColumns(reviewer: boolean): QueueColumn[] {
  return [...LEADING_COLUMNS, ...(reviewer ? REVIEWER_COLUMNS : []), STATUS_COLUMN];
}

// Workflow sequence for the Status sort; any other stored status sorts last.
export const QUEUE_STATUS_ORDER: Readonly<Record<string, number>> = Object.freeze({
  "Pending Review": 0,
  "Needs Info": 1,
  "Pending Current Asset Liquidation": 2,
  Approved: 3,
  Rejected: 4,
  Completed: 5,
});

const statusRank = (status: string) => (Object.hasOwn(QUEUE_STATUS_ORDER, status) ? QUEUE_STATUS_ORDER[status] : 99);

export function householdLabel(entry: Pick<TradeRequestListEntry, "clientName" | "clientNames">): string {
  return entry.clientNames?.length > 1 ? entry.clientNames.join(" & ") : entry.clientName;
}

export function submitterLabel(entry: Pick<TradeRequestListEntry, "submittedBy" | "advisor">): string {
  return entry.submittedBy || entry.advisor;
}

export function compareQueueEntries(a: TradeRequestListEntry, b: TradeRequestListEntry, sort: QueueSort): number {
  let result: number;
  switch (sort.key) {
    case "id": result = a.id.localeCompare(b.id); break;
    case "household": result = householdLabel(a).localeCompare(householdLabel(b)); break;
    case "tradeType": result = a.tradeType.localeCompare(b.tradeType); break;
    case "date": result = new Date(a.date).getTime() - new Date(b.date).getTime(); break;
    case "advisor": result = a.advisor.localeCompare(b.advisor); break;
    case "submittedBy": result = submitterLabel(a).localeCompare(submitterLabel(b)); break;
    case "status": result = statusRank(a.status) - statusRank(b.status); break;
    default: result = 0;
  }
  return sort.dir === "asc" ? result : -result;
}

/** Reorders only the requests already listed. */
export function sortQueueEntries(entries: readonly TradeRequestListEntry[], sort: QueueSort): TradeRequestListEntry[] {
  return [...entries].sort((a, b) => compareQueueEntries(a, b, sort));
}

/** A new column sorts ascending; the current column reverses. */
export function nextQueueSort(current: QueueSort, key: QueueSortKey): QueueSort {
  return current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}

export function emptyQueueMessage(searchInput: string): string {
  return searchInput.trim() ? QUEUE_COPY.noMatches : QUEUE_COPY.noRequests;
}

export function homeFirstName(name: string | null | undefined, email: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || email?.split("@")[0] || "";
}

const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export function parseCounts(value: unknown): TradeRequestCounts | null {
  if (value == null || typeof value !== "object") return null;
  const { total, pendingReview, needsInfo, approved } = value as Record<string, unknown>;
  return isCount(total) && isCount(pendingReview) && isCount(needsInfo) && isCount(approved)
    ? { total, pendingReview, needsInfo, approved }
    : null;
}

function parseEntry(value: unknown): TradeRequestListEntry | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!isString(entry.id) || !entry.id) return null;
  const clientNames = Array.isArray(entry.clientNames) ? entry.clientNames.filter(isString) : [];
  return {
    ...entry,
    id: entry.id,
    clientName: isString(entry.clientName) ? entry.clientName : clientNames[0] ?? "",
    clientNames,
    advisor: isString(entry.advisor) ? entry.advisor : "",
    submittedBy: isString(entry.submittedBy) ? entry.submittedBy : "",
    tradeType: isString(entry.tradeType) ? entry.tradeType : "",
    status: isString(entry.status) ? entry.status : "",
    date: isString(entry.date) ? entry.date : "",
    updatedAt: isString(entry.updatedAt) ? entry.updatedAt : "",
  };
}

export function parseRequestPage(value: unknown): TradeRequestPage | null {
  if (value == null || typeof value !== "object") return null;
  const { data, nextCursor } = value as Record<string, unknown>;
  if (!Array.isArray(data) || (nextCursor != null && !isString(nextCursor))) return null;
  const entries = data.map(parseEntry);
  if (entries.some((entry) => entry === null)) return null;
  return { data: entries as TradeRequestListEntry[], nextCursor: nextCursor || null };
}
