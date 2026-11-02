/** Browser-safe presentation contract. No database, feature flags or action imports. */
import { DRS_TASKS, drsTaskSourceKey, drsWorkflowGate } from "@/lib/data/drs-workflow";
import { isHiddenLegacyDecision } from "@/lib/data/decision-task-context";
import { acatLinkedFromIds, checklistGateBlock, fundingRouteChangeGate, hardGateBlock } from "@/lib/data/transfer-gate";
import { recordedFundingMethod } from "@/lib/data/transfer-funding-method-change";
import {
  STAGE_ORDER, resolveTaskDone, stageChecklistTasks,
  type FundingType, type TransferStage,
} from "@/lib/data/transfer-types";

export type TaskTransferSummary = {
  id: string;
  /** Stable client identity, then household identity, then this transfer. Never a name. */
  clientKey: string;
  clientName: string;
  householdName: string;
  /** Recorded delivering-account registration; never Deal.account_type (funding method). */
  accountType: string | null;
  deliveringCustodian: string | null;
  deliveringAccountLast4: string | null;
  fundingType: string | null;
  /** Execution identity stays separate from a Funded reporting correction. */
  operationalFundingType?: string | null;
  drsMethodChangePending?: boolean;
  stage: string;
  createdAt: string;
  deal: { id: string; name: string } | null;
  requirements: string[];
  blockers: { id: string; question: string }[];
  /** An empty requirements array is not proof that the transfer is ready. */
  readinessNote: string;
};

export type TaskTransferSummarySource = {
  id: string;
  client_sf_id: string | null;
  household_sf_id: string | null;
  client_first_name: string;
  client_last_name: string;
  household_name: string | null;
  asset_map_account_type: string | null;
  asset_map_custodian: string | null;
  asset_map_account_number: string | null;
  transferring_firm: string | null;
  funding_type: FundingType | null;
  recorded_funding_type?: FundingType | null;
  funding_route_change_pending?: boolean;
  drs_method_change_pending?: boolean;
  stage: string;
  created_at: Date;
  archived_at: Date | null;
  deal_id: string | null;
  funding_plan_complete: boolean;
  funding_plan_version: number;
  accounts_opened_at_apex: boolean;
  funding_initiated: boolean;
  cash_in_flight: boolean;
  acat_transfer_id: string | null;
  acat_record_id: string | null;
  tasks: readonly { title: string; done: boolean; override_done: boolean | null; sort_order: number }[];
  /** Only OPEN/SNOOZED cases with blocks_transfer, loaded in the viewer's scope. */
  decision_cases: readonly { id: string; question: string; source_key: string | null }[];
};

export type TaskTransferSummaryDeal = {
  id: string;
  name: string;
  statements: boolean;
  asset_mapped: boolean;
};

export type TaskTransferSummaryDrsTask = {
  transfer_id: string | null;
  decision_id: string | null;
  source_key: string | null;
  task_key: string;
  owner_team: string;
  status: string;
};

function nonblank(value: string | null): string | null {
  return value?.trim() || null;
}

function accountLast4(value: string | null): string | null {
  const account = value?.replace(/[\s-]/g, "") ?? "";
  // Missing/placeholder and short account values do not become account identity.
  return account.length >= 4 && /\d/.test(account) ? account.slice(-4) : null;
}

/**
 * Derive known missing checks from the same pure gate contracts as the transfer.
 * This is a read-only summary, not a new authorization or advancement decision.
 * The caller supplies only rows already read under the viewer's RLS scope.
 */
