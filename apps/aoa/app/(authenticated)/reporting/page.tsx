import { createHash } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { ReportingWorkbench } from "@/components/crm";
import { PageHeader, Pill } from "@/components/ui";
import { assetTransferWorkspaceEnabled, crmReportingEnabled } from "@/lib/flags";
import { canReadAudit } from "@/lib/data/audit-log";
import { ReportingTabs } from "@/components/reporting/ReportingTabs";
import { MAILING_REPORT_SHORTCUT } from "@/lib/reporting/saved-reports";
import {
  canReadCrmReporting,
  getCrmReportingDatasets,
} from "@/lib/data/crm-reporting";
import {
  parseCrmReportQuery,
  crmReportHref,
  type ReportingSearchParams,
} from "@/lib/crm/reporting-query";

export default async function ReportingPage({
  searchParams,
}: {
  searchParams: Promise<ReportingSearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const userId = (session.user as { id?: string }).id;
  const storagePrincipal = userId ?? session.user.email ?? "authenticated-user";
  const storageScope = createHash("sha256")
    .update(`reporting-saved-views:${storagePrincipal}`)
    .digest("hex")
    .slice(0, 24);
  const mailing = assetTransferWorkspaceEnabled();
  const transferActivity = mailing && canReadAudit(role);
  if (!crmReportingEnabled() || !canReadCrmReporting(role)) {
    if (transferActivity) redirect("/reporting/transfer-activity");
    if (mailing) redirect("/reporting/mailing");
    notFound();
  }
  const query = parseCrmReportQuery(await searchParams);
  const result = await getCrmReportingDatasets({
    role,
    email: session.user.email ?? null,
  }, query);
  if (!result.ok) notFound();
  const dataset = result.datasets[0];
  if (dataset.available && dataset.page !== query.page) {
    redirect(crmReportHref(query, { page: dataset.page }));
  }

  return (
    <>
      <PageHeader
        eyebrow="Intelligence · CRM reporting"
        title="Reporting"
        description="Read-only operating reports from current AOA household, custodian, deal, and relationship records."
        actions={<Pill tone="green" dot>Live data</Pill>}
      />
      <ReportingTabs current="crm" crm transferActivity={transferActivity} />
      <div style={{ marginTop: 22 }}>
        <ReportingWorkbench
          key={crmReportHref(query) + ":" + (dataset.snapshot ?? "unavailable")}
          datasets={result.datasets}
          query={query}
          storageScope={storageScope}
          navigationScope={session.navigationScope ?? ""}
          savedReports={mailing ? [MAILING_REPORT_SHORTCUT] : []}
        />
      </div>
    </>
  );
}
