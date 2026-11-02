import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageHeader } from "@/components/ui";
import { ReportingTabs } from "@/components/reporting/ReportingTabs";
import { SavedReportShortcuts } from "@/components/reporting/SavedReportShortcuts";
import { MAILING_REPORT_SHORTCUT } from "@/lib/reporting/saved-reports";
import { ActivityView } from "@/components/asset-transfer/views/ActivityView";
import { getAssetTransferWorkspace } from "@/lib/data/asset-transfer-workspace";
import { canReadAudit } from "@/lib/data/audit-log";
import { canReadCrmReporting } from "@/lib/data/crm-reporting";
import { assetTransferWorkspaceEnabled, crmReportingEnabled } from "@/lib/flags";
import { safeListHref } from "@/lib/navigation/list-routes";
import "@/components/asset-transfer/workspace/workspace.css";
import "@/components/asset-transfer/workspace/workspace-dark.css";

/** Cross-transfer activity: the transfer audit trail, open to the audit-log roles only. */
export default async function TransferActivityReportPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!assetTransferWorkspaceEnabled() || !canReadAudit(role)) notFound();
  const raw = (await searchParams).q;
  if (Array.isArray(raw)) redirect("/reporting/transfer-activity");
  const query = (raw ?? "").trim();
  const listHref = safeListHref(query ? `/reporting/transfer-activity?q=${encodeURIComponent(query)}` : "/reporting/transfer-activity");
  if (!listHref) redirect("/reporting/transfer-activity");
  const { transfers, activity } = await getAssetTransferWorkspace({ role, email: session.user.email ?? null });
  return (
    <>
      <PageHeader eyebrow="Intelligence · Asset transfer" title="Reporting"
        description="Recorded actions across every transfer. Each transfer's own activity is on its transfer page." />
      <ReportingTabs current="transfer-activity" crm={crmReportingEnabled() && canReadCrmReporting(role)} transferActivity />
      <SavedReportShortcuts reports={[MAILING_REPORT_SHORTCUT]} />
      <div className="atw atw-card" data-transfer-activity-report>
        <ActivityView transfers={transfers} activity={activity} query={query} scope={session.navigationScope ?? ""} listHref={listHref} />
      </div>
    </>
  );
}
