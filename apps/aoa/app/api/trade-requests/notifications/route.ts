import { bellApiResponse, bellRouteRefusal, readBellNotifications } from "@/lib/trade-requests/notifications";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const refusal = await bellRouteRefusal(request, { write: false });
  if (refusal) return refusal;
  const list = await readBellNotifications();
  return list ? bellApiResponse({ ok: true, data: list }) : bellApiResponse({ ok: false }, 502);
}
