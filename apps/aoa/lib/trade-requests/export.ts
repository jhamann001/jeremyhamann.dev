import "server-only";
import { callTradeRequestService, type TradeRequestOperation } from "./client";
import { isTradeRequest, type PdfAccountExclusion } from "./detail-view";
import {
  EXPORT_COPY, EXPORT_LOOKUP_CHUNK, idMap, parseExclusionMap,
  type TradeRequestClientExclusion, type TradeRequestExportResult,
} from "./export-model";
import type { TradeRequest, TradeRequestAccountExclusion, TradeRequestClient } from "./request-types";

type Lookup<T> = { ok: true; byId: Record<string, T[]> } | { ok: false; reason: string };

// One attempt per chunk (the export's exclusion lookups are never retried); the
// first failing chunk fails the whole lookup, as in the standalone app.
async function bulkLookup<T>(operation: TradeRequestOperation, path: `/${string}`, field: "clientIds" | "accountIds", ids: string[]): Promise<Lookup<T>> {
  const unique = [...new Set(ids)];
  const byId = idMap<T[]>();
  for (let start = 0; start < unique.length; start += EXPORT_LOOKUP_CHUNK) {
    const result = await callTradeRequestService<{ data?: unknown }>({
      operation, method: "POST", path, body: { [field]: unique.slice(start, start + EXPORT_LOOKUP_CHUNK) },
      defaultMessage: EXPORT_COPY.defaultReason,
    });
    if (!result.ok) return { ok: false, reason: result.message };
    const chunk = parseExclusionMap<T>(result.data?.data);
    if (!chunk) return { ok: false, reason: EXPORT_COPY.defaultReason };
    for (const [id, list] of Object.entries(chunk)) byId[id] = list;
  }
  return { ok: true, byId };
}

async function loadClients(): Promise<TradeRequestClient[]> {
  const result = await callTradeRequestService<{ data?: unknown }>({
    operation: "clientList", method: "GET", path: "/clients", defaultMessage: EXPORT_COPY.defaultReason,
  });
  if (!result.ok || !Array.isArray(result.data?.data)) return [];
  return (result.data.data as TradeRequestClient[]).filter((client) => client != null && typeof client === "object" && typeof client.id === "string");
}

const isAccount = (value: unknown): value is { id: string; accountNumber: string } =>
  value != null && typeof value === "object"
  && typeof (value as { id?: unknown }).id === "string" && (value as { id: string }).id !== ""
  && typeof (value as { accountNumber?: unknown }).accountNumber === "string";

async function loadStandingExclusions(requests: TradeRequest[], messages: string[]): Promise<Record<string, TradeRequestClientExclusion[]>> {
  const ids = requests.flatMap((request) => [request.clientId, ...(request.clientIds ?? [])]).filter((id) => typeof id === "string" && id !== "");
  if (ids.length === 0) return idMap();
  const lookup = await bulkLookup<TradeRequestClientExclusion>("exportExclusions", "/clients/exclusions/bulk", "clientIds", ids);
  if (lookup.ok) return lookup.byId;
  messages.push(EXPORT_COPY.standingUnavailable(lookup.reason));
  return idMap();
}

/**
 * Selected account numbers resolve to account ids through the current client
 * list (first of the request's clients that holds the number); numbers that do
 * not resolve are counted and skipped.
 */
async function loadAccountExclusions(
  requests: TradeRequest[], clients: TradeRequestClient[], messages: string[],
): Promise<Record<string, PdfAccountExclusion[]>> {
  const accountIdByClientAndNumber = new Map<string, string>();
  for (const client of clients) {
    for (const account of Array.isArray(client.accounts) ? client.accounts : []) {
      if (!isAccount(account)) continue;
      accountIdByClientAndNumber.set(`${client.id}::${account.accountNumber}`, account.id);
    }
  }

  const refsByRequest = new Map<string, Array<{ accountNumber: string; accountId: string }>>();
  const accountIds = new Set<string>();
  let unresolved = 0;
  for (const request of requests) {
    const clientIds = request.clientIds?.length ? request.clientIds : [request.clientId];
    const refs: Array<{ accountNumber: string; accountId: string }> = [];
    const seen = new Set<string>();
    for (const accountNumber of request.selectedAccounts ?? []) {
      if (typeof accountNumber !== "string") {
        unresolved += 1;
        continue;
      }
      let accountId: string | null = null;
      for (const clientId of clientIds) {
        const resolved = accountIdByClientAndNumber.get(`${clientId}::${accountNumber}`);
        if (resolved) {
          accountId = resolved;
          break;
        }
      }
      if (!accountId) {
        unresolved += 1;
        continue;
      }
      if (seen.has(accountId)) continue;
      seen.add(accountId);
      refs.push({ accountNumber, accountId });
      accountIds.add(accountId);
    }
    if (refs.length > 0) refsByRequest.set(request.id, refs);
  }
  if (accountIds.size === 0) return idMap();

  const lookup = await bulkLookup<TradeRequestAccountExclusion>(
    "accountExclusionsLookup", "/clients/account-exclusions/bulk", "accountIds", [...accountIds],
  );
  if (!lookup.ok) {
    messages.push(EXPORT_COPY.accountUnavailable(lookup.reason));
    return idMap();
  }
  const byRequest = idMap<PdfAccountExclusion[]>();
  for (const [requestId, refs] of refsByRequest) {
    const flattened = refs.flatMap((ref) => (lookup.byId[ref.accountId] ?? []).map((exclusion) => ({
      accountNumber: ref.accountNumber, kind: exclusion.kind, ticker: exclusion.ticker, reason: exclusion.reason,
      noBuy: exclusion.noBuy, noSell: exclusion.noSell,
    })));
    if (flattened.length > 0) byRequest[requestId] = flattened;
  }
  if (unresolved > 0) messages.push(EXPORT_COPY.accountsPartial(unresolved));
  return byRequest;
}

/**
 * Everything the export files hold: every request in the firm, newest first, up
 * to the service's 5,000 cap, regardless of any search, with the current
 * standing exclusions. Exclusion failures leave the export to complete without
 * them; only a failed request list fails the export.
 */
export async function readTradeRequestExport(): Promise<TradeRequestExportResult> {
  const [list, clients] = await Promise.all([
    callTradeRequestService<{ data?: unknown; truncated?: unknown }>({
      operation: "listRequests", method: "GET", path: "/requests", query: { all: true },
      defaultMessage: EXPORT_COPY.defaultReason,
    }),
    loadClients(),
  ]);
  if (!list.ok) return { ok: false, outcome: list.outcome, message: list.message };
  const rows = list.data?.data;
  if (!Array.isArray(rows) || !rows.every(isTradeRequest)) return { ok: false, outcome: "failed", message: EXPORT_COPY.defaultReason };

  const messages: string[] = [];
  if (list.data?.truncated === true) messages.push(EXPORT_COPY.capped);
  const standingByClient = await loadStandingExclusions(rows, messages);
  const accountExclusionsByRequestId = await loadAccountExclusions(rows, clients, messages);
  return { ok: true, data: { requests: rows, standingByClient, accountExclusionsByRequestId, messages } };
}
