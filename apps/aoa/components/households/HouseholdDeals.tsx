import type { HouseholdDeal, HouseholdDealSummary } from "@/lib/data/types";
import { DealSummaryCard } from "@/components/deals/DealSummaryCard";

// The Household keeps its RLS-scoped getHousehold read, summary, row order,
// and client-name labels. Only the card presentation is shared with Portrait.
export function HouseholdDeals({
  deals,
  summary,
}: {
  deals: HouseholdDeal[];
  summary: HouseholdDealSummary;
}) {
  return (
    <DealSummaryCard
      deals={deals}
      summary={summary}
      labelMode="client"
      emptyMessage="No deals linked to this household."
    />
  );
}
