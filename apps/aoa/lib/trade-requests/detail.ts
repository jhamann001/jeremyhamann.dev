import "server-only";
import { callTradeRequestService } from "./client";
import { REQUEST_DETAIL_COPY, isLoadableRequestId, isTradeRequest, resolveSelectedAccounts } from "./detail-view";
import type { TradeRequest, TradeRequestAccount, TradeRequestAccountExclusion, TradeRequestClient } from "./request-types";

export type TradeRequestDetailLoad =
  | { kind: "found"; request: TradeRequest; accounts: TradeRequestAccount[] }
  | { kind: "not_found" }
  | { kind: "not_set_up"; message: string }
  | { kind: "failed"; message: string };

// The client list only places the selected accounts; when it cannot be read
// the request's stored account details are shown instead, with no message.
async function loadClients(): Promise<TradeRequestClient[] | null> {
  const result = await callTradeRequestService<{ data?: unknown }>({
    operation: "clientList", method: "GET", path: "/clients", defaultMessage: REQUEST_DETAIL_COPY.loadFailed,
  });
  return result.ok && Array.isArray(result.data?.data) ? (result.data.data as TradeRequestClient[]) : null;
}

/** The direct-link load: the single request and its selected accounts. */
export async function loadTradeRequestDetail(id: string): Promise<TradeRequestDetailLoad> {
  if (!isLoadableRequestId(id)) return { kind: "not_found" };
  const [detail, clients] = await Promise.all([
    callTradeRequestService<{ data?: unknown }>({
      operation: "requestDetail", method: "GET", path: `/requests/${encodeURIComponent(id)}`,
      defaultMessage: REQUEST_DETAIL_COPY.loadFailed,
    }),
    loadClients(),
  ]);
  if (detail.ok) {
    return isTradeRequest(detail.data?.data)
      ? { kind: "found", request: detail.data.data, accounts: resolveSelectedAccounts(detail.data.data, clients) }
      : { kind: "failed", message: REQUEST_DETAIL_COPY.loadFailed };
  }
  if (detail.outcome === "not_set_up") return { kind: "not_set_up", message: detail.message };
  if (detail.status === 404) return { kind: "not_found" };
  return { kind: "failed", message: detail.message };
}

export type AccountExclusionsLoad =
  | { ok: true; byAccountId: Record<string, TradeRequestAccountExclusion[]> }
  | { ok: false; message: string };

/** Standing account-level exclusions for the request PDF; one attempt, as in the standalone app. */
export async function loadAccountExclusions(accountIds: string[]): Promise<AccountExclusionsLoad> {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) return { ok: true, byAccountId: {} };
  const result = await callTradeRequestService<{ data?: unknown }>({
    operation: "accountExclusionsLookup", method: "POST", path: "/clients/account-exclusions/bulk",
    body: { accountIds: unique }, defaultMessage: REQUEST_DETAIL_COPY.pdfFailed,
  });
  if (!result.ok) return { ok: false, message: result.message };
  const data = result.data?.data;
  if (data == null || typeof data !== "object" || Array.isArray(data)) return { ok: false, message: REQUEST_DETAIL_COPY.pdfFailed };
  return { ok: true, byAccountId: data as Record<string, TradeRequestAccountExclusion[]> };
}
