import { TRADE_REQUESTS_API_HEADERS, tradeRequestsApiError, tradeRequestsApiRefusal } from "@/lib/trade-requests/api-gate";
import { readTradeRequestCounts } from "@/lib/trade-requests/queue";

export const dynamic = "force-dynamic";

// Home counts, firm-wide.
export async function GET(request: Request) {
  const refusal = await tradeRequestsApiRefusal(request);
  if (refusal) return refusal;
  if ([...new URL(request.url).searchParams.keys()].length > 0) return tradeRequestsApiError(400);
  return Response.json(await readTradeRequestCounts(), { headers: TRADE_REQUESTS_API_HEADERS });
}
