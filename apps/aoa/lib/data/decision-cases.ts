import { withUserScope, type Identity } from "@/lib/rls";
import type { DecisionOwnerTeamValue } from "@/lib/data/decision-case-shared";
import { drsTaskSourceKey, getDrsTaskDefinition, isDrsTask, type DrsTaskKey } from "@/lib/data/drs-workflow";
import { buildDecisionTaskContext, isStandardPartialAcatTask, type DecisionTaskContext } from "@/lib/data/decision-task-context";
import { buildTaskTransferSummary, type TaskTransferSummary } from "@/lib/data/task-transfer-summary";
import { checklistStageGateEnabled, transferDealSourcedRedesignEnabled } from "@/lib/flags";

export {
  DECISION_OWNER_LABEL,
  DECISION_OWNER_TEAMS,
  type DecisionOwnerTeamValue,
} from "@/lib/data/decision-case-shared";
export type DecisionCaseStatusValue = "OPEN" | "SNOOZED" | "RESOLVED";
export type DecisionTaskStatusValue = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
export type DecisionTaskPriorityValue = "LOW" | "NORMAL" | "HIGH";

export type DecisionPositionSnapshot = {
  symbol: string;
  description: string | null;
  marketValue: number | null;
  costBasis: number | null;
  ineligible: boolean | null;
  isTransferring: boolean;
};

export type DecisionCaseSourceSnapshot = {
  fundingPlanVersion: number | null;
  included: string[];
  excluded: string[];
  includedCount: number;
  excludedCount: number;
  positions: DecisionPositionSnapshot[];
};

export type DecisionTaskRow = {
  id: string;
  source: "DECISION" | "ASSET_TRANSFER";
  decisionId: string | null;
  transferId: string | null;
  parentTaskId: string | null;
  title: string;
  ownerTeam: DecisionOwnerTeamValue;
  status: DecisionTaskStatusValue;
  priority: DecisionTaskPriorityValue;
  householdName: string;
  category: string;
  createdBy: string | null;
  createdAt: string;
  fundingMethod?: { updatedAt: string; fundingPlanVersion: number; fundingMethodRevision: number };
  taskKey?: string;
  sortOrder?: number;
  /** Exact transfer identity and visible readiness context; null for an unreadable link. */
  transferSummary?: TaskTransferSummary | null;
  drs?: {
    key: DrsTaskKey;
    updatedAt: string;
    fundingPlanVersion: number;
    stage: string;
    fundingPlanComplete: boolean;
    methodChangePending?: boolean;
    archived: boolean;
  };
  /**
   * ticket read-time context: linked transfer/decision presence as the
   * viewer's RLS scope sees them, the approved resolution, and whether the
   * system has taken the task out of active work. Only listDecisionTasks
   * fills it; absent means "no verified link", so the UI shows no link.
   */
  context?: DecisionTaskContext;
};

export type DecisionCaseRow = {
  id: string;
  source: "MANUAL" | "ASSET_TRANSFER";
  sourceLabel: string | null;
  sourceVersion: number;
  sourceSnapshot: DecisionCaseSourceSnapshot;
  transferId: string | null;
  clientName: string | null;
  householdName: string | null;
  category: string;
  question: string;
  context: string;
  ownerTeam: DecisionOwnerTeamValue;
  status: DecisionCaseStatusValue;
  blocksTransfer: boolean;
  version: number;
  resolutionCode: string | null;
  resolutionSummary: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
  tasks: DecisionTaskRow[];
  events: {
    id: string;
    action: string;
    actorEmail: string | null;
    fromStatus: DecisionCaseStatusValue | null;
    toStatus: DecisionCaseStatusValue | null;
    at: string;
  }[];
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function mapDecisionCaseSourceSnapshot(value: unknown): DecisionCaseSourceSnapshot {
  const source = value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const included = stringList(source.included);
  const excluded = stringList(source.excluded);
  const rawPositions = Array.isArray(source.positions) ? source.positions : [];
  const positions = rawPositions.flatMap((entry): DecisionPositionSnapshot[] => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.symbol !== "string" || row.symbol.length === 0) return [];
    return [{
      symbol: row.symbol,
      description: typeof row.description === "string" ? row.description : null,
      marketValue: finiteNumber(row.marketValue),
      costBasis: finiteNumber(row.costBasis),
      ineligible: typeof row.ineligible === "boolean" ? row.ineligible : null,
      isTransferring: typeof row.isTransferring === "boolean"
        ? row.isTransferring
        : !excluded.includes(row.symbol),
    }];
  });
  const knownSymbols = new Set(positions.map((position) => position.symbol));
  for (const symbol of [...included, ...excluded]) {
    if (knownSymbols.has(symbol)) continue;
    positions.push({
      symbol,
      description: null,
      marketValue: null,
      costBasis: null,
      ineligible: null,
      isTransferring: included.includes(symbol),
    });
    knownSymbols.add(symbol);
  }
  return {
    fundingPlanVersion: finiteNumber(source.fundingPlanVersion),
    included,
    excluded,
    includedCount: finiteNumber(source.includedCount) ?? included.length,
    excludedCount: finiteNumber(source.excludedCount) ?? excluded.length,
    positions,
  };
}

