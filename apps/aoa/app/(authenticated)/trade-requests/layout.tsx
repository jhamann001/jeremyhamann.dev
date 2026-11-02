import { tradeRequestsNoPlanCopyEnabled } from "@/lib/flags";
import { tradeRequestsWorkspaceAccess } from "@/lib/trade-requests/workspace-gate";
import { tradeRequestsWorkspaceSections } from "@/lib/trade-requests/workspace-sections";
import { NoPlanCopyProvider } from "@/components/trade-requests/form/NoPlanCopy";
import { WorkspaceFrame } from "@/components/trade-requests/WorkspaceFrame";
import { TradeRequestsPermissionScreen } from "@/components/trade-requests/WorkspaceNotices";

export default async function TradeRequestsLayout({ children }: { children: React.ReactNode }) {
  const access = await tradeRequestsWorkspaceAccess();
  if (!access.allowed) return <TradeRequestsPermissionScreen />;
  const sections = await tradeRequestsWorkspaceSections(access.role);
  return (
    <NoPlanCopyProvider enabled={tradeRequestsNoPlanCopyEnabled()}>
      <WorkspaceFrame sections={sections}>{children}</WorkspaceFrame>
    </NoPlanCopyProvider>
  );
}
