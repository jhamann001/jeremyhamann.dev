import { bellApiResponse, bellRouteRefusal, markAllBellNotificationsRead } from "@/lib/trade-requests/notifications";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const refusal = await bellRouteRefusal(request, { write: true });
  if (refusal) return refusal;
  return (await markAllBellNotificationsRead()) ? bellApiResponse({ ok: true }) : bellApiResponse({ ok: false }, 502);
}
