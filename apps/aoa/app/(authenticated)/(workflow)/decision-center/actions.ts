"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  DECISION_CASE_CREATE,
  DECISION_CASE_RESOLVE,
  DECISION_TASK_UPDATE,
  writeAudit,
} from "@/lib/audit";
import {
  DECISION_OWNER_TEAMS,
  type DecisionOwnerTeamValue,
  type DecisionTaskPriorityValue,
  type DecisionTaskStatusValue,
} from "@/lib/data/decision-cases";
import {
  buildPartialAcatDecisionSnapshot,
  partialPositionsFromFundingPlanSnapshot,
  PARTIAL_ACAT_EXECUTION_TASKS,
} from "@/lib/data/decision-case-workflow";
import {
  decisionTaskInactiveReason,
  isStandardPartialAcatTask,
  INACTIVE_REASON_WRITE_ERROR,
} from "@/lib/data/decision-task-context";
import { lockTransferPlan } from "@/lib/data/transfer-plan-lock";
import { canUpdateDrsTask, drsTaskSourceKey, drsTaskStatusError, getDrsTaskDefinition, isDrsTask } from "@/lib/data/drs-workflow";
import { withUserScope, type Identity } from "@/lib/rls";

type ActionError = { ok: false; message: string };
type ActionSuccess = { ok: true; id: string };
export type DecisionActionResult = ActionError | ActionSuccess;

const RESOLUTION_CODES = [
  "RETAIN_AT_CONTRA",
  "LIQUIDATE_SEPARATELY",
  "OTHER_APPROVED",
  "GENERAL_APPROVED",
  "TRANSFER_EXCEPTION_APPROVED",
] as const;