export function buildTaskTransferSummary(
  transfer: TaskTransferSummarySource,
  input: {
    linkedDeal: TaskTransferSummaryDeal | null;
    checklistGateEnabled: boolean;
    legacyGateEnabled: boolean;
    drsTasks: readonly TaskTransferSummaryDrsTask[];
  },
): TaskTransferSummary {
  // Defend the exact-link contract in the pure mapper as well as the query.
  const deal = input.linkedDeal?.id === transfer.deal_id ? input.linkedDeal : null;
  const clientName = [transfer.client_first_name, transfer.client_last_name].filter(Boolean).join(" ").trim();
  const householdName = nonblank(transfer.household_name) ?? clientName ?? "Unassigned household";
  const requirements: string[] = [];
  const from = transfer.stage as TransferStage;
  const stageIndex = STAGE_ORDER.indexOf(from);
  const to = stageIndex >= 0 ? STAGE_ORDER[stageIndex + 1] : undefined;
  const blockers = transfer.decision_cases
    .filter((decision) => !isHiddenLegacyDecision(decision.source_key))
    .map(({ id, question }) => ({ id, question }));

  let readinessNote = "Known missing checks from records you can view. Open the transfer to review full readiness; completing these tasks does not advance the transfer.";
  if (transfer.archived_at !== null) {
    readinessNote = "Archived transfer. Open the transfer to review its history; it cannot advance.";
  } else if (stageIndex < 0) {
    readinessNote = "This transfer has an unsupported stage. Open the transfer for Operations review.";
  } else if (!to) {
    readinessNote = "Transfer is Funded. Open the transfer to review remaining reconciliation and client follow-up.";
  } else if (transfer.funding_type === "DRS") {
    // Same canonical identity checks as readDrsWorkflowTasks. The Tasks read
    // already contains the complete RLS-visible decision-task inventory, so no
    // per-transfer lookup or name/title-based task inference is needed.
    const tasks = DRS_TASKS.flatMap((definition) => {
      const row = input.drsTasks.find((task) => task.transfer_id === transfer.id
        && task.decision_id === null
        && task.source_key === drsTaskSourceKey(transfer.id, definition.key)
        && task.task_key === definition.taskKey && task.owner_team === definition.ownerTeam);
      return row ? [{ taskKey: definition.taskKey, status: row.status }] : [];
    });
    requirements.push(...drsWorkflowGate({
      from, to, tasks,
      fundingPlanComplete: transfer.funding_plan_complete,
      fundingPlanVersion: transfer.funding_plan_version,
      blockingExceptions: transfer.decision_cases.length,
      methodChangePending: transfer.drs_method_change_pending,
    }).unmet);
  } else {
    const routeGate = fundingRouteChangeGate({
      transferId: transfer.id, pending: transfer.funding_route_change_pending === true,
      fundingType: transfer.funding_type,
      acatLinked: acatLinkedFromIds(transfer.acat_transfer_id, transfer.acat_record_id),
      from, to, tasks: input.drsTasks,
    });
    requirements.push(...routeGate.unmet);
    const revisedPartialReady = transfer.funding_route_change_pending === true &&
      transfer.funding_type === "ACAT_PARTIAL" && !routeGate.blocked;
    if (!transfer.funding_plan_complete || !Number.isInteger(transfer.funding_plan_version)
      || transfer.funding_plan_version < 1) {
      requirements.push(from === "DECISION"
        ? "Approve the current funding plan before advancing."
        : transfer.funding_plan_version > 0 && !transfer.funding_plan_complete
          ? "Operations must review the invalidated funding plan. Return this transfer to Preparation and approve the current plan before advancing."
          : "Operations must review and approve the current funding plan before marking this transfer Funded.");
    }
    if (transfer.decision_cases.length > blockers.length) {
      requirements.push("Review the transfer's additional blocking decisions on the transfer.");
    }
    if (input.checklistGateEnabled) {
      const tasks = stageChecklistTasks(from, [...transfer.tasks].sort((a, b) => a.sort_order - b.sort_order), transfer.funding_type)
        .map((task) => ({ title: task.title, done: resolveTaskDone(task, deal) }));
      requirements.push(...checklistGateBlock(from, to, tasks).unmet);
    } else if (input.legacyGateEnabled) {
      requirements.push(...hardGateBlock({
        ...transfer,
        funding_initiated: revisedPartialReady || transfer.funding_initiated,
        acat_linked: acatLinkedFromIds(transfer.acat_transfer_id, transfer.acat_record_id),
      }, from, to).unmet);
    }
  }

  return {
    id: transfer.id,
    clientKey: nonblank(transfer.client_sf_id) ? `client:${transfer.client_sf_id}`
      : nonblank(transfer.household_sf_id) ? `household:${transfer.household_sf_id}` : `transfer:${transfer.id}`,
    clientName: clientName || nonblank(transfer.household_name) || "Unassigned client",
    householdName: householdName || "Unassigned household",
    accountType: nonblank(transfer.asset_map_account_type),
    deliveringCustodian: nonblank(transfer.asset_map_custodian) ?? nonblank(transfer.transferring_firm),
    deliveringAccountLast4: accountLast4(transfer.asset_map_account_number),
    fundingType: recordedFundingMethod(transfer),
    operationalFundingType: transfer.funding_type,
    drsMethodChangePending: transfer.drs_method_change_pending === true,
    stage: transfer.stage,
    createdAt: transfer.created_at.toISOString(),
    deal: deal ? { id: deal.id, name: deal.name } : null,
    requirements: [...new Set(requirements)],
    blockers,
    readinessNote,
  };
}
