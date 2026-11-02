import { describe, it, expect } from "vitest";
import { dedupeRequestsById } from "@/components/households/household-trade-requests-helpers";
import type { TradeRequestSummary } from "@/lib/data/trade-requests";

// Minimal valid TradeRequestSummary — only `id` (and clientIds, for realism)
// matter for dedupe; the rest are typed placeholders.
function req(id: string, clientIds: string[] = []): TradeRequestSummary {
  return {
    id,
    clientId: clientIds[0] ?? null,
    clientIds,
    status: "Approved",
    tradeType: "Buy",
    priority: "Normal",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    totalValue: 1000,
    advisor: "Rachel Moss",
    householdId: 1,
    householdName: "Moss Family",
    selectedAccounts: [],
    accounts: [],
    liquidateOption: null,
    liquidationApproval: null,
  };
}

describe("dedupeRequestsById", () => {
  it("collapses a household-rebalance request that matched two members to ONE row, keeping the first", () => {
    // Same request id returned once per member match — must appear once.
    const rows = [
      req("tr-rebalance", ["user-a", "user-b"]),
      req("tr-a-only", ["user-a"]),
      req("tr-rebalance", ["user-a", "user-b"]), // duplicate id
    ];
    const out = dedupeRequestsById(rows);
    expect(out.map((r) => r.id)).toEqual(["tr-rebalance", "tr-a-only"]);
  });

  it("keeps distinct ids and preserves first-seen order", () => {
    const rows = [req("tr-3"), req("tr-1"), req("tr-2")];
    const out = dedupeRequestsById(rows);
    expect(out.map((r) => r.id)).toEqual(["tr-3", "tr-1", "tr-2"]);
  });

  it("empty input → []", () => {
    expect(dedupeRequestsById([])).toEqual([]);
  });

  it("no duplicates → unchanged length and order", () => {
    const rows = [req("a"), req("b"), req("c")];
    const out = dedupeRequestsById(rows);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the FIRST occurrence's object identity (not a later duplicate)", () => {
    const first = req("dup", ["user-a"]);
    const second = req("dup", ["user-b"]);
    const out = dedupeRequestsById([first, second]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(first);
  });
});
