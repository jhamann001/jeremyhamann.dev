import { TRADE_REQUESTS_API_HEADERS, tradeRequestsApiError, tradeRequestsApiRefusal } from "@/lib/trade-requests/api-gate";
import { readTradeRequestPage } from "@/lib/trade-requests/queue";
import { QUEUE_CURSOR_MAX, QUEUE_SEARCH_MAX } from "@/lib/trade-requests/queue-model";
import { TRADE_REQUESTS_QUEUE_HEADERS } from "@/lib/trade-requests/routes";

export const dynamic = "force-dynamic";

function headerValue(request: Request, name: string, max: number): string | undefined | null {
  const raw = request.headers.get(name);
  if (raw === null) return undefined;
  try {
    const value = decodeURIComponent(raw);
    return value.length > max ? null : value;
  } catch {
    return null;
  }
}

// Trading Queue page: the newest 50 for the search, or the next 50 older than
// the cursor. The search term (client names) arrives in a header, never the
// URL, so it stays out of request logs.
export async function GET(request: Request) {
  const refusal = await tradeRequestsApiRefusal(request);
  if (refusal) return refusal;
  if ([...new URL(request.url).searchParams.keys()].length > 0) return tradeRequestsApiError(400);
  const q = headerValue(request, TRADE_REQUESTS_QUEUE_HEADERS.search, QUEUE_SEARCH_MAX);
  const before = headerValue(request, TRADE_REQUESTS_QUEUE_HEADERS.before, QUEUE_CURSOR_MAX);
  if (q === null || before === null) return tradeRequestsApiError(400);
  return Response.json(await readTradeRequestPage({ q, before }), { headers: TRADE_REQUESTS_API_HEADERS });
}
