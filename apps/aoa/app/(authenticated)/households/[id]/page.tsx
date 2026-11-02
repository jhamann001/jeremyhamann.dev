import { Suspense } from "react";
import { redirect, notFound } from "next/navigation";
import { HouseholdBackLink } from "@/components/navigation/HouseholdBackLink";
import { auth } from "@/auth";
import { getHouseholdPageData } from "@/lib/data/households";
import { getCedarRidgeUserIdsForHouseholdSources } from "@/lib/data/clients";
import { investmentAccountsForHouseholdSources } from "@/lib/data/investment-accounts";
import { getHouseholdHistoryPage } from "@/lib/data/household-history";
import { isHouseholdTaskAssigneeFilter } from "@/lib/navigation/household-history-query";
import { zendeskTicketsForHouseholdSources } from "@/lib/data/zendesk-tickets";
import { Card, Kpi, Pill, SectionLabel, type PillTone } from "@/components/ui";
import { HouseholdOverview } from "@/components/households/HouseholdOverview";
import { HouseholdDeals } from "@/components/households/HouseholdDeals";
import { HouseholdTradeRequestsSection } from "@/components/households/HouseholdTradeRequestsSection";
import { HouseholdTransfersCard } from "@/components/asset-transfer/views/HouseholdTransfersCard";
import { assetTransferWorkspaceEnabled } from "@/lib/flags";
import { CanonicalHouseholdRoute } from "@/components/households/CanonicalHouseholdRoute";
import { CrmIdField } from "@/components/crm";
import {
  crmIdentityIdForSource,
  crmRouteSource,
} from "@/lib/crm/resolve";
import { canViewCrmId } from "@/lib/crm/visibility";
import {
  TasksCard,
  EmailCard,
  ActivityCard,
  TradeRequestsSkeleton,
  ZendeskTicketsCard,
} from "@/components/client-portrait";
import {
  firmAccountTitle,
  FIRM_HOUSEHOLD_NAME,
  HOUSEHOLD_KIND_FIRM,
} from "@/lib/data/firm-household";
import { usd } from "@/lib/format";
import type { HouseholdDetail, Identity } from "@/lib/data/types";
import styles from "./page.module.css";

// REAL, RLS-scoped detail. `getHousehold` reads inside `withUserScope`, so an
// out-of-book or unknown id returns no row — we `notFound()` (404) with no leak.
// Household + members + advisor + AUM are real, and so is the Combined-accounts
// table now (apexAccountsForHousehold → mirror.client_account_aum, RLS-scoped to
// the caller's book). Performance-report entry points are intentionally absent
// while the reports are not approved for client use.

function statusTone(status: string | null): PillTone {
  switch ((status ?? "").trim().toLowerCase()) {
    case "active":
      return "green";
    case "onboarding":
      return "blue";
    case "prospect":
    case "prospects":
      return "gold";
    default:
      return "gray";
  }
}

function SectionLoading({ label }: { label: string }) {
  return (
    <Card aria-busy="true">
      <p style={{ margin: 0, color: "var(--muted)" }}>Loading {label}…</p>
    </Card>
  );
}

async function HouseholdCrmId({
  identity,
  householdSfId,
}: {
  identity: Identity;
  householdSfId: string;
}) {
  if (!canViewCrmId(identity.role)) return null;
  const crmId = await crmIdentityIdForSource(
    identity,
    "HOUSEHOLD",
    crmRouteSource("HOUSEHOLD"),
    householdSfId,
  );
  return crmId ? <CrmIdField value={crmId} /> : null;
}

async function HouseholdAccountsSection({
  identity,
  sourceSfIds,
  household,
  accountStatus,
  accountType,
  showEmptyAccounts,
}: {
  identity: Identity;
  sourceSfIds: string[];
  household: HouseholdDetail;
  accountStatus: "open" | "closed" | "all";
  accountType: string;
  showEmptyAccounts: boolean;
}) {
  const investmentAccounts = await investmentAccountsForHouseholdSources(identity, sourceSfIds);
  const ownerByClient = new Map(
    household.members.map((member) => [
      member.sf_id.slice(0, 15),
      member.name || member.email || member.sf_id,
    ] as const),
  );
  const accounts = investmentAccounts.map((account) => {
    const firmTitle = account.custodian === "Apex" ? firmAccountTitle(account.sourceAccountId) : null;
    return {
      id: account.id,
      custodian: account.custodian,
      owner: account.firmOperating
        ? FIRM_HOUSEHOLD_NAME
        : account.clientSfId
          ? (ownerByClient.get(account.clientSfId.slice(0, 15)) ?? "—")
          : `${household.name} · household-held`,
      type: firmTitle ?? account.type,
      num: account.num,
      status: account.status,
      value: account.value,
      cash: account.cash,
      securities: account.securities,
      balanceAsOf: account.balanceAsOf,
      balanceCurrent: account.balanceCurrent,
      closeDate: account.closeDate,
      closeDateSource: account.closeDateSource,
    };
  });

  return (
    <HouseholdOverview
      name={household.name}
      members={household.members}
      accounts={accounts}
      initialAccountStatus={accountStatus}
      initialAccountType={accountType}
      initialShowEmptyAccounts={showEmptyAccounts}
    />
  );
}

