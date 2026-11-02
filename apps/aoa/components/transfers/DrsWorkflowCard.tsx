"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { initializeDrsWorkflow } from "@/app/(authenticated)/asset-transfer/actions";
import { updateDecisionTask } from "@/app/(authenticated)/(workflow)/decision-center/actions";
import {
  DRS_TASKS,
  canUpdateDrsTask,
  drsTaskStatusError,
  type DrsWorkflowTaskRow,
} from "@/lib/data/drs-workflow";
import { DECISION_OWNER_LABEL } from "@/lib/data/decision-case-shared";
import { canApproveFundingPlan } from "@/lib/data/transfer-write";
import type { TransferStage } from "@/lib/data/transfer-types";
import styles from "./DrsWorkflowCard.module.css";

const STATUS_LABEL = {
  TODO: "To do", IN_PROGRESS: "In progress", BLOCKED: "Blocked", DONE: "Done",
} as const;

const GROUPS = [
  { gate: "IN_TRANSFER", title: "Preparation", hint: "Complete these steps before moving to In transfer." },
  { gate: "FUNDED", title: "In transfer", hint: "Apex confirmation is required before moving to Funded." },
  { gate: null, title: "Follow-up", hint: "Reconciliation and client communication remain separate tasks after funding." },
] as const;

export function DrsWorkflowCard({
  transferId, stage, tasks, role, canWrite, planComplete, fundingPlanVersion, methodChangePending = false,
}: {
  transferId: string;
  stage: TransferStage;
  tasks: DrsWorkflowTaskRow[];
  role: string;
  canWrite: boolean;
  planComplete: boolean;
  fundingPlanVersion: number;
  methodChangePending?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const approved = planComplete && fundingPlanVersion > 0;
  const missing = DRS_TASKS.some((definition) => !tasks.some((task) => task.taskKey === definition.taskKey));

  const initialize = () => {
    setError(null);
    startTransition(async () => {
      const result = await initializeDrsWorkflow(transferId);
      if (!result.ok) {
        setError(result.errors[0]?.message ?? "DRS tasks could not be initialized. Refresh and try again.");
        return;
      }
      router.refresh();
    });
  };

  const update = (task: DrsWorkflowTaskRow) => {
    setError(null);
    startTransition(async () => {
      const result = await updateDecisionTask({
        taskId: task.id,
        status: task.status === "DONE" ? "TODO" : "DONE",
        priority: task.priority,
        expectedUpdatedAt: task.updatedAt,
        expectedFundingPlanVersion: task.fundingPlanVersion,
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className={styles.wrap}>
      <p className={styles.help}>Mark each task done when complete, then use the stage toolbar to move the transfer.</p>
      {methodChangePending && <p className={styles.notice}>The funding method changed to DRS while In transfer. Complete the DRS preparation and asset-movement confirmation tasks before marking it Funded.</p>}
      {!approved && <p className={styles.notice}>Approve the DRS funding plan before completing workflow tasks.</p>}
      {approved && missing && (
        <div className={styles.notice}>
          <p>DRS tasks are missing. Initialize the workflow before moving this transfer forward.</p>
          {canWrite && canApproveFundingPlan(role) && (
            <Button size="sm" disabled={pending} onClick={initialize}>
              {pending ? "Initializing…" : "Initialize DRS tasks"}
            </Button>
          )}
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {GROUPS.map((group) => (
        <section key={group.title} aria-label={`DRS ${group.title.toLowerCase()}`}>
          <h3 className={styles.heading}>{group.title}</h3>
          <p className={styles.help}>{methodChangePending && group.gate === "IN_TRANSFER" ? "Complete these preparation steps for the new DRS method before moving to Funded." : group.hint}</p>
          <ul className={styles.list}>
            {DRS_TASKS.filter((definition) => definition.requiredBefore === group.gate).map((definition) => {
              const task = tasks.find((row) => row.taskKey === definition.taskKey);
              const allowedOwner = canWrite && canUpdateDrsTask(role, definition.ownerTeam);
              const nextStatus = task?.status === "DONE" ? "TODO" : "DONE";
              const unavailable = task ? drsTaskStatusError({
                taskKey: task.taskKey, role, stage, status: nextStatus, currentStatus: task.status, methodChangePending,
              }) : null;
              return (
                <li key={definition.key} className={styles.row}>
                  <span aria-hidden="true" className={task?.status === "DONE" ? styles.done : styles.todo}>
                    {task?.status === "DONE" ? "✓" : "○"}
                  </span>
                  <div className={styles.text}>
                    <span className={styles.title}>{definition.title}</span>
                    <span className={styles.meta}>
                      {DECISION_OWNER_LABEL[definition.ownerTeam]} · {task ? STATUS_LABEL[task.status] : "Not initialized"}
                    </span>
                    {task?.completedAt && task.completedBy && <span className={styles.meta}>
                      Completed by {task.completedBy} on {new Date(task.completedAt).toLocaleDateString("en-US")}
                    </span>}
                    {allowedOwner && unavailable && <span className={styles.meta}>{unavailable}</span>}
                  </div>
                  {task && approved && allowedOwner && (
                    <Button
                      size="sm" variant="ghost" disabled={pending || missing || Boolean(unavailable)}
                      aria-label={`${task.status === "DONE" ? "Reopen" : "Mark done"}: ${definition.title}`}
                      onClick={() => update(task)}
                    >
                      {task.status === "DONE" ? "Reopen" : "Mark done"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
