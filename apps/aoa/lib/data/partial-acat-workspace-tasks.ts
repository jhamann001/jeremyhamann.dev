import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { PARTIAL_ACAT_EXECUTION_TASKS } from "@/lib/data/partial-acat-tasks";
import type { FundingType } from "@/lib/data/transfer-types";
import {
  partialAcatWorkspaceTask,
  type PartialAcatTaskRow,
} from "@/lib/transfers/partial-acat-queue";
import type { WorkspaceTask } from "@/lib/transfers/workspace-queue";
import type { DecisionTaskPriorityValue, DecisionTaskStatusValue } from "@/lib/data/decision-cases";

const TASK_KEYS = PARTIAL_ACAT_EXECUTION_TASKS.map(task => task.key);

type StoredPartialAcatTask = {
  id: string;
  transfer_id: string | null;
  title: string;
  sort_order: number;
  status: DecisionTaskStatusValue;
  owner_team: string;
  task_key: string;
  source_key: string | null;
  priority: DecisionTaskPriorityValue;
  completed_at: Date | null;
  completed_by: string | null;
  updated_at: Date;
};

function toPartialAcatTask(row: StoredPartialAcatTask): PartialAcatTaskRow | null {
  if (!row.transfer_id) return null;
  return {
    id: row.id, transferId: row.transfer_id, title: row.title, sortOrder: row.sort_order, status: row.status,
    ownerTeam: row.owner_team, taskKey: row.task_key, sourceKey: row.source_key, priority: row.priority,
    completedAt: row.completed_at?.toISOString() ?? null, completedBy: row.completed_by, updatedAt: row.updated_at.toISOString(),
  };
}

/** Canonical partial-ACAT steps for these transfers, still inside the caller's RLS transaction. */
export async function readPartialAcatTasks(tx: Prisma.TransactionClient, transferIds: readonly string[]): Promise<PartialAcatTaskRow[]> {
  if (!transferIds.length) return [];
  const rows = await tx.decisionTask.findMany({
    where: { transfer_id: { in: [...transferIds] }, decision_id: null, task_key: { in: [...TASK_KEYS] } },
    select: {
      id: true, transfer_id: true, title: true, sort_order: true, status: true, owner_team: true,
      task_key: true, source_key: true, priority: true, completed_at: true, completed_by: true, updated_at: true,
    },
    orderBy: [{ sort_order: "asc" }, { id: "asc" }],
  });
  return rows.flatMap(row => {
    const task = toPartialAcatTask(row);
    return task ? [task] : [];
  });
}

/** Queue tasks grouped by transfer. A known non-partial route, or an unfinished step on an archived transfer, is left out. */
export function partialAcatQueueTasks(
  rows: readonly PartialAcatTaskRow[],
  fundingTypeByTransfer: ReadonlyMap<string, FundingType | null>,
  archivedTransferIds: ReadonlySet<string> = new Set(),
): Map<string, WorkspaceTask[]> {
  const byTransfer = new Map<string, WorkspaceTask[]>();
  for (const row of rows) {
    const task = partialAcatWorkspaceTask(row, fundingTypeByTransfer.get(row.transferId) ?? null, archivedTransferIds.has(row.transferId));
    if (!task) continue;
    byTransfer.set(row.transferId, [...(byTransfer.get(row.transferId) ?? []), task]);
  }
  return byTransfer;
}

export async function getPartialAcatTasks(identity: Identity, transferId: string): Promise<PartialAcatTaskRow[]> {
  return withUserScope(identity, tx => readPartialAcatTasks(tx, [transferId]));
}
