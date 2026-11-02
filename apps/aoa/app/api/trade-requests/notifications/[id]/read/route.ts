import { bellApiResponse, bellRouteRefusal, markBellNotificationRead } from "@/lib/trade-requests/notifications";
import { isNotificationId } from "@/lib/trade-requests/notifications-model";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refusal = await bellRouteRefusal(request, { write: true });
  if (refusal) return refusal;
  const { id } = await params;
  if (!isNotificationId(id)) return bellApiResponse({ ok: false }, 400);
  return (await markBellNotificationRead(id)) ? bellApiResponse({ ok: true }) : bellApiResponse({ ok: false }, 502);
}
