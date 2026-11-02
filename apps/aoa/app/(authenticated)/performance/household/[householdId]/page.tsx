import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { householdHeader } from "@/lib/data/households";
import { apexAccountsForHousehold } from "@/lib/data/account-aum";
import { fetchHouseholdReportData } from "@/lib/twr/household";
import { TwrDataError } from "@/lib/twr/warehouse";
import { computeTwrWithMarketRf } from "@/lib/data/risk-free-rate";
import { TwrInsufficientHistoryError, type TwrResult } from "@/lib/twr/engine";
import type { RiskFreeWindow } from "@/lib/twr/risk-free-rate";
import { reportDateEt } from "@/lib/twr/report-date";
import { canOpenReport } from "@/lib/twr/authz";
import {
  accountLast4,
  recordHouseholdReportGenerated,
} from "@/lib/twr/report-audit";
import { recordPerformanceReportCalculation } from "@/lib/twr/report-record";
import { HouseholdPerformanceReport } from "@/components/twr";
import { Card, CardHeader, CardBody, SectionLabel } from "@/components/ui";

export const runtime = "nodejs"; // Warehouse fetch + engine compute

// Household-level TWR Portfolio Performance Report. AUTHZ FIRST, the same
// two-layer pattern as the account page (/performance/[accountId]):
//   1. canOpenReport role gate — VIEWER/unknown never reach household data.
//   2. Own-book: householdHeader reads mirror.household by sf_id inside
//      withUserScope, so RLS decides visibility — no row → notFound() BEFORE
//      any Warehouse call (never leak existence).
// The member account list then comes from mirror.client_account_aum via the
// RLS-scoped apexAccountsForHousehold seam (same left(...,15) width
// normalization as householdApexAumTotal).
// Only THEN — authorization already granted, no custodial data fetched yet — the
// authorized attempt is recorded to the audit log (lib/twr/report-audit.ts). The order is
// the compliance property twice over: a refused request reads no data AND leaves
// no record implying it did.

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ marginTop: 24 }}>
      <Card>
        <CardHeader>
          <h2>{title}</h2>
        </CardHeader>
        <CardBody>
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.6 }}>{body}</p>
        </CardBody>
      </Card>
    </div>
  );
}

