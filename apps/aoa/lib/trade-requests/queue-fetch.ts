import { QUEUE_COPY, parseCounts, parseRequestPage, type TradeRequestCounts, type TradeRequestPage } from "./queue-model";
import { TRADE_REQUESTS_API, TRADE_REQUESTS_QUEUE_HEADERS } from "./routes";

export type QueueFetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; outcome: "not_set_up" | "failed" | "signed_out"; message: string };

// Browser side of the workspace reads. The route answers with the delegated
// client's outcome; a 401/403 or a redirect means the AOA session or role is
// gone (middleware answers 401 for these paths); anything else on this hop is
// the view's default failure.
async function getJson<T>(url: string, headers: Record<string, string>, parse: (value: unknown) => T | null, defaultMessage: string, signal?: AbortSignal): Promise<QueueFetchResult<T>> {
  let body: unknown;
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json", ...headers }, signal });
    if (response.redirected || response.status === 401 || response.status === 403) return { ok: false, outcome: "signed_out", message: defaultMessage };
    if (!response.ok) return { ok: false, outcome: "failed", message: defaultMessage };
    body = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, outcome: "failed", message: defaultMessage };
  }
  const result = body as { ok?: unknown; outcome?: unknown; message?: unknown; data?: unknown } | null;
  if (result?.ok === true) {
    const data = parse(result.data);
    if (data) return { ok: true, data };
  } else if (result?.ok === false && (result.outcome === "not_set_up" || result.outcome === "failed")) {
    return { ok: false, outcome: result.outcome, message: typeof result.message === "string" && result.message ? result.message : defaultMessage };
  }
  return { ok: false, outcome: "failed", message: defaultMessage };
}

export function fetchTradeRequestPage(input: { before?: string | null; q?: string }, signal?: AbortSignal): Promise<QueueFetchResult<TradeRequestPage>> {
  const headers: Record<string, string> = {};
  if (input.before) headers[TRADE_REQUESTS_QUEUE_HEADERS.before] = encodeURIComponent(input.before);
  const q = input.q?.trim();
  if (q) headers[TRADE_REQUESTS_QUEUE_HEADERS.search] = encodeURIComponent(q);
  return getJson(TRADE_REQUESTS_API.requests, headers, parseRequestPage, input.before ? QUEUE_COPY.loadMoreFailed : QUEUE_COPY.loadFailed, signal);
}

export function fetchTradeRequestCounts(signal?: AbortSignal): Promise<QueueFetchResult<TradeRequestCounts>> {
  return getJson(TRADE_REQUESTS_API.counts, {}, parseCounts, QUEUE_COPY.countsFailed, signal);
}
