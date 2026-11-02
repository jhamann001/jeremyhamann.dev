import type { ApexAccount, ExternalAccount, Identity, PortraitDetail } from "./types";
import { getClientWithHousehold } from "./clients";
import { dealsForClient, dealsForHousehold } from "./deals";
import { clientPersonAum, householdAumFromDeals } from "./deal-types";
import { apexAccountsForClient } from "./account-aum";
import { investmentAccountsForClient, investmentAumState, householdInvestmentAumState } from "./investment-accounts";
import {
  feedByClient,
  riskByClient,
  riskFlagByClient,
  instructionsByClient,
  portraitByClient,
  accountsByClient,
  prepByClient,
} from "@/lib/mock/client-portrait";
import { taxBudgetForClient } from "./tax-budget";
import {
  clientPortraitExperimentsEnabled,
  showPlaidLinkedAccountSummariesEnabled,
} from "@/lib/flags";
import { linkedExternalSummariesForClient } from "./linked-external-account-summary";
import { devTradeRequestProfileForClient } from "@/lib/mock/trade-request-profile";
import { demoMode } from "@/lib/demo/mode";
import { demoClientSample } from "@/lib/demo/samples/clients";
import { demoSampleNow } from "@/lib/demo/samples/clock";
import { logDetailTiming } from "@/lib/observability/structured-log";