export default async function Page({
  params,
}: {
  params: Promise<{ householdId: string }>;
}) {
  const { householdId } = await params;

  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const email = session.user.email ?? null;

  // Coarse role gate — VIEWER/unknown never reach household data.
  if (!canOpenReport(role)) notFound();

  // Own-book household authorization (RLS via withUserScope). An unknown or
  // out-of-book household id yields no row → 404, before any Warehouse call.
  const identity = { role, email };
  const hh = await householdHeader(identity, householdId);
  if (!hh) notFound();

  const backLink = (
    <div style={{ marginBottom: 10 }}>
      <Link
        href={`/households/${encodeURIComponent(hh.sf_id)}`}
        style={{ color: "var(--muted)", fontSize: 13, textDecoration: "none" }}
        className="noPrint"
      >
        ← {hh.name}
      </Link>
    </div>
  );

  const header = (
    <>
      {backLink}
      <SectionLabel>Household · Performance</SectionLabel>
      <h1 style={{ marginTop: 4 }}>Household Performance Report</h1>
    </>
  );

  // Member list — RLS-scoped. A household with 0 Apex accounts is a normal
  // state (e.g. not yet funded), not an error.
  const accounts = await apexAccountsForHousehold(identity, hh.sf_id);
  // Only accounts with an Apex number are reportable (ticket made the number
  // nullable for firm corporate accounts; those never reach this page, but the
  // filter keeps the member set well-typed). Resolved here so the audit record
  // can carry the report's breadth as a count.
  const reportable = accounts
    .filter((a) => a.apexAccountNumber != null)
    .map((a) => ({ apexAccountNumber: a.apexAccountNumber as string }));

  // Compliance authorized-attempt record — AFTER both authz gates
  // (canOpenReport + the RLS-scoped householdHeader read) and BEFORE any Warehouse
  // call, so a refused request leaves no row implying access. Written even when
  // the household turns out to have nothing reportable: the household WAS opened
  // and that is the access an examiner asks about. ids + counts only, never a
  // household or client name. It is not a success/delivery event. Fail closed —
  // see lib/twr/report-audit.ts.
  const reportId = await recordHouseholdReportGenerated(identity, {
    householdSfId: hh.sf_id,
    reportableAccounts: reportable.length,
  });

  if (!accounts.length) {
    return (
      <>
        {header}
        <InfoCard
          title="No reportable accounts"
          body={`${hh.name} has no investment accounts on the reporting feed yet, so there is no performance to report. Accounts appear here once they are opened and funded.`}
        />
      </>
    );
  }

  // Pull + compute. A data-layer failure renders an honest "unavailable"
  // card; a household whose accounts have no warehouse history yet renders
  // the friendly empty state.
  let data;
  try {
    data = await fetchHouseholdReportData(hh.sf_id, reportable);
  } catch (e) {
    if (e instanceof TwrDataError && e.reason === "no_data") {
      return (
        <>
          {header}
          <InfoCard
            title="No reportable accounts"
            body={`${hh.name}'s accounts have no custodial balance history on the reporting warehouse yet, so there is no performance to report.`}
          />
        </>
      );
    }
    return (
      <>
        {header}
        <InfoCard
          title="Report data unavailable"
          body="We couldn't load the custodial performance data for this household right now. This is usually a temporary connection issue with the reporting warehouse — please try again shortly. If it persists, contact Operations."
        />
      </>
    );
  }

  // Data-quality warnings (stale-member carry-forwards ≤ 5 days): STATIC
  // counts-only marker — lag days but never account numbers. The report body
  // never shows these to the client.
  if (data.warnings.length) {
    console.warn(
      `[twr:household] stale_member_carry count=${data.warnings.length} lagDays=${data.warnings
        .map((w) => w.lagDays)
        .join(",")}`,
    );
  }

  // A household whose combined series never funded (all balances ~$0) has no
  // daily returns to chain — same friendly state, not a 500.
  // Compute with the risk-free rate fed from stored Treasury data (the MEAN
  // 3-month par yield over the report's risk window) instead of the constant that
  // used to be hard-coded in household.ts. Insufficient rate coverage SUPPRESSES
  // the Sharpe with a footnote — it never falls back to a stale constant. The
  // rate read degrades internally (it cannot throw), so this try/catch still
  // guards exactly what it did before: the engine's "no funded returns" throw.
  let result: TwrResult;
  let rf: RiskFreeWindow | null;
  try {
    ({ result, rf } = await computeTwrWithMarketRf(identity, data.input));
  } catch (error) {
    if (!(error instanceof TwrInsufficientHistoryError)) throw error;
    return (
      <>
        {header}
        <InfoCard
          title="Not enough history"
          body={`${hh.name}'s accounts have not been funded long enough to compute a performance history. The report becomes available once funded balances exist.`}
        />
      </>
    );
  }

  // Firm timezone (America/New_York) — Cloud Run is UTC, so a naive
  // toISOString() date would roll to tomorrow every evening ET.
  const reportDate = reportDateEt();

  await recordPerformanceReportCalculation(identity, {
    reportId,
    scope: "household",
    entityId: hh.sf_id,
    reportDate,
    result,
    rf,
    householdMembers: data.members.map((member) => ({
      accountLast4: accountLast4(member.apexAcct),
      endingValue: member.endingValue,
      weightPct: member.weightPct,
      sinceInceptionTwr: member.sinceInceptionTwr,
      costBasisExcluded: member.costBasisExcluded,
    })),
  });

  return (
    <>
      {backLink}
      <HouseholdPerformanceReport
        reportId={reportId}
        householdName={hh.name}
        memberCount={data.memberCount}
        members={data.members}
        result={result}
        rf={rf}
        reportDate={reportDate}
      />
    </>
  );
}
