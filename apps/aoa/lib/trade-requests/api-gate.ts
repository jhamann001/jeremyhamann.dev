import "server-only";
import { auth } from "@/auth";
import { tradeRequestsWorkspaceEnabled } from "@/lib/flags";
import { canUseTradeRequestsWorkspace } from "./access";

export const TRADE_REQUESTS_API_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" } as const;

export const tradeRequestsApiError = (status: number) =>
  Response.json({ ok: false, outcome: "refused" }, { status, headers: TRADE_REQUESTS_API_HEADERS });

/**
 * Workspace JSON reads answer only same-site requests from a workspace role
 * while the epic flag is on; the delegated client re-checks the stored role.
 */
export async function tradeRequestsApiRefusal(request: Request): Promise<Response | null> {
  if (!tradeRequestsWorkspaceEnabled()) return tradeRequestsApiError(404);
  if (request.headers.get("sec-fetch-site") === "cross-site") return tradeRequestsApiError(403);
  let session;
  try {
    session = await auth();
  } catch {
    return tradeRequestsApiError(503);
  }
  if (!session?.user) return tradeRequestsApiError(401);
  if (!canUseTradeRequestsWorkspace((session.user as { role?: string }).role)) return tradeRequestsApiError(403);
  return null;
}
