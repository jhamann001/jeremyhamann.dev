import "server-only";
import { auth } from "@/auth";
import { tradeRequestsWorkspaceEnabled } from "@/lib/flags";
import { canUseTradeRequestsWorkspace } from "./access";
import { callTradeRequestService } from "./client";
import { BELL_COPY, BELL_LIST_LIMIT, isNotificationId, parseBellNotifications, type BellNotificationList } from "./notifications-model";

export const BELL_API_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" } as const;

export const bellApiResponse = (body: unknown, status = 200) => Response.json(body, { status, headers: BELL_API_HEADERS });

/**
 * The bell's routes answer only workspace roles while the epic flag is on.
 * Writes also require a same-origin browser request; the delegated client
 * re-checks the stored role on every call.
 */
export async function bellRouteRefusal(request: Request, { write }: { write: boolean }): Promise<Response | null> {
  if (!tradeRequestsWorkspaceEnabled()) return bellApiResponse({ ok: false }, 404);
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || (write && site !== "same-origin")) return bellApiResponse({ ok: false }, 403);
  let session;
  try {
    session = await auth();
  } catch {
    return bellApiResponse({ ok: false }, 503);
  }
  if (!session?.user) return bellApiResponse({ ok: false }, 401);
  if (!canUseTradeRequestsWorkspace((session.user as { role?: string }).role)) return bellApiResponse({ ok: false }, 403);
  return null;
}

/** Up to the 100 most recent service notifications for the signed-in person, newest first. */
export async function readBellNotifications(): Promise<BellNotificationList | null> {
  const result = await callTradeRequestService<unknown>({
    operation: "notificationsList", method: "GET", path: "/notifications",
    query: { limit: BELL_LIST_LIMIT }, defaultMessage: BELL_COPY.unavailable, channel: "bell",
  });
  return result.ok ? parseBellNotifications(result.data) : null;
}

export async function markBellNotificationRead(id: string): Promise<boolean> {
  if (!isNotificationId(id)) return false;
  const result = await callTradeRequestService<unknown>({
    operation: "markNotificationRead", method: "PATCH", path: `/notifications/${encodeURIComponent(id)}/read`,
    defaultMessage: BELL_COPY.unavailable, channel: "bell",
  });
  return result.ok;
}

export async function markAllBellNotificationsRead(): Promise<boolean> {
  const result = await callTradeRequestService<unknown>({
    operation: "markAllNotificationsRead", method: "POST", path: "/notifications/read-all",
    defaultMessage: BELL_COPY.unavailable, channel: "bell",
  });
  return result.ok;
}