async function HouseholdTasksCard({
  identity,
  householdId, scope, page, includeCompleted, assigneeFilter,
}: {
  identity: Identity;
  householdId: string; scope: string; page: number; includeCompleted: boolean; assigneeFilter?: string;
}) {
  const initialPage = await getHouseholdHistoryPage(identity, householdId, "tasks", { page, includeCompleted, assigneeFilter });
  if (!initialPage) notFound();
  return <TasksCard key={householdId}
    initialPage={initialPage} householdId={householdId} scope={scope} includeCompleted={includeCompleted} />;
}

async function HouseholdZendeskCard({
  identity,
  sourceSfIds,
}: {
  identity: Identity;
  sourceSfIds: string[];
}) {
  const tickets = await zendeskTicketsForHouseholdSources(identity, sourceSfIds);
  return <ZendeskTicketsCard tickets={tickets} scope="household" />;
}

async function HouseholdEmailCard({
  identity,
  householdId, scope, page,
}: {
  identity: Identity;
  householdId: string; scope: string; page: number;
}) {
  const initialPage = await getHouseholdHistoryPage(identity, householdId, "email", { page });
  if (!initialPage) notFound();
  return <EmailCard key={householdId}
    initialPage={initialPage} householdId={householdId} scope={scope} />;
}

async function HouseholdActivityCard({
  identity,
  householdId, scope, page,
}: {
  identity: Identity;
  householdId: string; scope: string; page: number;
}) {
  const initialPage = await getHouseholdHistoryPage(identity, householdId, "activity", { page });
  if (!initialPage) notFound();
  return <ActivityCard key={householdId}
    initialPage={initialPage} householdId={householdId} scope={scope} />;
}

async function HouseholdTradeRequests({
  identity,
  sourceSfIds,
}: {
  identity: Identity;
  sourceSfIds: string[];
}) {
  const cedarRidgeUserIds = await getCedarRidgeUserIdsForHouseholdSources(
    identity,
    sourceSfIds,
  );
  if (cedarRidgeUserIds.length === 0) return null;
  return (
    <div style={{ marginTop: 24 }}>
      <SectionLabel>Household · Trade requests</SectionLabel>
      <div style={{ marginTop: 12 }}>
        <Suspense fallback={<TradeRequestsSkeleton />}>
          <HouseholdTradeRequestsSection cedarRidgeUserIds={cedarRidgeUserIds} />
        </Suspense>
      </div>
    </div>
  );
}

