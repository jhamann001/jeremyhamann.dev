import type { TradeRequestSummary } from "@/lib/data/trade-requests";

// Pure helper (no "server-only" import — node-testable) for the household
// trade-requests union (S3).

/**
 * Collapse a union of trade requests to ONE row per request `id`, preserving
 * first-seen order. A household-rebalance request spans multiple members
 * (`clientIds` len > 1) but must appear ONCE at the household level.
 *
 * The S1 batch read (`getTradeRequestsForUsers`) makes a single batched call, so
 * the endpoint already returns each request once for the union; this makes
 * "appears once" a LOCAL guarantee, independent of the remote contract
 * (defense-in-depth — and correct even if a caller ever fans out per-member).
 */
export function dedupeRequestsById(
  requests: TradeRequestSummary[],
): TradeRequestSummary[] {
  const seen = new Set<string>();
  const out: TradeRequestSummary[] = [];
  for (const r of requests) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
