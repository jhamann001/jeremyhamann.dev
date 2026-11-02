import { cache } from "react";
import { fetchClientFunding, todayIso } from "@/lib/data/account-funding";
import { NewFundingCard } from "./NewFundingCard";

// Async SERVER component (no "use client") that fetches the client-level New
// Funding summary and renders the card. It is rendered INSIDE a <Suspense>
// boundary on the portrait's Core Financial tab, so its await no longer blocks
// the portrait shell — the shell streams immediately and this section streams
// in when card 6568 resolves. Behavior is otherwise identical to the old inline
// block in page.tsx: same fetch, same try/catch, same graceful-degrade note.
//
// SECURITY / RLS: this only ever receives the already-scoped `accountNumbers`
// the page derives from accounts.apex (the RLS-scoped accounts for this client).
// It never widens beyond them and never resolves scope itself.

// Request-level dedup only: cache() memoizes the fetch for the lifetime of a
// SINGLE request so multiple renders in one request can't double-fetch the
// (N×2 Warehouse call) fan-out. This is deliberately NOT cross-request /
// time-based caching (no unstable_cache) — New Funding is live financial data
// and we don't want staleness. Durable repeat-visit speedup is a separate
// future optimization (a single client-level Warehouse card).
const getClientFunding = cache((accountNumbers: string[], asOf: string) =>
  fetchClientFunding(accountNumbers, asOf),
);

export async function ClientFundingSection({
  accountNumbers,
}: {
  accountNumbers: string[];
}) {
  try {
    const summary = await getClientFunding(accountNumbers, todayIso());
    return <NewFundingCard summary={summary} />;
  } catch {
    // The data layer already logged a static marker / status; keep this quiet.
    return (
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        New funding data unavailable.
      </p>
    );
  }
}