function mapCase(row: {
  id: string;
  source: string;
  source_label: string | null;
  source_version: number;
  source_snapshot: unknown;
  transfer_id: string | null;
  client_name: string | null;
  household_name: string | null;
  category: string;
  question: string;
  context: string;
  owner_team: string;
  status: string;
  blocks_transfer: boolean;
  version: number;
  resolution_code: string | null;
  resolution_summary: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  tasks: Array<{
    id: string;
    decision_id: string | null;
    transfer_id: string | null;
    parent_task_id: string | null;
    title: string;
    owner_team: string;
    status: string;
    priority: string;
    created_by: string | null;
    created_at: Date;
  }>;
  events: Array<{
    id: bigint;
    action: string;
    actor_email: string | null;
    from_status: string | null;
    to_status: string | null;
    at: Date;
  }>;
}): DecisionCaseRow {
  const householdName = row.household_name ?? row.client_name ?? "Unassigned household";
  return {
    id: row.id,
    source: row.source as DecisionCaseRow["source"],
    sourceLabel: row.source_label,
    sourceVersion: row.source_version,
    sourceSnapshot: mapDecisionCaseSourceSnapshot(row.source_snapshot),
    transferId: row.transfer_id,
    clientName: row.client_name,
    householdName: row.household_name,
    category: row.category,
    question: row.question,
    context: row.context,
    ownerTeam: row.owner_team as DecisionOwnerTeamValue,
    status: row.status as DecisionCaseStatusValue,
    blocksTransfer: row.blocks_transfer,
    version: row.version,
    resolutionCode: row.resolution_code,
    resolutionSummary: row.resolution_summary,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    tasks: row.tasks.map((task) => ({
      id: task.id,
      source: "DECISION",
      decisionId: task.decision_id,
      transferId: task.transfer_id,
      parentTaskId: task.parent_task_id,
      title: task.title,
      ownerTeam: task.owner_team as DecisionOwnerTeamValue,
      status: task.status as DecisionTaskStatusValue,
      priority: task.priority as DecisionTaskPriorityValue,
      householdName,
      category: row.category,
      createdBy: task.created_by,
      createdAt: task.created_at.toISOString(),
    })),
    events: row.events.map((event) => ({
      id: event.id.toString(),
      action: event.action,
      actorEmail: event.actor_email,
      fromStatus: event.from_status as DecisionCaseStatusValue | null,
      toStatus: event.to_status as DecisionCaseStatusValue | null,
      at: event.at.toISOString(),
    })),
  };
}

const includeCaseChildren = {
  tasks: { orderBy: [{ sort_order: "asc" as const }, { created_at: "asc" as const }] },
  events: { orderBy: { at: "desc" as const }, take: 8 },
};

export async function listDecisionCases(identity: Identity): Promise<DecisionCaseRow[]> {
  return withUserScope(identity, async (tx) => {
    const rows = await tx.decisionCase.findMany({
      where: { NOT: { source_key: { endsWith: ":excluded-positions" } } },
      include: includeCaseChildren,
      orderBy: [{ status: "asc" }, { created_at: "desc" }],
    });
    return rows.map(mapCase);
  });
}

export async function listDecisionCasesForTransfer(
  identity: Identity,
  transferId: string,
): Promise<DecisionCaseRow[]> {
  return withUserScope(identity, async (tx) => {
    const rows = await tx.decisionCase.findMany({
      where: {
        transfer_id: transferId,
        NOT: { source_key: { endsWith: ":excluded-positions" } },
      },
      include: includeCaseChildren,
      orderBy: [{ status: "asc" }, { created_at: "desc" }],
    });
    return rows.map(mapCase);
  });
}