async function identityFromSession(): Promise<Identity> {
  const session = await auth();
  if (!session?.user) redirect("/");
  return {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
}

function canWrite(identity: Identity): identity is Identity & { email: string } {
  return (
    identity.email != null &&
    ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE"].includes(identity.role ?? "")
  );
}

function clean(value: string, max: number): string {
  return value.trim().slice(0, max);
}

export async function createManualDecision(input: {
  householdName: string;
  question: string;
  ownerTeam: DecisionOwnerTeamValue;
}): Promise<DecisionActionResult> {
  const identity = await identityFromSession();
  const householdName = clean(input.householdName, 180);
  const question = clean(input.question, 500);
  if (!canWrite(identity)) return { ok: false, message: "You do not have permission to create decisions." };
  if (!householdName || !question || !DECISION_OWNER_TEAMS.includes(input.ownerTeam)) {
    return { ok: false, message: "Add a client or household, a question, and a valid owner." };
  }

  try {
    const id = await withUserScope(identity, async (tx) => {
      const created = await tx.decisionCase.create({
        data: {
          source: "MANUAL",
          source_key: `manual:${randomUUID()}`,
          source_label: "Entered manually",
          household_name: householdName,
          category: "Unclassified",
          question,
          owner_team: input.ownerTeam,
          created_by: identity.email,
          tasks: {
            create: {
              task_key: "resolve-decision",
              title: "Resolve the open decision",
              owner_team: input.ownerTeam,
              priority: "NORMAL",
              created_by: identity.email,
            },
          },
        },
      });
      await tx.decisionCaseEvent.create({
        data: {
          decision_id: created.id,
          action: "CREATED",
          actor_email: identity.email,
          actor_role: identity.role,
          to_status: "OPEN",
          detail: { source: "MANUAL", ownerTeam: input.ownerTeam },
        },
      });
      await writeAudit(tx, identity, {
        action: DECISION_CASE_CREATE,
        entityType: "decision_case",
        entityId: created.id,
        detail: { source: "MANUAL", ownerTeam: input.ownerTeam, blocksTransfer: false },
      });
      return created.id;
    });
    revalidatePath("/decision-center");
    revalidatePath("/tasks");
    return { ok: true, id };
  } catch {
    return { ok: false, message: "The decision could not be created. Refresh and try again." };
  }
}

export async function createTransferExceptionDecision(input: {
  transferId: string;
  question: string;
  ownerTeam: DecisionOwnerTeamValue;
  blocksTransfer: boolean;
}): Promise<DecisionActionResult> {
  const identity = await identityFromSession();
  const transferId = clean(input.transferId, 191);
  const question = clean(input.question, 500);
  if (!canWrite(identity)) return { ok: false, message: "You do not have permission to escalate transfer exceptions." };
  if (!transferId || !question || !DECISION_OWNER_TEAMS.includes(input.ownerTeam)) {
    return { ok: false, message: "Add the exception question and a valid owner." };
  }

  try {
    const id = await withUserScope(identity, async (tx) => {
      // Share the transfer row lock with stage advancement so an exception
      // cannot commit between the stage gate's read and its write.
      await lockTransferPlan(tx, transferId);
      const transfer = await tx.transfer.findUnique({
        where: { id: transferId },
        include: {
          funding_plan_approvals: {
            orderBy: { version: "desc" },
            take: 1,
            select: { version: true, snapshot: true },
          },
        },
      });
      if (!transfer) throw new Error("transfer_not_found");
      const approval = transfer.funding_plan_approvals[0];
      const sourceVersion = Math.max(transfer.funding_plan_version, 1);
      // Approval snapshots have narrower RLS than exception creation. Keep
      // escalation available without presenting hidden or stale facts as a
      // current approved plan. source_version retains the transfer revision;
      // fundingPlanVersion identifies only an approval actually visible here.
      const currentApproval = transfer.funding_plan_complete &&
        approval?.version === transfer.funding_plan_version ? approval : null;
      const sourceSnapshot = buildPartialAcatDecisionSnapshot(
        currentApproval?.version ?? null,
        partialPositionsFromFundingPlanSnapshot(currentApproval?.snapshot),
      );
      const sourceLabel = currentApproval
        ? `Asset Transfer · exception · funding plan v${currentApproval.version}`
        : transfer.funding_plan_complete
          ? "Asset Transfer · exception · approval details unavailable"
          : "Asset Transfer · exception · plan not approved";
      const created = await tx.decisionCase.create({
        data: {
          source: "ASSET_TRANSFER",
          source_key: `asset-transfer:${transferId}:exception:${randomUUID()}`,
          source_label: sourceLabel,
          source_version: sourceVersion,
          source_snapshot: sourceSnapshot,
          transfer_id: transferId,
          client_name: `${transfer.client_first_name} ${transfer.client_last_name}`.trim(),
          household_name: transfer.household_name,
          household_sf_id: transfer.household_sf_id,
          category: "Asset transfer exception",
          question,
          context: input.blocksTransfer
            ? "A deliberate exception needs resolution before this transfer can proceed."
            : "A deliberate exception needs a recorded resolution, but it does not stop the transfer route.",
          owner_team: input.ownerTeam,
          blocks_transfer: input.blocksTransfer,
          created_by: identity.email,
          tasks: {
            create: {
              task_key: "resolve-transfer-exception",
              title: "Resolve the Asset Transfer exception",
              owner_team: input.ownerTeam,
              status: "TODO",
              priority: input.blocksTransfer ? "HIGH" : "NORMAL",
              transfer_id: transferId,
              created_by: identity.email,
            },
          },
        },
      });
      await tx.decisionCaseEvent.create({
        data: {
          decision_id: created.id,
          action: "CREATED",
          actor_email: identity.email,
          actor_role: identity.role,
          to_status: "OPEN",
          detail: {
            source: "ASSET_TRANSFER",
            sourceVersion,
            ownerTeam: input.ownerTeam,
            blocksTransfer: input.blocksTransfer,
          },
        },
      });
      await writeAudit(tx, identity, {
        action: DECISION_CASE_CREATE,
        entityType: "decision_case",
        entityId: created.id,
        detail: {
          source: "ASSET_TRANSFER",
          ownerTeam: input.ownerTeam,
          blocksTransfer: input.blocksTransfer,
          transferLinked: true,
        },
      });
      return created.id;
    });
    revalidatePath("/decision-center");
    revalidatePath("/tasks");
    revalidatePath(`/asset-transfer/${transferId}`);
    return { ok: true, id };
  } catch {
    return { ok: false, message: "The transfer exception could not be created. Refresh and try again." };
  }
}

export async function resolveDecisionCase(input: {
  decisionId: string;
  baseVersion: number;
  resolutionCode: string;
  resolutionSummary: string;
}): Promise<DecisionActionResult> {
  const identity = await identityFromSession();
  const resolutionSummary = clean(input.resolutionSummary, 1000);
  if (!canWrite(identity)) return { ok: false, message: "You do not have permission to resolve decisions." };
  if (
    !resolutionSummary ||
    !(RESOLUTION_CODES as readonly string[]).includes(input.resolutionCode)
  ) {
    return { ok: false, message: "Choose a resolution and record the final instruction." };
  }

  try {
    const result = await withUserScope(identity, async (tx) => {
      const current = await tx.decisionCase.findUnique({
        where: { id: input.decisionId },
        include: { tasks: true },
      });
      if (!current) return { ok: false as const, message: "This decision is no longer available." };
      if (current.version !== input.baseVersion || current.status === "RESOLVED") {
        return {
          ok: false as const,
          message: "This decision changed while you were reviewing it. Refresh before saving a resolution.",
        };
      }

      const now = new Date();
      const version = current.version + 1;
      // Claim the reviewed version atomically. A second reviewer may have read
      // the same OPEN row before the first resolution commits.
      const resolved = await tx.decisionCase.updateMany({
        where: { id: current.id, version: input.baseVersion, status: current.status },
        data: {
          status: "RESOLVED",
          resolution_code: input.resolutionCode,
          resolution_summary: resolutionSummary,
          version,
          resolved_by: identity.email,
          resolved_at: now,
        },
      });
      if (resolved.count !== 1) {
        return {
          ok: false as const,
          message: "This decision changed while you were reviewing it. Refresh before saving a resolution.",
        };
      }
      await tx.decisionTask.updateMany({
        where: {
          decision_id: current.id,
          task_key: {
            in: ["resolve-decision", "resolve-excluded-positions", "resolve-transfer-exception"],
          },
        },
        data: { status: "DONE", completed_by: identity.email, completed_at: now },
      });

      let generatedTaskCount = 0;
      if (current.source === "ASSET_TRANSFER" && current.transfer_id) {
        await tx.decisionTask.upsert({
          where: { decision_id_task_key: { decision_id: current.id, task_key: "execute-resolution" } },
          create: {
            decision_id: current.id,
            transfer_id: current.transfer_id,
            task_key: "execute-resolution",
            title: "Carry out the approved Asset Transfer exception",
            owner_team: current.owner_team,
            priority: "HIGH",
            sort_order: 10,
            created_by: identity.email,
          },
          update: {
            status: "TODO",
            completed_by: null,
            completed_at: null,
            owner_team: current.owner_team,
            priority: "HIGH",
          },
        });
        generatedTaskCount = 1;
      } else {
        await tx.decisionTask.upsert({
          where: { decision_id_task_key: { decision_id: current.id, task_key: "execute-resolution" } },
          create: {
            decision_id: current.id,
            task_key: "execute-resolution",
            title: "Carry out the approved decision",
            owner_team: current.owner_team,
            priority: "NORMAL",
            sort_order: 10,
            created_by: identity.email,
          },
          update: { status: "TODO", completed_by: null, completed_at: null, owner_team: current.owner_team },
        });
        generatedTaskCount = 1;
      }

      await tx.decisionCaseEvent.create({
        data: {
          decision_id: current.id,
          action: "RESOLVED",
          actor_email: identity.email,
          actor_role: identity.role,
          from_status: current.status,
          to_status: "RESOLVED",
          note_present: true,
          detail: { resolutionCode: input.resolutionCode, version, generatedTaskCount },
        },
      });
      await writeAudit(tx, identity, {
        action: DECISION_CASE_RESOLVE,
        entityType: "decision_case",
        entityId: current.id,
        detail: {
          source: current.source,
          resolutionCode: input.resolutionCode,
          version,
          taskCount: generatedTaskCount,
          transferLinked: current.transfer_id != null,
        },
      });
      return { ok: true as const, id: current.id, transferId: current.transfer_id };
    });
    if (!result.ok) return result;
    revalidatePath("/decision-center");
    revalidatePath("/tasks");
    if (result.transferId) revalidatePath(`/asset-transfer/${result.transferId}`);
    return { ok: true, id: result.id };
  } catch {
    return { ok: false, message: "The resolution could not be saved. Refresh and try again." };
  }
}

export async function updateDecisionTask(input: {
  taskId: string;
  status: DecisionTaskStatusValue;
  priority: DecisionTaskPriorityValue;
  expectedUpdatedAt?: string;
  expectedFundingPlanVersion?: number;
  expectedFundingMethodRevision?: number;
}): Promise<DecisionActionResult> {
  const identity = await identityFromSession();
  const statuses: DecisionTaskStatusValue[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];
  const priorities: DecisionTaskPriorityValue[] = ["LOW", "NORMAL", "HIGH"];
  if (!canWrite(identity)) return { ok: false, message: "You do not have permission to update tasks." };
  if (!statuses.includes(input.status) || !priorities.includes(input.priority)) {
    return { ok: false, message: "Choose a valid task status and priority." };
  }

  try {
    const result = await withUserScope(identity, async (tx) => {
      let task = await tx.decisionTask.findUnique({ where: { id: input.taskId } });
      if (!task) return null;
      if (isDrsTask(task)) {
        const unavailable = { error: "This DRS task is no longer available. Refresh the transfer." };
        if (!task.transfer_id || task.decision_id !== null) return unavailable;
        await lockTransferPlan(tx, task.transfer_id);
        // Re-read after acquiring the same lock used by approval and stage changes.
        const current = await tx.decisionTask.findUnique({ where: { id: task.id } });
        const transfer = await tx.transfer.findUnique({
          where: { id: task.transfer_id },
          select: { funding_type: true, funding_plan_complete: true, funding_plan_version: true, stage: true, archived_at: true, drs_method_change_pending: true },
        });
        if (!current || current.transfer_id !== task.transfer_id || current.decision_id !== null) return unavailable;
        const definition = getDrsTaskDefinition(current.task_key);
        if (!definition || current.source_key !== drsTaskSourceKey(task.transfer_id, definition.key)
          || current.owner_team !== definition.ownerTeam) return unavailable;
        if (!transfer || transfer.funding_type !== "DRS") return { error: "This transfer no longer uses DRS. Refresh the transfer." };
        if (transfer.archived_at) return { error: "Archived transfers cannot have DRS tasks updated." };
        if (!transfer.funding_plan_complete || transfer.funding_plan_version < 1) {
          return { error: "Approve the current DRS funding plan before updating its tasks." };
        }
        if (input.expectedFundingPlanVersion !== transfer.funding_plan_version
          || input.expectedUpdatedAt !== current.updated_at.toISOString()) {
          return { error: "This DRS task or funding plan changed. Refresh before updating it." };
        }
        const statusError = drsTaskStatusError({
          taskKey: current.task_key, role: identity.role, stage: transfer.stage,
          status: input.status, currentStatus: current.status, methodChangePending: transfer.drs_method_change_pending,
        });
        if (statusError) return { error: statusError };
        const statusChanged = current.status !== input.status;
        if (!statusChanged && current.priority === input.priority) {
          return { decisionId: null, transferId: current.transfer_id };
        }
        const updated = await tx.decisionTask.updateMany({
          where: { id: current.id, updated_at: current.updated_at, transfer_id: current.transfer_id,
            decision_id: null, task_key: definition.taskKey, source_key: current.source_key, owner_team: definition.ownerTeam },
          data: {
            status: input.status, priority: input.priority,
            // A browser token must change even when writes share a clock millisecond.
            updated_at: new Date(Math.max(Date.now(), current.updated_at.getTime() + 1)),
            ...(statusChanged ? { completed_by: input.status === "DONE" ? identity.email : null,
              completed_at: input.status === "DONE" ? new Date() : null } : {}),
          },
        });
        if (updated.count !== 1) return { error: "This DRS task changed. Refresh before updating it." };
        await writeAudit(tx, identity, {
          action: DECISION_TASK_UPDATE, entityType: "transfer", entityId: task.transfer_id,
          detail: { taskId: current.id, taskKey: current.task_key, source: "ASSET_TRANSFER",
            fundingPlanVersion: transfer.funding_plan_version, fromStatus: current.status, toStatus: input.status,
            fromPriority: current.priority, toPriority: input.priority },
        });
        return { decisionId: null, transferId: current.transfer_id };
      }
      if (isStandardPartialAcatTask({ decisionId: task.decision_id, transferId: task.transfer_id, sourceKey: task.source_key })) {
        await lockTransferPlan(tx, task.transfer_id!);
        const fresh = await tx.decisionTask.findUnique({ where: { id: task.id } });
        const transfer = await tx.transfer.findUnique({ where: { id: task.transfer_id! }, select: {
          funding_type: true, funding_method_revision: true, funding_plan_version: true,
          funding_plan_complete: true, archived_at: true,
        } });
        if (!fresh || !transfer || fresh.transfer_id !== task.transfer_id || fresh.decision_id !== null) return null;
        task = fresh;
        if (transfer.funding_method_revision > 0) {
          const definition = PARTIAL_ACAT_EXECUTION_TASKS.find((row) => row.key === fresh.task_key);
          if (!definition || fresh.source_key !== `asset-transfer:${fresh.transfer_id}:standard-partial-acat:${definition.key}` ||
              fresh.owner_team !== definition.owner || fresh.decision_id !== null || transfer.archived_at ||
              transfer.funding_type !== "ACAT_PARTIAL" || !transfer.funding_plan_complete) {
            return { error: "This partial-ACAT work is no longer active. Refresh the transfer." };
          }
          if (!canUpdateDrsTask(identity.role, definition.owner)) return { error: "The responsible team must update this partial-ACAT task." };
          if (input.expectedFundingPlanVersion !== transfer.funding_plan_version ||
              input.expectedFundingMethodRevision !== transfer.funding_method_revision ||
              input.expectedUpdatedAt !== fresh.updated_at.toISOString()) {
            return { error: "This partial-ACAT task or funding method changed. Refresh before updating it." };
          }
        }
      }
      // ticket: the Tasks page shows archived-transfer tasks and tasks that
      // are no longer active work as read-only; enforce the same rule here so a
      // stale or hand-built request cannot reopen or edit them. Unfinished
      // tasks on an archived transfer leave the Tasks totals (TRANSFER_ARCHIVED),
      // so refusing them here cannot strand them in the open-work counts.
      // Same derivation as the page (decision-task-context), same RLS scope.
      const linkedTransfer = task.transfer_id
        ? await tx.transfer.findUnique({
          where: { id: task.transfer_id },
          select: { archived_at: true, funding_type: true },
        })
        : null;
      if (task.transfer_id && !linkedTransfer) return null;
      if (linkedTransfer?.archived_at) return { error: INACTIVE_REASON_WRITE_ERROR.TRANSFER_ARCHIVED };
      const linkedDecision = task.decision_id
        ? await tx.decisionCase.findUnique({ where: { id: task.decision_id }, select: { source_key: true, resolution_code: true } })
        : null;
      const inactiveReason = decisionTaskInactiveReason({
        decisionId: task.decision_id,
        transferId: task.transfer_id,
        sourceKey: task.source_key,
        taskKey: task.task_key,
        status: task.status,
        transferFundingType: linkedTransfer ? linkedTransfer.funding_type : undefined,
        transferArchived: linkedTransfer ? linkedTransfer.archived_at !== null : undefined,
        decisionSourceKey: linkedDecision ? linkedDecision.source_key : undefined,
        decisionResolutionCode: linkedDecision ? linkedDecision.resolution_code : undefined,
      });
      if (inactiveReason) return { error: INACTIVE_REASON_WRITE_ERROR[inactiveReason] };
      const changed = task.status !== input.status || task.priority !== input.priority;
      if (!changed) return { decisionId: task.decision_id, transferId: task.transfer_id };
      const done = input.status === "DONE";
      await tx.decisionTask.update({
        where: { id: task.id },
        data: {
          status: input.status,
          priority: input.priority,
          updated_at: new Date(Math.max(Date.now(), task.updated_at.getTime() + 1)),
          completed_by: done ? identity.email : null,
          completed_at: done ? new Date() : null,
        },
      });
      if (task.decision_id) {
        await tx.decisionCaseEvent.create({
          data: {
            decision_id: task.decision_id,
            action: "TASK_UPDATED",
            actor_email: identity.email,
            actor_role: identity.role,
            note_present: false,
            detail: {
              taskId: task.id,
              fromStatus: task.status,
              toStatus: input.status,
              fromPriority: task.priority,
              toPriority: input.priority,
            },
          },
        });
      }
      await writeAudit(tx, identity, {
        action: DECISION_TASK_UPDATE,
        entityType: task.decision_id ? "decision_case" : "transfer",
        entityId: task.decision_id ?? task.transfer_id ?? task.id,
        detail: {
          taskId: task.id,
          source: task.decision_id ? "DECISION" : "ASSET_TRANSFER",
          fromStatus: task.status,
          toStatus: input.status,
          fromPriority: task.priority,
          toPriority: input.priority,
        },
      });
      return { decisionId: task.decision_id, transferId: task.transfer_id };
    });
    if (!result) return { ok: false, message: "This task is no longer available." };
    if ("error" in result) return { ok: false, message: result.error };
    revalidatePath("/decision-center");
    revalidatePath("/tasks");
    revalidatePath("/asset-transfer");
    if (result.transferId) revalidatePath(`/asset-transfer/${result.transferId}`);
    return { ok: true, id: input.taskId };
  } catch {
    return { ok: false, message: "The task could not be updated. Refresh and try again." };
  }
}
