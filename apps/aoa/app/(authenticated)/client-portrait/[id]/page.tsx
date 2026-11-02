import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { clientPortraitDetail } from "@/lib/data/portrait";
import { getCedarRidgeUserIdForLinkedReads } from "@/lib/data/clients";
import { savedMeetingPrepsForClient } from "@/lib/data/meeting-prep";
import { zendeskTicketsForClient } from "@/lib/data/zendesk-tickets";
import {
  aiMeetingPrepEnabled,
  clientPortraitTradeProfileLiveEnabled,
  crmDocumentsPreviewEnabled,
  crmRelationshipsEnabled,
} from "@/lib/flags";
import { ClientFundingSection, NewFundingSkeleton } from "@/components/funding";
import {
  Card,
  CardHeader,
  CardBody,
  Pill,
  SectionLabel,
  TabPane,
  FieldList,
  PreviewBadge,
} from "@/components/ui";
import {
  RiskGauge,
  DealRollup,
  AccountsSection,
  TaxBudgetCard,
  PrepCard,
  CedarRidgeUserIdField,
  TradeRequestsSection,
  TradeRequestsSkeleton,
  TradeRequestProfileCards,
  LiveTradeRequestProfileCards,
  ZendeskTicketsCard,
} from "@/components/client-portrait";
import { CrmIdField, DocumentsPreview, LazyRelationshipWorkspace } from "@/components/crm";
import { crmIdentityIdForSource, crmRouteSource } from "@/lib/crm/resolve";
import { canViewCrmId } from "@/lib/crm/visibility";
import { usd } from "@/lib/format";
import { canWriteTaxBudget } from "@/lib/data/tax-budget-write";
import { plaidHoldingsPreviewAllowed } from "@/lib/auth/plaid-holdings-preview";
import { canReadCrmRelationships } from "@/lib/data/crm-relationships";
import { CanonicalClientRoute } from "@/components/client-portrait/CanonicalClientRoute";
import { ListBackLink } from "@/components/navigation/ListBackLink";
import { NavigationTabs } from "@/components/navigation/NavigationTabs";
import { FormLibraryCard } from "@/components/forms/FormLibraryCard";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const session = await auth();
  if (!session?.user) redirect("/");
  const identity = {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };

  // Identity + household are REAL, RLS-scoped through the B0 seam. A client the
  // caller cannot see (outside their book, or unknown id) yields null → 404.
  const detail = await clientPortraitDetail(identity, id);
  if (!detail) notFound();

  const [crmId, linkedReadUserId, savedBriefs, zendeskTickets] = await Promise.all([
    canViewCrmId(identity.role)
      ? crmIdentityIdForSource(
          identity,
          "CONTACT",
          crmRouteSource("CONTACT"),
          detail.client.sf_id,
        )
      : Promise.resolve(null),
    getCedarRidgeUserIdForLinkedReads(identity, detail.client.sf_id),
    aiMeetingPrepEnabled()
      ? savedMeetingPrepsForClient(identity, detail.client.sf_id)
      : Promise.resolve([]),
    // Zendesk follows the same household-primary model as CRM tasks. A
    // contact without a household still gets its own ticket history so support
    // context cannot disappear during an identity/data transition.
    detail.client.household
      ? Promise.resolve([])
      : zendeskTicketsForClient(identity, detail.client.sf_id),
  ]);

  const {
    client,
    risk,
    riskFlag,
    instructions,
    tradeRequestProfile,
    portrait,
    deals,
    clientAum,
    householdAum,
    clientAumPending,
    householdAumPending,
    accounts,
    taxBudget,
    prep,
  } = detail;
  const household = client.household;

  const portraitFields = Object.entries(portrait).map(([label, value]) => ({
    label,
    value,
  }));

  // Client-level New Funding (card 6568), aggregated across the client's Apex
  // accounts — the SAME RLS-scoped accounts the Core Financial section renders
  // (accounts.apex). We only compute the scoped account numbers here; the actual
  // fetch (N×2 Warehouse calls: resolve NUMBER → ULID via card 6472, then pull
  // trailing-12mo funding) is DEFERRED into <ClientFundingSection> behind a
  // <Suspense> boundary below, so it never blocks the portrait shell. That
  // component keeps the same try/catch graceful-degrade note. With no Apex
  // accounts we render nothing and never call Warehouse.
  const apexAccountNumbers = accounts.apex.map((a) => a.num).filter(Boolean);
  const showRelationships = crmRelationshipsEnabled()
    && canReadCrmRelationships(identity.role)
    && Boolean(crmId);
  const showDocumentsPreview = crmDocumentsPreviewEnabled();

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <ListBackLink scope={session.navigationScope ?? ""} detailHref={`/client-portrait/${id}`} canonicalHref={`/client-portrait/${detail.client.sf_id}`} fallback="/client-portrait">‹ Back to client results</ListBackLink>
      </div>
      {detail.client.sf_id.slice(0, 15) !== id.slice(0, 15) ? (
        <CanonicalClientRoute canonicalId={detail.client.sf_id} />
      ) : null}
      {/* Back to the client's household (the way out of a client the user
          picked from within a household — or from the client list). */}
      {household ? (
        <div style={{ marginBottom: 10 }}>
          <Link
            href={`/households/${household.sf_id}`}
            style={{ color: "var(--muted)", fontSize: 13, textDecoration: "none" }}
          >
            ← {household.name}
          </Link>
        </div>
      ) : null}

      {/* Header — REAL identity + household context. No PreviewBadge. */}
      <SectionLabel>Client · Portrait</SectionLabel>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <h1>{client.name}</h1>
        {client.employeeStatus ? (
          <Pill tone={client.employeeStatus === "ACTIVE" ? "green" : "gray"}>
            {client.employeeStatus === "ACTIVE" ? "Employee" : "Former employee"}
          </Pill>
        ) : null}
      </div>
      {household ? (
        <p style={{ color: "var(--muted)", marginTop: 6 }}>
          <Link
            href={`/households/${household.sf_id}`}
            style={{ color: "inherit", textDecoration: "underline" }}
          >
            {household.name}
          </Link>
          {household.status ? (
            <>
              {" · "}
              <Pill tone="green" dot>
                {household.status}
              </Pill>
            </>
          ) : null}
          {" · "}
          {/* Household AUM — consistent with the Household detail page:
              householdAumFromDeals(household deals) with the mirror fallback
              (tkt-deals-client-link). */}
          {householdAumPending ? "AUM refresh pending" : `${usd(householdAum)} AUM`}
        </p>
      ) : (
        <p style={{ color: "var(--muted)", marginTop: 6 }}>
          No household on file
        </p>
      )}

      {/* Client AUM — the individual's managed AUM (person_aum). Hidden until
          the feed backfills it (tkt-deals-client-link). */}
      {clientAumPending ? (
        <p style={{ color: "var(--muted)", marginTop: 4, fontSize: 13 }}>
          Client AUM: <strong style={{ color: "var(--ink)" }}>Balance refresh pending</strong>
        </p>
      ) : clientAum != null ? (
        <p style={{ color: "var(--muted)", marginTop: 4, fontSize: 13 }}>
          Client AUM: <strong style={{ color: "var(--ink)" }}>{usd(clientAum)}</strong>
        </p>
      ) : null}

      {crmId ? <CrmIdField value={crmId} /> : null}

      {/* CedarRidge User ID — the internal Apex/DriveWealth bridge id. The data
          seam attaches this ONLY for ADMIN/OPERATIONS (client-field-authz), so
          the field is absent (→ not rendered) for advisors/client-service/VIEWER.
          When present, it renders masked-by-default with a Show/Hide toggle. */}
      {client.cedarRidgeUserId ? (
        <CedarRidgeUserIdField value={client.cedarRidgeUserId} />
      ) : null}

      <div style={{ marginTop: 24 }}>
        <NavigationTabs
          standaloneTab={{ id: "financial", label: "Core Financial" }}
          tabs={[
            { id: "comms", label: "Communications" },
            { id: "portrait", label: "Insights" },
            ...(showRelationships
              ? [{ id: "relationships", label: "Relationships" }]
              : []),
            ...(showDocumentsPreview
              ? [{ id: "documents", label: "Documents" }]
              : []),
          ]}
        >
          {/* Communications — meeting prep (MOCK) + a pointer to the household.
              Tasks, emails and call activity are keyed to the HOUSEHOLD
              (Task.AccountId → household; per-person WhoId is FLS-blocked), so
              they live on the Household detail page — not here, where every
              member would otherwise show the same list. */}
          <TabPane tabId="comms">
            {/* Meeting Prep card (P1, ticket — mockup #n2prep) */}
            <PrepCard
              prep={prep}
              clientName={client.name}
              savedBriefs={savedBriefs}
            />

            {!household ? (
              <div style={{ marginTop: 16 }}>
                <ZendeskTicketsCard tickets={zendeskTickets} scope="client" />
              </div>
            ) : null}

            {household ? (
              <p style={{ color: "var(--muted)", marginTop: 16, fontSize: 13 }}>
                Tasks, Zendesk tickets, emails, and activity are tracked at the
                household level.{" "}
                <Link
                  href={`/households/${household.sf_id}`}
                  style={{ color: "inherit", textDecoration: "underline" }}
                >
                  View household activity →
                </Link>
              </p>
            ) : null}
          </TabPane>

          {/* Core Financial — mixed real/deferred data. Tax budget is app-owned. */}
          <TabPane tabId="financial">
            {/* Accounts stack (P1, ticket — mockup #n2accts) */}
            <AccountsSection
              accounts={accounts}
              clientName={client.name}
              clientSfId={client.sf_id}
              canPreviewHoldings={plaidHoldingsPreviewAllowed(identity.role)}
            />

            {/* Client-scoped deals, directly below Accounts (ticket). */}
            <div style={{ marginTop: 16 }}>
              <DealRollup deals={deals} />
            </div>

            <div style={{ marginTop: 16 }}>
              <FormLibraryCard clientId={client.sf_id} accounts={accounts.apex} />
            </div>

            {/* New Funding (card 6568) — client-level, aggregated across the
                client's Apex accounts. Below the accounts and form library.
                DEFERRED behind Suspense: the portrait shell renders instantly
                and this section streams in when the funding fan-out resolves. */}
            {apexAccountNumbers.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <Suspense fallback={<NewFundingSkeleton />}>
                  <ClientFundingSection accountNumbers={apexAccountNumbers} />
                </Suspense>
              </div>
            )}

            {/* Tax Budget — app-owned, manually entered per client/year. */}
            <div style={{ marginTop: 16 }}>
              <TaxBudgetCard
                taxBudget={taxBudget}
                clientSfId={client.sf_id}
                canEdit={canWriteTaxBudget(identity.role)}
              />
            </div>

            {clientPortraitTradeProfileLiveEnabled() && linkedReadUserId ? (
              <Suspense
                fallback={
                  <p style={{ color: "var(--muted)", marginTop: 16, fontSize: 13 }}>
                    Loading approved investment profile…
                  </p>
                }
              >
                <LiveTradeRequestProfileCards
                  identity={identity}
                  clientSfId={client.sf_id}
                  cedarRidgeUserId={linkedReadUserId}
                />
              </Suspense>
            ) : tradeRequestProfile ? (
              <TradeRequestProfileCards profile={tradeRequestProfile} />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                  gap: 16,
                  marginTop: 16,
                }}
              >
                <Card>
                  <CardHeader>
                    <h2>Investment instructions</h2>
                    <PreviewBadge />
                  </CardHeader>
                  <CardBody>
                    <FieldList items={instructions} />
                  </CardBody>
                </Card>
                <Card>
                  <CardHeader>
                    <h2>Risk profile</h2>
                    {/* Flagged-change pill (P1, ticket — mockup #n2riskflag) */}
                    {riskFlag ? (
                      <Pill tone="gold" dot>
                        {riskFlag}
                      </Pill>
                    ) : null}
                    <PreviewBadge />
                  </CardHeader>
                  <CardBody>
                    <RiskGauge risk={risk} />
                  </CardBody>
                </Card>
              </div>
            )}

            {/* Trade Requests (S2) — REAL live read from the Trade-Request app,
                DEFERRED behind Suspense so the app call never blocks the shell.
                Shown for any client (RLS-scoped) with an cedar_ridge_user_id. */}
            {linkedReadUserId ? (
              <div style={{ marginTop: 16 }}>
                <Suspense fallback={<TradeRequestsSkeleton />}>
                  <TradeRequestsSection cedarRidgeUserId={linkedReadUserId} />
                </Suspense>
              </div>
            ) : null}
          </TabPane>

          {/* Insights — existing qualitative Portrait content and query key. */}
          <TabPane tabId="portrait">
            <Card>
              <CardHeader>
                <h2>Client insights</h2>
                <PreviewBadge />
              </CardHeader>
              <CardBody>
                <FieldList items={portraitFields} />
              </CardBody>
            </Card>
          </TabPane>

          {showRelationships && crmId ? (
            <TabPane tabId="relationships">
              <LazyRelationshipWorkspace
                compact
                rootIdentityId={crmId}
              />
            </TabPane>
          ) : null}

          {showDocumentsPreview ? (
            <TabPane tabId="documents">
              <DocumentsPreview />
            </TabPane>
          ) : null}
        </NavigationTabs>
      </div>
    </>
  );
}
