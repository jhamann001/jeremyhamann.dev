import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { PageHeader } from "@/components/ui";
import { MailingReport } from "@/components/asset-transfer/views/MailingReport";
import { ReportingTabs } from "@/components/reporting/ReportingTabs";
import { SavedReportShortcuts } from "@/components/reporting/SavedReportShortcuts";
import { getAssetTransferWorkspace } from "@/lib/data/asset-transfer-workspace";
import { canReadAudit } from "@/lib/data/audit-log";
import { canReadCrmReporting } from "@/lib/data/crm-reporting";
import { assetTransferWorkspaceEnabled, crmReportingEnabled } from "@/lib/flags";
import { safeListHref } from "@/lib/navigation/list-routes";
import { parseTransferBoardQuery } from "@/lib/navigation/transfer-query";
import { MAILING_REPORT_SHORTCUT } from "@/lib/reporting/saved-reports";
import { getMailingReport } from "@/lib/transfers/mailing";
import "@/components/asset-transfer/workspace/workspace.css";
import "@/components/asset-transfer/workspace/workspace-dark.css";

const FILTER_KEYS = new Set(["q", "mailedFrom", "mailedThrough", "mailingStatus", "carrier"]);

/** Saved mailing report; the existing mailing reader applies the signed-in user's row scope. */
export default async function MailingReportPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  if (!assetTransferWorkspaceEnabled()) notFound();
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const identity = { role, email: session.user.email ?? null };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (!FILTER_KEYS.has(key) || Array.isArray(value)) redirect("/reporting/mailing");
    if (value?.trim()) params.set(key, value.trim());
  }
  let query;
  try { query = parseTransferBoardQuery(params); } catch { redirect("/reporting/mailing"); }
  const listHref = safeListHref(params.size ? `/reporting/mailing?${params}` : "/reporting/mailing");
  if (!listHref) redirect("/reporting/mailing");
  const [rows, { transfers }] = await Promise.all([
    getMailingReport(identity),
    getAssetTransferWorkspace(identity),
  ]);
  return (
    <>
      <PageHeader eyebrow="Intelligence · Saved report" title="Reporting"
        description="FedEx and manual mailers, tracking, and postage from saved transfer records." />
      <ReportingTabs current={null} crm={crmReportingEnabled() && canReadCrmReporting(role)} transferActivity={canReadAudit(role)} />
      <SavedReportShortcuts reports={[MAILING_REPORT_SHORTCUT]} />
      <div className="atw atw-card" data-mailing-report>
        <MailingReport rows={rows} transfers={transfers} filters={{ query: query.query, ...query.mailed }}
          scope={session.navigationScope ?? ""} listHref={listHref} />
      </div>
    </>
  );
}
