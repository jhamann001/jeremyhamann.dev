import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { DRS_TASKS, drsTaskSourceKey, type DrsWorkflowTaskRow } from "./drs-workflow";

/** Caller holds the transfer-plan lock and writes approval/setup audit in this transaction. */
export async function syncDrsWorkflowTasks(
  tx: Prisma.TransactionClient,
  identity: Identity,
  input: { transferId: string; restartExistingTasks?: boolean },
): Promise<number> {
  if (!identity.email) throw new Error("drs_task_actor_email_required");
  const existing = await tx.decisionTask.findMany({
    where: { source_key: { in: DRS_TASKS.map((task) => drsTaskSourceKey(input.transferId, task.key)) } },
    select: { source_key: true, task_key: true, transfer_id: true, decision_id: true },
  });
  // Never silently reassign an existing task's history to repair a corrupt key.
  // The explicit setup action can report this instead of appearing to succeed
  // while leaving the fail-closed inventory gate permanently unsatisfied.
  for (const row of existing) {
    const definition = DRS_TASKS.find((task) => row.source_key === drsTaskSourceKey(input.transferId, task.key));
    if (!definition || row.task_key !== definition.taskKey || row.transfer_id !== input.transferId || row.decision_id !== null) {
      throw new Error("DRS_TASK_IDENTITY_CONFLICT");
    }
  }
  for (const [index, task] of DRS_TASKS.entries()) {
    await tx.decisionTask.upsert({
      where: { source_key: drsTaskSourceKey(input.transferId, task.key) },
      create: {
        source_key: drsTaskSourceKey(input.transferId, task.key),
        task_key: task.taskKey,
        transfer_id: input.transferId,
        decision_id: null,
        title: task.title,
        owner_team: task.ownerTeam,
        priority: "HIGH",
        sort_order: index,
        created_by: identity.email,
      },
      update: {
        title: task.title,
        owner_team: task.ownerTeam,
        sort_order: index,
        ...(input.restartExistingTasks ? { status: "TODO", completed_by: null, completed_at: null } : {}),
      },
    });
  }
  return DRS_TASKS.length;
}

export async function readDrsWorkflowTasks(
  tx: Prisma.TransactionClient,
  input: { transferId: string; fundingPlanVersion: number },
): Promise<DrsWorkflowTaskRow[]> {
  const rows = await tx.decisionTask.findMany({
    where: {
      transfer_id: input.transferId,
      decision_id: null,
      source_key: { in: DRS_TASKS.map((task) => drsTaskSourceKey(input.transferId, task.key)) },
    },
  });
  return DRS_TASKS.flatMap((definition): DrsWorkflowTaskRow[] => {
    const row = rows.find((task) => task.source_key === drsTaskSourceKey(input.transferId, definition.key)
      && task.task_key === definition.taskKey && task.owner_team === definition.ownerTeam);
    return row ? [{
      id: row.id,
      key: definition.key,
      taskKey: definition.taskKey,
      title: definition.title,
      ownerTeam: definition.ownerTeam,
      status: row.status,
      priority: row.priority,
      completedAt: row.completed_at?.toISOString() ?? null,
      completedBy: row.completed_by,
      updatedAt: row.updated_at.toISOString(),
      fundingPlanVersion: input.fundingPlanVersion,
    }] : [];
  });
}

/** Read-only; legacy DRS records initialize explicitly rather than mutating on a GET. */
export async function getDrsWorkflowTasks(identity: Identity, transferId: string): Promise<DrsWorkflowTaskRow[]> {
  return withUserScope(identity, async (tx) => {
    const transfer = await tx.transfer.findUnique({
      where: { id: transferId },
      select: { funding_type: true, funding_plan_version: true },
    });
    if (transfer?.funding_type !== "DRS") return [];
    return readDrsWorkflowTasks(tx, { transferId, fundingPlanVersion: transfer.funding_plan_version });
  });
}
