import { withUserScope, type Identity } from "@/lib/rls";
import type {
  FundingType,
  TransferAccountRow,
  TransferAccountStatus,
  TransferDecisionChoice,
  TransferDecisionRow,
  TransferOwner,
  TransferRow,
  TransferSource,
  TransferStage,
  TransferTaskRow,
} from "./transfer-types";
import { resolveCrmRouteKey } from "@/lib/crm/resolve";

// T3 detail read seam (WO ticket; TDD ticket §4).
//
// DECLARED SEAM DECISION (blueprint T3-ticket.plan.md §0): the TDD freezes
// `getTransfer(identity, id): TransferDetail | null` in lib/data/transfers.ts,
// which is T2's file (built in parallel — T3 must not create or modify it).
// To keep ZERO file overlap, T3 implements the same frozen signature HERE and
// the detail route imports from this module. Post-merge follow-up: consolidate
// the two seam files — identical signatures make that an import swap.
//
// Posture (the deals seam idiom): one withUserScope transaction (the DB
// policies decide visibility — no role branching in code); every Postgres
// `numeric` is Number()-coerced before the row leaves the seam (the Decimal
// serialization trap documented in transfer-types.ts).

export type TransferDetail = {
  transfer: TransferRow;
  tasks: TransferTaskRow[];
  decisions: TransferDecisionRow[];
  accounts: TransferAccountRow[];
};

/** Full record + children for the detail route. Null on unknown/invisible id. */
export async function getTransfer(
  identity: Identity,
  id: string,
): Promise<TransferDetail | null> {
  const resolvedId = await resolveCrmRouteKey(identity, "TRANSFER", id);
  return withUserScope(identity, async (tx) => {
    const row = await tx.transfer.findUnique({
      where: { id: resolvedId },
      include: {
        tasks: { orderBy: { sort_order: "asc" } },
        decisions: { orderBy: { id: "asc" } },
        accounts: { orderBy: { id: "asc" } },
      },
    });
    if (!row) return null;

    const transfer: TransferRow = {
      id: row.id,
      source: row.source as TransferSource,
      client_first_name: row.client_first_name,
      client_last_name: row.client_last_name,
      client_sf_id: row.client_sf_id,
      household_name: row.household_name,
      household_sf_id: row.household_sf_id,
      value: Number(row.value),
      stage: row.stage as TransferStage,
      stage_entered_at: row.stage_entered_at,
      owner_kind: row.owner_kind as TransferOwner,
      owner_name: row.owner_name,
      next_step: row.next_step,
      next_step_owner: row.next_step_owner,
      pending_nudge: row.pending_nudge,
      acat_transfer_id: row.acat_transfer_id,
      // ticket Slice 2 — bool/text/enum columns (no Decimal-coercion trap).
      funding_type: row.funding_type as FundingType | null,
      recorded_funding_type: row.recorded_funding_type as FundingType | null,
      funding_method_revision: row.funding_method_revision,
      drs_method_change_pending: row.drs_method_change_pending,
      funding_route_change_pending: row.funding_route_change_pending,
      accounts_opened_at_apex: row.accounts_opened_at_apex,
      funding_plan_complete: row.funding_plan_complete,
      funding_plan_version: row.funding_plan_version,
      funding_plan_approved_at: row.funding_plan_approved_at,
      funding_plan_approved_by: row.funding_plan_approved_by,
      funding_initiated: row.funding_initiated,
      cash_in_flight: row.cash_in_flight,
      deal_id: row.deal_id,
      deal_sf_id: row.deal_sf_id,
      transferring_firm: row.transferring_firm,
      archived_at: row.archived_at,
      archived_by: row.archived_by,
      archived_reason: row.archived_reason,
      sync_flag: row.sync_flag,
      acat_record_id: row.acat_record_id,
      asset_map_folder_id: row.asset_map_folder_id,
      asset_map_custodian: row.asset_map_custodian,
      asset_map_account_number: row.asset_map_account_number,
      asset_map_account_type: row.asset_map_account_type,
      client_requested_on: row.client_requested_on,
      client_request_source: row.client_request_source,
      source_account_type: row.source_account_type,
      source_account_last4: row.source_account_last4,
      source_account_title: row.source_account_title,
      receiving_account_type: row.receiving_account_type,
      receiving_account_title: row.receiving_account_title,
      delivering_custodian_id: row.delivering_custodian_id,
      created_by: row.created_by,
      updated_by: row.updated_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    const tasks: TransferTaskRow[] = row.tasks.map((t) => ({
      id: t.id,
      transfer_id: t.transfer_id,
      title: t.title,
      sort_order: t.sort_order,
      done: t.done,
      override_done: t.override_done, // S2: deal-mirror override (null = follow deal)
      completed_at: t.completed_at,
      completed_by: t.completed_by,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    const decisions: TransferDecisionRow[] = row.decisions.map((d) => ({
      id: d.id,
      transfer_id: d.transfer_id,
      symbol: d.symbol,
      description: d.description,
      value: Number(d.value),
      cost_basis: d.cost_basis == null ? null : Number(d.cost_basis),
      decision: d.decision as TransferDecisionChoice,
      decided_by: d.decided_by,
      decided_at: d.decided_at,
      created_at: d.created_at,
      updated_at: d.updated_at,
    }));

    const accounts: TransferAccountRow[] = row.accounts.map((a) => ({
      id: a.id,
      transfer_id: a.transfer_id,
      label: a.label,
      status: a.status as TransferAccountStatus,
      opened_at: a.opened_at,
      created_at: a.created_at,
      updated_at: a.updated_at,
    }));

    return { transfer, tasks, decisions, accounts };
  });
}
