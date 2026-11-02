import { getTradeRequestsForUsers } from "@/lib/data/trade-requests";
import { TradeRequestsCard } from "@/components/client-portrait/TradeRequestsCard";
import { dedupeRequestsById } from "./household-trade-requests-helpers";

// Async SERVER component (no "use client") that reads the UNION of a household's
// members' LIVE trade requests via the S1 batch seam and renders the (shared,
// surface-agnostic) <TradeRequestsCard>. Rendered INSIDE a <Suspense> boundary
// on the Household detail page, so its await NEVER blocks the household shell —
// the shell streams instantly and this panel streams in when the app call
// resolves (the PR #133 perf lesson).
//
// ONE batched call (getTradeRequestsForUsers), not one per member — so a
// household-rebalance request spanning multiple members comes back once; the
// endpoint dedupes the union. dedupeRequestsById re-asserts that as a LOCAL
// guarantee (defense-in-depth).
//
// GRACEFUL DEGRADE:
//   • rows (incl. the empty `[]` case — a household with no requests is a normal
//     200 {data:[]}, NOT an error) → the card (empty state lives in the card).
//   • TradeRequestReadError (401/403 / 5xx / transport) → a quiet inline note;
//     the data layer already logged a STATIC marker / status. The page never breaks.
//
// SECURITY / RLS: this only ever receives cedar_ridge_user_ids for a household the
// caller can already see (the RLS-scoped getCedarRidgeUserIdsForHousehold gates it
// on the page). It never resolves scope itself, never widens beyond the ids it
// is handed, and NEVER renders those ids.

export async function HouseholdTradeRequestsSection({
  cedarRidgeUserIds,
}: {
  cedarRidgeUserIds: string[];
}) {
  try {
    const requests = await getTradeRequestsForUsers(cedarRidgeUserIds);
    return <TradeRequestsCard requests={dedupeRequestsById(requests)} />;
  } catch {
    // TradeRequestReadError — the data layer already logged a static marker /
    // status; the ids/url/body never surface.
    return (
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        Trade requests unavailable.
      </p>
    );
  }
}