export async function listDecisionTasks(identity: Identity): Promise<DecisionTaskRow[]> {
  return withUserScope(identity, async (tx) => {
    const rows = await tx.decisionTask.findMany({
      include: {
        decision: {
          select: {
            household_name: true,
            client_name: true,
            category: true,
            source_key: true,
            status: true,
            resolution_code: true,
            resolution_summary: true,
          },
        },
        transfer: {
          select: {
            id: true,
            client_sf_id: true,
            household_sf_id: true,
            household_name: true,
            client_first_name: true,
            client_last_name: true,
            asset_map_account_type: true,
            asset_map_custodian: true,
            asset_map_account_number: true,
            transferring_firm: true,
            deal_id: true,
            created_at: true,
            funding_type: true,
            funding_plan_complete: true,
            funding_plan_version: true,
            drs_method_change_pending: true,
            funding_method_revision: true,
            funding_route_change_pending: true,
            recorded_funding_type: true,
            accounts_opened_at_apex: true,
            funding_initiated: true,
            cash_in_flight: true,
            acat_transfer_id: true,
            acat_record_id: true,
            stage: true,
            archived_at: true,
            tasks: {
              select: { title: true, done: true, override_done: true, sort_order: true },
              orderBy: { sort_order: "asc" },
            },
            decision_cases: {
              where: { status: { in: ["OPEN", "SNOOZED"] }, blocks_transfer: true },
              select: { id: true, question: true, source_key: true },
              orderBy: [{ created_at: "asc" }, { id: "asc" }],
            },
          },
        },
      },
      orderBy: [{ status: "asc" }, { priority: "desc" }, { created_at: "desc" }],
    });
    // Transfer.deal_id is the only deal relationship used here. Batch the exact
    // IDs inside the same RLS transaction; household/name matches must never
    // substitute another deal when this link is missing or hidden.
    const dealIds = [...new Set(rows.flatMap((task) => task.transfer?.deal_id ? [task.transfer.deal_id] : []))];
    const deals = dealIds.length ? await tx.deal.findMany({
      where: { id: { in: dealIds } },
      select: { id: true, name: true, statements: true, asset_mapped: true },
    }) : [];
    const dealsById = new Map(deals.map((deal) => [deal.id, deal]));
    const summaries = new Map<string, TaskTransferSummary>();
    const checklistGateEnabled = checklistStageGateEnabled();
    const legacyGateEnabled = transferDealSourcedRedesignEnabled();
    for (const task of rows) {
      const transfer = task.transfer;
      if (!transfer?.id || summaries.has(transfer.id)) continue;
      summaries.set(transfer.id, buildTaskTransferSummary(transfer, {
        linkedDeal: transfer.deal_id ? dealsById.get(transfer.deal_id) ?? null : null,
        checklistGateEnabled,
        legacyGateEnabled,
        drsTasks: rows,
      }));
    }
    return rows.flatMap((task): DecisionTaskRow[] => {
      const definition = getDrsTaskDefinition(task.task_key);
      const drs = isDrsTask(task);
      // Route changes retain task history, but it is no longer active work.
      // Malformed DRS identities cannot expose the generic, unguarded controls.
      if (drs && (task.transfer?.funding_type !== "DRS" || !definition || !task.transfer_id
        || task.decision_id !== null || task.owner_team !== definition.ownerTeam
        || task.source_key !== drsTaskSourceKey(task.transfer_id, definition.key))) return [];
      // Linked records resolve under the SAME RLS scope the target pages use,
      // so a link is offered only when this viewer can actually open it.
      const context = buildDecisionTaskContext({
        decisionId: task.decision_id,
        transferId: task.transfer_id,
        sourceKey: task.source_key,
        taskKey: task.task_key,
        status: task.status,
        transfer: task.transfer,
        decision: task.decision,
      });
      return [{
      id: task.id,
      source: task.decision_id == null ? "ASSET_TRANSFER" : "DECISION",
      decisionId: task.decision_id,
      transferId: task.transfer_id,
      parentTaskId: task.parent_task_id,
      title: task.title,
      ownerTeam: task.owner_team as DecisionOwnerTeamValue,
      status: task.status as DecisionTaskStatusValue,
      priority: task.priority as DecisionTaskPriorityValue,
      householdName:
        task.decision?.household_name ??
        task.decision?.client_name ??
        task.transfer?.household_name ??
        ([task.transfer?.client_first_name, task.transfer?.client_last_name]
          .filter(Boolean)
          .join(" ") || "Unassigned household"),
      category: task.decision?.category ?? "Asset transfer",
      createdBy: task.created_by,
      createdAt: task.created_at.toISOString(),
      taskKey: task.task_key,
      sortOrder: task.sort_order,
      transferSummary: task.transfer?.id ? summaries.get(task.transfer.id) ?? null : null,
      ...(drs && definition && task.transfer ? { drs: {
        key: definition.key,
        updatedAt: task.updated_at.toISOString(),
        fundingPlanVersion: task.transfer.funding_plan_version,
        stage: task.transfer.stage,
        fundingPlanComplete: task.transfer.funding_plan_complete,
        methodChangePending: task.transfer.drs_method_change_pending,
        archived: task.transfer.archived_at !== null,
      } } : {}),
      ...(task.transfer && task.transfer.funding_method_revision > 0 && isStandardPartialAcatTask({
        decisionId: task.decision_id, transferId: task.transfer_id, sourceKey: task.source_key,
      }) ? { fundingMethod: { updatedAt: task.updated_at.toISOString(),
        fundingPlanVersion: task.transfer.funding_plan_version,
        fundingMethodRevision: task.transfer.funding_method_revision } } : {}),
      context,
    }];
    });
  });
}
