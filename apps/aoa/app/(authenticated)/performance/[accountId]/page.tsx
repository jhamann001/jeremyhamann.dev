import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { apexAccountByNumber } from "@/lib/data/account-aum";
import { fetchAccountReportData, TwrDataError } from "@/lib/twr/warehouse";
import { computeTwrWithMarketRf } from "@/lib/data/risk-free-rate";
import { TwrInsufficientHistoryError, type TwrResult } from "@/lib/twr/engine";
import type { RiskFreeWindow } from "@/lib/twr/risk-free-rate";
import { reportDateEt } from "@/lib/twr/report-date";
import { canOpenReport } from "@/lib/twr/authz";
import {
  accountLast4,
  recordAccountReportGenerated,
} from "@/lib/twr/report-audit";
import { recordPerformanceReportCalculation } from "@/lib/twr/report-record";
import { PerformanceReport } from "@/components/twr";
import { Card, CardHeader, CardBody, SectionLabel } from "@/components/ui";

export const runtime = "nodejs"; // Warehouse fetch + engine compute

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { accountId } = await params;
  // `from` carries the originating client-portrait id (set by AccountsSection)
  // so the back link returns to THAT client's portrait, not the client list.
  // Used only as an encoded path segment under /client-portrait/ (encodeURIComponent
  // keeps it from escaping the segment), so no open-redirect surface.
  const { from } = await searchParams;

  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const email = session.user.email ?? null;

  // Coarse role gate — VIEWER/unknown never reach account data.
  if (!canOpenReport(role)) notFound();

  // Per-account authorization. apexAccountByNumber runs inside withUserScope, so
  // the client_account_aum_own_book RLS policy decides visibility: Ops/Admin/HoA
  // get any account; an Advisor/Client Service gets the row ONLY when the
  // account's household is in their book. No row → 404 (never leak existence).
  const authorized = await apexAccountByNumber({ role, email }, accountId);
  if (!authorized) notFound();

  // Compliance authorized-attempt record — AFTER both gates, BEFORE any
  // custodial fetch, so a refused request leaves no row implying access and an
  // audit failure means the report is never assembled (fail closed, see
  // lib/twr/report-audit.ts). It is not a success/delivery event. ids + masked
  // last-4 only, never the account number.
  const reportId = await recordAccountReportGenerated(
    { role, email },
    {
      custodianAccountId: authorized.custodianAccountId,
      apexAccountNumber: authorized.apexAccountNumber,
      accountType: authorized.accountType,
      clientSfId: authorized.clientSfId,
    },
  );

  const backHref = from
    ? `/client-portrait/${encodeURIComponent(from)}`
    : "/client-portrait";
  const backLink = (
    <div style={{ marginBottom: 10 }}>
      <Link
        href={backHref}
        style={{ color: "var(--muted)", fontSize: 13, textDecoration: "none" }}
        className="noPrint"
      >
        ← Client Portrait
      </Link>
    </div>
  );

  // Pull + compute. A data-layer failure renders an honest "unavailable" card;
  // an unknown account (resolver miss) is a 404.
  let data;
  try {
    data = await fetchAccountReportData(accountId);
  } catch (e) {
    if (e instanceof TwrDataError && e.reason === "not_found") notFound();
    return (
      <>
        {backLink}
        <SectionLabel>Client · Performance</SectionLabel>
        <h1 style={{ marginTop: 4 }}>Performance Report</h1>
        <div style={{ marginTop: 24 }}>
          <Card>
            <CardHeader>
              <h2>Report data unavailable</h2>
            </CardHeader>
            <CardBody>
              <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6 }}>
                We couldn&rsquo;t load the custodial performance data for this
                account right now. This is usually a temporary connection issue
                with the reporting warehouse — please try again shortly. If it
                persists, contact Operations.
              </p>
            </CardBody>
          </Card>
        </div>
      </>
    );
  }

  // Compute with the risk-free rate fed from stored Treasury data (the MEAN
  // 3-month par yield over the report's risk window) instead of the constant that
  // used to be hard-coded in warehouse.ts. Insufficient rate coverage SUPPRESSES
  // the Sharpe with a footnote — it never falls back to a stale constant.
  let result: TwrResult;
  let rf: RiskFreeWindow | null;
  try {
    ({ result, rf } = await computeTwrWithMarketRf({ role, email }, data.input));
  } catch (error) {
    if (!(error instanceof TwrInsufficientHistoryError)) throw error;
    return (
      <>
        {backLink}
        <SectionLabel>Client · Performance</SectionLabel>
        <h1 style={{ marginTop: 4 }}>Performance Report</h1>
        <div style={{ marginTop: 24 }}>
          <Card>
            <CardHeader>
              <h2>Not enough history</h2>
            </CardHeader>
            <CardBody>
              <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6 }}>
                This account has not been funded long enough to compute a
                performance history. The report becomes available once enough
                funded balance history exists.
              </p>
            </CardBody>
          </Card>
        </div>
      </>
    );
  }
  // Firm timezone (America/New_York) — Cloud Run is UTC, so a naive
  // toISOString() date would roll to tomorrow every evening ET.
  const reportDate = reportDateEt();

  // Immutable numeric/provenance snapshot — AFTER the calculation succeeds,
  // BEFORE the report is returned. This proves calculation completion, not
  // browser render/PDF creation/delivery. Fail closed: every returned report
  // must have both its authorized-attempt row and its durable result record.
  await recordPerformanceReportCalculation(
    { role, email },
    {
      reportId,
      scope: "account",
      entityId: authorized.custodianAccountId,
      reportDate,
      result,
      rf,
      account: {
        accountLast4: accountLast4(authorized.apexAccountNumber),
        accountType: authorized.accountType,
      },
    },
  );

  return (
    <>
      {backLink}
      <PerformanceReport
        reportId={reportId}
        identity={data.identity}
        result={result}
        rf={rf}
        reportDate={reportDate}
      />
    </>
  );
}