export default async function HouseholdDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const email = session.user.email ?? null;
  const identity = { role, email };

  const { id } = await params;
  const accountParams = await searchParams;
  const {
    canonicalRouteId,
    household: hh,
    sourceSfIds,
  } = await getHouseholdPageData(identity, id);
  if (!hh) notFound();
  const isFirm = hh.household_kind === HOUSEHOLD_KIND_FIRM;

  const accountStatusParam = Array.isArray(accountParams.accountStatus)
    ? accountParams.accountStatus[0]
    : accountParams.accountStatus;
  const accountTypeParam = Array.isArray(accountParams.accountType)
    ? accountParams.accountType[0]
    : accountParams.accountType;
  const historyPageParam = typeof accountParams.page === "string" ? accountParams.page : "";
  const historyPage = /^[1-9]\d{0,6}$/.test(historyPageParam) ? Math.min(1_000_000, Number(historyPageParam)) : 1;
  const historyList = typeof accountParams.list === "string" ? accountParams.list : "";
  const includeCompleted = accountParams.tasksCompleted === "1";
  if (accountParams.tasksAssignee !== undefined && !isHouseholdTaskAssigneeFilter(accountParams.tasksAssignee)) notFound();
  const assigneeFilter = accountParams.tasksAssignee;
  const historyScope = session.navigationScope ?? "";

  return (
    <>
      {canonicalRouteId !== id ? (
        <CanonicalHouseholdRoute canonicalId={canonicalRouteId} />
      ) : null}
      <HouseholdBackLink className={styles.back} scope={session.navigationScope ?? ""}>
        ‹ Back to results
      </HouseholdBackLink>

      <div className={styles.head}>
        <div>
          <SectionLabel>Firm · Household</SectionLabel>
          <h1 style={{ marginTop: 4 }}>{hh.name}</h1>
          <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 13 }}>
            Advisor: {hh.advisorName ?? hh.lead_advisor_email}
          </p>
          <Suspense fallback={null}>
            <HouseholdCrmId identity={identity} householdSfId={hh.sf_id} />
          </Suspense>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 10,
          }}
        >
          <Pill tone={statusTone(hh.status)} dot>
            {hh.status ?? "—"}
          </Pill>
          {hh.employeeStatus ? (
            <Pill tone={hh.employeeStatus === "ACTIVE" ? "green" : "gray"}>
              {hh.employeeStatus === "ACTIVE" ? "Employee" : "Former employee"}
            </Pill>
          ) : null}
          {hh.canonicalSourceCount > 1 ? (
            <Pill tone="blue">
              {hh.canonicalSourceCount} source records combined in AOA
            </Pill>
          ) : null}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 16,
          marginTop: 18,
        }}
      >
        <Card>
          <Kpi
            label={isFirm ? "Firm AUM" : "Client AUM"}
            value={hh.aumPending ? "—" : usd(hh.aum)}
            caption={hh.aumPending ? "Balance refresh pending" : undefined}
          />
        </Card>
        <Card>
          <Kpi label="Members" value={hh.members.length} />
        </Card>
      </div>

      <div style={{ marginTop: 24 }}>
        <Suspense fallback={<SectionLoading label="accounts" />}>
          <HouseholdAccountsSection
            identity={identity}
            sourceSfIds={sourceSfIds}
            household={hh}
            accountStatus={
              accountStatusParam === "closed" || accountStatusParam === "all"
                ? accountStatusParam
                : "open"
            }
            accountType={(accountTypeParam ?? "").trim().toLowerCase()}
            showEmptyAccounts={accountParams.showEmptyAccounts === "1"}
          />
        </Suspense>
      </div>

      <div className={styles.workGrid}>
        <Suspense fallback={<SectionLoading label="tasks" />}>
          <HouseholdTasksCard identity={identity} householdId={canonicalRouteId} scope={historyScope}
            page={historyList === "tasks" ? historyPage : 1} includeCompleted={includeCompleted} assigneeFilter={assigneeFilter} />
        </Suspense>
        <Suspense fallback={<SectionLoading label="Zendesk tickets" />}>
          <HouseholdZendeskCard identity={identity} sourceSfIds={sourceSfIds} />
        </Suspense>
      </div>

      <div className={styles.dealsRow}>
        <HouseholdDeals deals={hh.deals} summary={hh.dealSummary} />
      </div>

      {assetTransferWorkspaceEnabled() ? (
        <div style={{ marginTop: 24 }}>
          <Suspense fallback={<SectionLoading label="transfers" />}>
            <HouseholdTransfersCard identity={identity} sourceSfIds={sourceSfIds} householdId={canonicalRouteId} scope={historyScope} />
          </Suspense>
        </div>
      ) : null}

      {/* Trade Requests (S3) — the UNION of the household's members' live trade
          requests (each request once), REAL read from the Trade-Request app,
          DEFERRED behind Suspense so the app call never blocks the shell. Shown
          only when the household has ≥1 member with an cedar_ridge_user_id. */}
      <Suspense fallback={null}>
        <HouseholdTradeRequests identity={identity} sourceSfIds={sourceSfIds} />
      </Suspense>

      {/* Relationship activity — REAL, household-keyed CRM emails and call
          activity. Tasks and Zendesk tickets are elevated into the operational
          cards above; this section retains the supporting communications. */}
      <div style={{ marginTop: 24 }}>
        <SectionLabel>Household · Activity</SectionLabel>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 16,
            marginTop: 12,
          }}
        >
          <Suspense fallback={<SectionLoading label="emails" />}>
            <HouseholdEmailCard identity={identity} householdId={canonicalRouteId} scope={historyScope}
              page={historyList === "email" ? historyPage : 1} />
          </Suspense>
          <Suspense fallback={<SectionLoading label="activity" />}>
            <HouseholdActivityCard identity={identity} householdId={canonicalRouteId} scope={historyScope}
              page={historyList === "activity" ? historyPage : 1} />
          </Suspense>
        </div>
      </div>
    </>
  );
}
