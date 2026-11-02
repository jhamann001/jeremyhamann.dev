import type { DealRow } from "@/lib/data/deal-types";
import { DealSummaryCard } from "@/components/deals/DealSummaryCard";
import { clientDealRollup } from "./portrait-helpers";

// The Portrait keeps its direct client_sf_id-scoped read and deal-name labels.
// Share only presentation with Household; never broaden this to household deals.
export function DealRollup({ deals }: { deals: DealRow[] }) {
  return (
    <DealSummaryCard
      deals={deals}
      summary={clientDealRollup(deals)}
      labelMode="deal"
      emptyMessage="No deals on file."
    />
  );
}
