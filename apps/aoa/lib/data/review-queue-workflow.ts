import "server-only";

import type { Prisma, ReviewQueueStatus } from "@prisma/client";
import { writeAudit, REVIEW_QUEUE_UPDATE } from "@/lib/audit";
import type { Identity } from "@/lib/rls";

export type ReviewQueueWorkflowInput = {
  id: string;
  expectedUpdatedAt: Date;
  status: ReviewQueueStatus;
  assignedTo: string | null;
  note: string;
  snoozedUntil: Date | null;
};

/** Compare-and-save boundary used to reject cleared rows and stale editor forms. */
export async function compareAndSaveReviewQueueWorkflow(
  tx: Prisma.TransactionClient,
  identity: Identity,
  input: ReviewQueueWorkflowInput,
): Promise<"updated" | "conflict"> {
  const current = await tx.reviewQueueItem.findUnique({ where: { id: input.id } });
  if (
    !current ||
    !current.source_active ||
    current.updated_at.getTime() !== input.expectedUpdatedAt.getTime()
  ) return "conflict";

  const now = new Date();
  const saved = await tx.reviewQueueItem.updateMany({
    where: {
      id: input.id,
      source_active: true,
      updated_at: input.expectedUpdatedAt,
    },
    data: {
      status: input.status,
      assigned_to: input.assignedTo,
      resolution_note: input.note,
      snoozed_until: input.status === "SNOOZED" ? input.snoozedUntil : null,
      resolved_at: input.status === "RESOLVED" ? now : null,
      resolved_by: input.status === "RESOLVED" ? identity.email ?? null : null,
      updated_by: identity.email ?? null,
    },
  });
  if (saved.count !== 1) return "conflict";

  await tx.reviewQueueEvent.create({
    data: {
      item_id: input.id,
      action: "WORKFLOW_UPDATED",
      actor_email: identity.email ?? null,
      actor_role: identity.role ?? null,
      from_status: current.status,
      to_status: input.status,
      note_present: input.note !== "",
      detail: {
        assignmentChanged: current.assigned_to !== input.assignedTo,
        fromAssignee: current.assigned_to,
        toAssignee: input.assignedTo,
        snoozed: input.status === "SNOOZED",
      },
    },
  });
  await writeAudit(tx, identity, {
    action: REVIEW_QUEUE_UPDATE,
    entityType: "review_queue_item",
    entityId: input.id,
    detail: {
      from: current.status,
      to: input.status,
      assignmentChanged: current.assigned_to !== input.assignedTo,
      notePresent: input.note !== "",
    },
  });
  return "updated";
}
