import { redirect } from "next/navigation";
import { Suspense } from "react";
import { signOut } from "@/auth";
import { getRequestSession } from "@/lib/auth/request-session";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar, NotificationsMenu } from "@/components/shell/Topbar";
import { RosterNotifications } from "@/components/shell/RosterNotifications";
import { SessionTimeout } from "@/components/shell/SessionTimeout";
import { ListNavigationBoundary } from "@/components/navigation/ListNavigationBoundary";
import { SessionMessagesProvider } from "@/components/trade-requests/bell/session-messages";
import { TradeRequestGroup, TradeRequestNotificationsProvider } from "@/components/trade-requests/bell/notifications";
import { canUseTradeRequestsWorkspace } from "@/lib/trade-requests/access";
import {
  assetMappingWorkspaceEnabled,
  assetTransferWorkspaceEnabled,
  crmIdentityReadsEnabled,
  crmRelationshipsEnabled,
  crmReportingEnabled,
  dataHealthEnabled,
  acatAdvisorListEnabled,
  operationsToolsEnabled,
  tradeRequestsWorkspaceEnabled,
} from "@/lib/flags";
import { canReadCrmRelationships } from "@/lib/data/crm-relationships";
import { demoMode } from "@/lib/demo/mode";
import styles from "./layout.module.css";

export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const session = await getRequestSession();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const name = session.user.name ?? session.user.email ?? "User";
  const email = session.user.email ?? null;

  // Badge counts are deliberately loaded by Sidebar after first paint. They are
  // useful navigation metadata, but a slow count query must never block or 500
  // every authenticated page.
  const identity = { role, email };
  // CLIENT_SERVICE, VIEWER and every role while the epic flag is off keep
  // today's roster-only bell and never mount the Trade Request provider.
  const bell = tradeRequestsWorkspaceEnabled() && canUseTradeRequestsWorkspace(role) ? (
    <TradeRequestNotificationsProvider>
      <Suspense fallback={<NotificationsMenu state="loading" tradeRequestGroup={<TradeRequestGroup />} />}>
        <RosterNotifications identity={identity} tradeRequestGroup={<TradeRequestGroup />} />
      </Suspense>
    </TradeRequestNotificationsProvider>
  ) : (
    <Suspense fallback={<NotificationsMenu state="loading" />}>
      <RosterNotifications identity={identity} />
    </Suspense>
  );

  return (
    <div className={styles.app} data-app-shell>
      <ListNavigationBoundary scope={session.navigationScope ?? ""} />
      <Sidebar
        role={role}
        scope={session.navigationScope ?? ""}
        crmIdentityReads={crmIdentityReadsEnabled()}
        crmRelationships={crmRelationshipsEnabled() && canReadCrmRelationships(role)}
        crmReporting={crmReportingEnabled()}
        dataHealth={dataHealthEnabled()}
        operationsTools={operationsToolsEnabled()}
        advisorList={acatAdvisorListEnabled()}
        assetMappingWorkspace={assetMappingWorkspaceEnabled()}
        tradeRequestsWorkspace={tradeRequestsWorkspaceEnabled()}
        assetTransferWorkspace={assetTransferWorkspaceEnabled()}
        demo={demoMode()}
      />
      <div className={styles.main} data-app-main>
        <SessionMessagesProvider key={email ?? name}>
          <Topbar name={name} role={role} notificationContent={bell} />
          <div className={styles.content} data-app-content data-list-scroll-container>{children}</div>
        </SessionMessagesProvider>
      </div>
      {/* ticket: pass the current session expiry (from auth()) to the client
          timeout watcher. Every navigation re-renders this layout with a fresh
          `session.expires` (the session slides server-side, see auth.ts), so the
          countdown stays accurate without any client polling. Sign-out runs
          through a CSRF-protected Server Action (POST + Origin-checked by
          Next.js, the same pattern the Topbar uses) — never a forgeable GET. */}
      <SessionTimeout
        expiresAt={session.expires}
        signOutAction={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      />
    </div>
  );
}
