import { readTradeRequestsForUserCached } from "@/lib/data/trade-requests";
import { TradeRequestsCard } from "./TradeRequestsCard";

// Async SERVER component (no "use client") that reads a client's LIVE trade
// requests from the Trade-Request app via the S1 seam and renders
// <TradeRequestsCard>. It is rendered INSIDE a <Suspense> boundary on the Client
// Portrait, so its await NEVER blocks the portrait shell — the shell streams
// instantly and this panel streams in when the app call resolves (the PR #133
// perf lesson: don't block the page on an external call).
//
// GRACEFUL DEGRADE:
//   • rows (incl. the empty `[]` case — a client with no requests is a normal
//     200 {data:[]}, NOT an error) → the card (empty state lives in the card).
//   • TradeRequestReadError (401/403 / 5xx / transport) → a quiet inline note;
//     the data layer already logged a STATIC marker / status. The page never breaks.
//
// SECURITY / RLS: this only ever receives an cedar_ridge_user_id for a client the
// caller can already see (the RLS-scoped getCedarRidgeUserIdForLinkedReads gates
// it on the page). It never resolves scope itself, never widens beyond the id it
// is handed, and NEVER renders that id.
//
// Request-level dedup: readTradeRequestsForUserCached memoizes the app call for
// a single request (React cache()), so repeat consumers cost one call.

export async function TradeRequestsSection({
  cedarRidgeUserId,
}: {
  cedarRidgeUserId: string;
}) {
  try {
    const requests = await readTradeRequestsForUserCached(cedarRidgeUserId);
    return <TradeRequestsCard requests={requests} />;
  } catch {
    // TradeRequestReadError — the data layer already logged a static marker /
    // status; the id/url/body never surface.
    return (
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        Trade requests unavailable.
      </p>
    );
  }
}
