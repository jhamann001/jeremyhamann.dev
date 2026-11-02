import { TradeRequestsHome } from "@/components/trade-requests/home/TradeRequestsHome";
import { getRequestSession } from "@/lib/auth/request-session";
import { homeFirstName } from "@/lib/trade-requests/queue-model";
import { tradeRequestsWorkspaceAccess } from "@/lib/trade-requests/workspace-gate";

export default async function TradeRequestsHomePage() {
  const access = await tradeRequestsWorkspaceAccess();
  if (!access.allowed) return null;
  const user = (await getRequestSession())?.user;
  return (
    <TradeRequestsHome
      firstName={homeFirstName(user?.name, user?.email)}
      reviewer={access.role === "ADMIN" || access.role === "OPERATIONS"}
    />
  );
}
