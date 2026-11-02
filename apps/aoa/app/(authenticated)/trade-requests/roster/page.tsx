import { notFound } from "next/navigation";
import { RosterView } from "@/components/trade-requests/roster/RosterView";
import { TradeRequestsPermissionScreen } from "@/components/trade-requests/WorkspaceNotices";
import { tradeRequestsWorkspaceAccess } from "@/lib/trade-requests/workspace-gate";
import { tradeRequestsWorkspaceSections } from "@/lib/trade-requests/workspace-sections";

export default async function TradeRequestsRosterPage() {
  const access = await tradeRequestsWorkspaceAccess();
  if (!access.allowed) return null;
  const sections = await tradeRequestsWorkspaceSections(access.role);
  if (!sections.drift) notFound();
  if (access.role !== "ADMIN") return <TradeRequestsPermissionScreen />;
  if (!sections.roster) notFound();
  return <RosterView />;
}
