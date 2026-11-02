import "server-only";
import { withUserScope } from "@/lib/rls";
import type { Identity, FunnelStage } from "./types";
import type { DealStage, StageHistoryEntry } from "./deal-types";
import { dealFunnelStages, type FunnelDealRow } from "./deal-funnel-view";

// Live read behind COMMAND_CENTER_FUNNEL_LIVE for the Command Center's
// "Transfer pipeline" card. Thin by design: the SQL narrows the row set, the
// pure bucketer (lib/data/deal-funnel-view.ts) owns every UI rule.
//
// RLS: read through `withUserScope` like every other reader — no role branching
// here. Deals are readable firm-wide by all app roles (deal_read_all_roles),
// which is what makes a firm-wide funnel on the firm's overview page correct.

type Row = {
  stage: DealStage;
  created_date: Date | null;
  last_activity_date: Date | null;
  stage_history: StageHistoryEntry[] | null;
  archived_at: Date | null;
};

/**
 * The funnel segments for the whole firm's active deal pipeline.
 *
 * The WHERE clause repeats the two exclusions the bucketer also applies
 * (archived, LOST) so the DB never ships rows the UI would only throw away; the
 * pure function keeps them because they are UI rules and that is where they are
 * tested. No `numeric` column is selected, so the Decimal-serialization trap
 * that bites lib/data/deals.ts does not apply here.
 */
export async function dealFunnel(
  identity: Identity,
  now: Date = new Date(),
): Promise<FunnelStage[]> {
  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<Row[]>`
      SELECT stage, created_date, last_activity_date, stage_history, archived_at
      FROM app.deal
      WHERE archived_at IS NULL
        AND stage <> 'LOST'`,
  );
  return dealFunnelStages(rows as FunnelDealRow[], now);
}