// Hybrid seam (TDD §3, ADR-1/ADR-2): client identity + household context are REAL
// (mirror via withUserScope, from clients.getClientWithHousehold), and the deals
// card + tax budget are now REAL too (app-owned, RLS-scoped). Comms, feed and
// portrait remain deferred typed mock fixtures. Risk/instructions use the
// future-API-shaped Trade Request preview in canonical dev and retain the legacy
// fixture outside that environment until the live contract is approved.
// Returns null when no client is visible to the caller's RLS scope.
//
// Note: household-keyed CRM tasks/emails/activity are NOT fetched here.
// They link to the household (Task.AccountId), not the person (WhoId is
// FLS-blocked), so they render on the Household detail page instead — the
// per-client Portrait would show every member the same list.
export async function clientPortraitDetail(
  id: Identity,
  sfId: string,
): Promise<PortraitDetail | null> {
  const startedAt = performance.now();
  const client = await getClientWithHousehold(id, sfId);
  if (!client) {
    logDetailTiming("client_portrait", performance.now() - startedAt);
    return null;
  }
  const sourceClientId = client.sf_id;
  const household = client.household;
  // The public demo backs the fixture-only sections (beneficiaries, Insights, meeting prep) with sample data written
  // for its own clients (lib/demo/samples), dated from the seed's clock so it keeps the database's day; everywhere
  // else they keep the development fixtures.
  const demoSample = demoMode() ? demoClientSample(sourceClientId, await demoSampleNow()) : null;

  // These reads are independent once the RLS-visible client has resolved. Keep
  // them bounded and run them together so the portrait does not pay one full
  // database round trip after another. Each helper retains its own
  // `withUserScope` boundary; this changes latency, not authorization or data
  // scope. Household deals remain a conditional second step below because they
  // are only needed when no confirmed custodial household accounts exist.
  const plaidSummariesLive = showPlaidLinkedAccountSummariesEnabled();
  const [deals, investmentRows, householdApexState, apexRows, taxBudget, linkedSummaries] =
    await Promise.all([
      client.sf_id ? dealsForClient(id, client.sf_id) : Promise.resolve([]),
      client.sf_id
        ? investmentAccountsForClient(id, client.sf_id)
        : Promise.resolve([]),
      household
        ? householdInvestmentAumState(id, household.sf_id)
        : Promise.resolve({ value: null, availability: "ABSENT" as const }),
      client.sf_id
        ? apexAccountsForClient(id, client.sf_id)
        : Promise.resolve([]),
      taxBudgetForClient(id, sourceClientId),
      // RLS scopes this read: Admin/Operations firm-wide, Client Service every
      // client household, Advisor own book, every other role no rows.
      plaidSummariesLive && client.sf_id
        ? linkedExternalSummariesForClient(id, client.sf_id)
        : Promise.resolve([]),
    ]);
  const clientApexState = investmentAumState(investmentRows);

  // tkt-deals-client-link (AUM layer). clientAum: the client's own managed AUM
  // (person_aum repeats across their deals → first non-null). householdAum: the
  // header's household-context figure, made CONSISTENT with the Household detail
  // page by reusing the SAME gated helper — householdAumFromDeals (completeness
  // gate + max-per-client dedupe) over the household's deals, with the
  // mirror.household.aum fallback until the household is fully backfilled.
  // Confirmed Apex + Schwab balances precede estimates for BOTH headers.
  // A pending custodian suppresses the whole total and cannot fall back to a
  // plausible estimate. No account rows permits the existing deals/mirror
  // fallback; a genuine custodial $0 wins.
  const clientAum = clientApexState.availability === "PENDING"
    ? null
    : (clientApexState.value ?? clientPersonAum(deals));
  const mirrorHouseholdAum = household?.aum ?? null;
  const householdDealsAum = household
    && householdApexState.availability !== "PENDING"
    && householdApexState.value == null
    ? householdAumFromDeals(await dealsForHousehold(id, household.sf_id))
    : null;
  const householdAum = household
    ? (householdApexState.availability === "PENDING" ? null :
      (householdApexState.value ??
      householdDealsAum ??
      mirrorHouseholdAum))
    : null;

  // Preserve Apex-only form inputs independently of the mixed-custodian display.
  // ext/bene/plaidLinked remain deferred synthetic previews.
  const apex: ApexAccount[] = apexRows.map((a) => ({
    id: a.custodianAccountId,
    apexAccountNumber: a.apexAccountNumber,
    type: a.accountType ?? "Account",
    // A client account always carries an Apex number; fall back to the custodian
    // ULID for safety (ticket made apexAccountNumber nullable for firm accounts,
    // which are never returned by the client-scoped read).
    num: a.apexAccountNumber ?? a.custodianAccountId,
    status: a.accountStatus ?? "",
    value: a.accountAum,
    balanceCurrent: a.balanceCurrent,
  }));
  const fixtureAccounts = accountsByClient[sourceClientId] ?? accountsByClient.default;
  const mockAccounts = demoSample ? { ...fixtureAccounts, bene: demoSample.bene } : fixtureAccounts;
  // Live summaries replace the mock rows entirely; the two are never mixed.
  // Totals are holdings-derived and never feed clientAum/householdAum.
  const ext: ExternalAccount[] = plaidSummariesLive
    ? linkedSummaries.map((s) => ({
      inst: s.institutionName ?? "Linked account",
      type: s.accountSubtype ?? "Account",
      num: s.mask ? `••••${s.mask}` : "—",
      balance: s.holdingsTotal ?? 0,
      externalAccountId: s.externalAccountId,
      cash: s.cashAmount,
      securities: s.securitiesAmount,
      holdingsTotal: s.holdingsTotal,
      asOf: s.asOf?.toISOString() ?? null,
      institutionBalance: s.institutionBalance,
    }))
    : mockAccounts.ext;

  const detail: PortraitDetail = {
    client,
    feed: feedByClient[sourceClientId] ?? feedByClient.default,
    risk: demoSample?.risk ?? riskByClient[sourceClientId] ?? riskByClient.default,
    riskFlag: demoSample
      ? null
      : sourceClientId in riskFlagByClient
        ? riskFlagByClient[sourceClientId]
        : riskFlagByClient.default,
    instructions: instructionsByClient[sourceClientId] ?? instructionsByClient.default,
    tradeRequestProfile: clientPortraitExperimentsEnabled()
      ? devTradeRequestProfileForClient(sourceClientId)
      : null,
    portrait: demoSample?.portrait ?? portraitByClient[sourceClientId] ?? portraitByClient.default,
    deals,
    clientAum,
    householdAum,
    clientAumPending: clientApexState.availability === "PENDING",
    householdAumPending: householdApexState.availability === "PENDING",
    // P1 (ticket) — Core-Fin accounts stack (Apex + tax budget now REAL) and
    // Meeting Prep. bene remains a deferred mock fixture; ext/plaidLinked are
    // mock fixtures unless the linked-account summaries flag is on.
    // FormLibraryCard continues to receive ONLY accounts.apex. Display-only
    // Schwab ids cannot become Apex report, form or trade account selections.
    accounts: plaidSummariesLive
      ? {
        ...mockAccounts,
        apex,
        investment: investmentRows,
        ext,
        plaidLinked: ext.length > 0,
        plaidSummariesLive: true,
      }
      : { ...mockAccounts, apex, investment: investmentRows },
    taxBudget,
    prep: demoSample
      ? demoSample.prep
      : sourceClientId in prepByClient
        ? prepByClient[sourceClientId]
        : prepByClient.default,
  };
  logDetailTiming("client_portrait", performance.now() - startedAt);
  return detail;
}
