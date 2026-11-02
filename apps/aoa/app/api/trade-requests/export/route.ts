import { TRADE_REQUESTS_API_HEADERS, tradeRequestsApiError, tradeRequestsApiRefusal } from "@/lib/trade-requests/api-gate";
import { readTradeRequestExport } from "@/lib/trade-requests/export";

export const dynamic = "force-dynamic";

// Queue export: every request in the firm with the current standing exclusions,
// read separately from the queue's loaded pages.
export async function GET(request: Request) {
  const refusal = await tradeRequestsApiRefusal(request);
  if (refusal) return refusal;
  if ([...new URL(request.url).searchParams.keys()].length > 0) return tradeRequestsApiError(400);
  return Response.json(await readTradeRequestExport(), { headers: TRADE_REQUESTS_API_HEADERS });
}
