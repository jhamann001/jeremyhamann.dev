import type { Prisma } from "@prisma/client";
import type { Identity } from "@/lib/rls";
import { PARTIAL_ACAT_EXECUTION_TASKS } from "./partial-acat-tasks";
export { PARTIAL_ACAT_EXECUTION_TASKS } from "./partial-acat-tasks";

export type PartialDecisionPosition = {
  symbol: string;
  description?: string | null;
  marketValue?: number | null;
  costBasis?: number | null;
  ineligible?: boolean | null;
  isTransferring: boolean;
};

function snapshotPosition(position: PartialDecisionPosition) {
  return {
    symbol: position.symbol,
    description: position.description ?? null,
    marketValue: position.marketValue ?? null,
    costBasis: position.costBasis ?? null,
    ineligible: position.ineligible ?? null,
    isTransferring: position.isTransferring,
  };
}

/** Frozen facts for a deliberately escalated transfer exception. */
export function buildPartialAcatDecisionSnapshot(
  fundingPlanVersion: number | null,
  positions: PartialDecisionPosition[],
) {
  const included = positions
    .filter((position) => position.isTransferring)
    .map((position) => position.symbol)
    .sort((a, b) => a.localeCompare(b));
  const excluded = positions
    .filter((position) => !position.isTransferring)
    .map((position) => position.symbol)
    .sort((a, b) => a.localeCompare(b));
  return {
    fundingPlanVersion,
    included,
    excluded,
    includedCount: included.length,
    excludedCount: excluded.length,
    positions: positions.map(snapshotPosition),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalize either asset-map or legacy basis rows from an approval snapshot. */
export function partialPositionsFromFundingPlanSnapshot(
  value: unknown,
): PartialDecisionPosition[] {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>).positions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): PartialDecisionPosition[] => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.symbol !== "string" || row.symbol.length === 0) return [];
    const isTransferring = typeof row.isTransferring === "boolean"
      ? row.isTransferring
      : row.decision === "BRING_IN";
    return [{
      symbol: row.symbol,
      description: typeof row.description === "string" ? row.description : null,
      marketValue: finiteNumber(row.marketValue) ?? finiteNumber(row.value),
      costBasis: finiteNumber(row.costBasis),
      ineligible: typeof row.ineligible === "boolean" ? row.ineligible : null,
      isTransferring,
    }];
  });
}

/**
 * Materialize known execution work directly from an approved funding plan.
 * These tasks deliberately have no decision_id: leaving assets behind is the
 * normal partial-ACAT route, not unresolved judgment. Stable source keys make
 * unchanged partial approvals idempotent. Returning from another approved route
 * or changing approved securities instructions restarts all three tasks: prior
 * preparation must be reviewed again.
 */
export async function syncPartialAcatExecutionTasks(
  tx: Prisma.TransactionClient,
  identity: Identity,
  input: { transferId: string; active: boolean; restartExistingTasks?: boolean },
): Promise<number> {
  if (!identity.email) throw new Error("workflow_task_actor_email_required");
  const prefix = `asset-transfer:${input.transferId}:standard-partial-acat:`;

  if (!input.active) {
    const now = new Date();
    const retired = await tx.decisionTask.updateMany({
      where: {
        decision_id: null,
        transfer_id: input.transferId,
        source_key: { startsWith: prefix },
        status: { not: "DONE" },
      },
      data: { status: "DONE", completed_by: identity.email, completed_at: now },
    });
    return retired.count;
  }

  for (const task of PARTIAL_ACAT_EXECUTION_TASKS) {
    const sourceKey = `${prefix}${task.key}`;
    await tx.decisionTask.upsert({
      where: { source_key: sourceKey },
      create: {
        source_key: sourceKey,
        decision_id: null,
        transfer_id: input.transferId,
        task_key: task.key,
        title: task.title,
        owner_team: task.owner,
        priority: "HIGH",
        sort_order: task.sort,
        created_by: identity.email,
      },
      update: {
        title: task.title,
        owner_team: task.owner,
        priority: "HIGH",
        ...(input.restartExistingTasks ? {
          status: "TODO" as const,
          completed_by: null,
          completed_at: null,
        } : {}),
      },
    });
  }
  return PARTIAL_ACAT_EXECUTION_TASKS.length;
}
