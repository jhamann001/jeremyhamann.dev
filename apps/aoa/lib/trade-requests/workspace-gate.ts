import "server-only";
import { notFound, redirect } from "next/navigation";
import { getRequestSession } from "@/lib/auth/request-session";
import { tradeRequestsWorkspaceEnabled } from "@/lib/flags";
import { canUseTradeRequestsWorkspace } from "./access";

export type TradeRequestsWorkspaceAccess = { allowed: boolean; role: string };

// Every workspace layout AND page calls this first. A layout alone is not a
// boundary: Next renders page segments in parallel with their layout and does
// not re-run a layout on in-segment navigation.
export async function tradeRequestsWorkspaceAccess(): Promise<TradeRequestsWorkspaceAccess> {
  if (!tradeRequestsWorkspaceEnabled()) notFound();
  const session = await getRequestSession();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "";
  return { allowed: canUseTradeRequestsWorkspace(role), role };
}
