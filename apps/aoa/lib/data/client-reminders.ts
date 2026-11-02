import type { ClientDetail, HouseholdRow, Identity } from "./types";
import type { Decision, Nudge } from "./workflow-types";
import { getClientWithHousehold } from "./clients";
import { dealsForHousehold } from "./deals";
import { householdAumFromDeals } from "./deal-types";
import { householdApexAumTotal } from "./account-aum";
import { getWorkflowSeed } from "./workflow";
import { demoMode } from "@/lib/demo/mode";
import { demoSampleNow } from "@/lib/demo/samples/clock";

// Client-scoped Reminders projection (Phase F / F2, TDD ADR-3/4/5).
//
// Composes the REAL, RLS-scoped client read (the same seam the shipped Portrait
// uses) with the Phase C workflow seam — read directly, NOT through
// WorkflowProvider (ADR-4: the hub is a read-only projection; editing stays on
// the firm-wide Workflow screens). No new engine, no new mock data: this only
// FILTERS what Phase C already serves. When Phase D swaps getWorkflowSeed() to
// real app.decision/app.nudge reads, this function body is unchanged.

export type ClientReminders = {
  client: ClientDetail;
  household: HouseholdRow | null;
  // tkt-deals-client-link (AUM layer): the household's recomputed managed AUM
  // — householdAumFromDeals (completeness gate) over the household's deals with
  // the mirror.household.aum fallback — so this sub-page's header AUM matches
  // the Portrait tab and the Household detail page. Null when no household.
  householdAum: number | null;
  decisions: Decision[];
  nudges: Nudge[];
};

export async function clientReminders(
  id: Identity,
  sfId: string,
): Promise<ClientReminders | null> {
  // REAL read, RLS-scoped via withUserScope. An out-of-book or unknown client
  // yields null → the caller notFound()s, byte-identical to the Portrait tab.
  const client = await getClientWithHousehold(id, sfId);
  if (!client) return null;

  // The demo's samples are dated from the day its database was seeded (lib/demo/samples/clock.ts).
  const seed = getWorkflowSeed(demoMode() ? await demoSampleNow() : undefined);

  // ClientDetail.household is a nested HouseholdRow | null — NOT a flat
  // householdId. Guard it: a client with no household on file gets [] rather
  // than accidentally matching everything.
  const householdId = client.household?.sf_id;

  // Recompute the household AUM the same way the Portrait/Household pages do:
  // Apex-first (tkt), then the gated deals-derived total, then the mirror
  // fallback — consistent across all three surfaces.
  const householdAum = client.household
    ? ((await householdApexAumTotal(id, client.household.sf_id)) ??
      householdAumFromDeals(await dealsForHousehold(id, client.household.sf_id)) ??
      (client.household.aum ?? null))
    : null;

  return {
    client,
    household: client.household,
    householdAum,
    // Decisions are per-household (the Phase C model); scope by this client's.
    decisions: householdId
      ? seed.decisions.filter((d) => d.householdId === householdId)
      : [],
    // Nudges are per-client. Nudge.clientId is optional — seed nudges without
    // a clientId are INTENTIONALLY excluded from the client-scoped view.
    nudges: seed.nudges.filter((n) => n.clientId === client.sf_id),
  };
}
