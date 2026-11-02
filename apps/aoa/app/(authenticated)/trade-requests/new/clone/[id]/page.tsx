import { SourceRequestPage } from "@/components/trade-requests/form/submit/SourceRequestPage";
import { tradeRequestsWorkspaceAccess } from "@/lib/trade-requests/workspace-gate";

export default async function TradeRequestsCloneRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await tradeRequestsWorkspaceAccess();
  if (!access.allowed) return null;
  const { id } = await params;
  return <SourceRequestPage mode="clone" id={id} role={access.role} />;
}
