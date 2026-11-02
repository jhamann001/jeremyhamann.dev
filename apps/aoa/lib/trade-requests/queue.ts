import "server-only";
import { callTradeRequestService } from "./client";
import {
  QUEUE_COPY, QUEUE_CURSOR_MAX, QUEUE_SEARCH_MAX, parseCounts, parseRequestPage,
  type TradeRequestCounts, type TradeRequestPage,
} from "./queue-model";

export type QueueReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; outcome: "not_set_up" | "failed"; message: string };

/** The newest 50 matching requests firm-wide, or the next 50 older than `before`. */
export async function readTradeRequestPage(input: { before?: string; q?: string }): Promise<QueueReadResult<TradeRequestPage>> {
  const q = input.q?.trim().slice(0, QUEUE_SEARCH_MAX) || undefined;
  const before = input.before?.slice(0, QUEUE_CURSOR_MAX) || undefined;
  const result = await callTradeRequestService<unknown>({
    operation: "listRequests", method: "GET", path: "/requests",
    query: { limit: 50, before, q }, defaultMessage: before ? QUEUE_COPY.loadMoreFailed : QUEUE_COPY.loadFailed,
  });
  if (!result.ok) return { ok: false, outcome: result.outcome, message: result.message };
  const page = parseRequestPage(result.data);
  return page ? { ok: true, data: page } : { ok: false, outcome: "failed", message: before ? QUEUE_COPY.loadMoreFailed : QUEUE_COPY.loadFailed };
}

/** Firm-wide counts for Home. */
export async function readTradeRequestCounts(): Promise<QueueReadResult<TradeRequestCounts>> {
  const result = await callTradeRequestService<unknown>({
    operation: "requestCounts", method: "GET", path: "/requests/counts", defaultMessage: QUEUE_COPY.countsFailed,
  });
  if (!result.ok) return { ok: false, outcome: result.outcome, message: result.message };
  const counts = parseCounts(result.data);
  return counts ? { ok: true, data: counts } : { ok: false, outcome: "failed", message: QUEUE_COPY.countsFailed };
}
