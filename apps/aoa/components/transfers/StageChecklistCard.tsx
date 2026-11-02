"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { toggleTask } from "@/app/(authenticated)/asset-transfer/actions";
import type { TransferTaskRow } from "@/lib/data/transfer-types";
import styles from "./DecisionChecklistCard.module.css";

// Stage checklist in the Decision-Readiness card UI (CHECKLIST_STAGE_GATE). Same
// marker/row/label/hint idiom as DecisionChecklistCard — the owner prefers this
// look — but the rows ARE the to-do tasks (transfer_task), and completing them
// is the stage gate (setStage blocks a forward move on any open visible task).
// Toggle writes through the existing toggleTask action, so the synced-task /
// override_done rules stay intact. `tasks` arrive already stage-scoped + resolved
// (stageChecklistTasks + resolveTaskDone) from the page, so what shows here is
// exactly what the gate enforces.

export function StageChecklistCard({
  transferId,
  tasks,
  canWrite,
}: {
  transferId: string;
  tasks: TransferTaskRow[];
  canWrite: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (taskId: string, done: boolean) => {
    startTransition(async () => {
      const result = await toggleTask(transferId, taskId, done);
      setError(result && !result.ok ? (result.errors[0]?.message ?? null) : null);
    });
  };

  return (
    <div className={styles.wrap}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {tasks.length === 0 && (
        <p className={styles.hint}>No checklist items for this stage.</p>
      )}
      <ul className={styles.list}>
        {tasks.map((t) => (
          <li key={t.id} className={styles.row}>
            <span
              className={t.done ? styles.markerDone : styles.markerTodo}
              aria-hidden="true"
            >
              {t.done ? "✓" : "○"}
            </span>
            <span className={styles.text}>
              <span className={styles.label}>{t.title}</span>
              {t.done && t.completed_at && (
                <span className={styles.hint}>
                  {new Date(t.completed_at).toLocaleDateString()}
                  {t.completed_by ? ` · ${t.completed_by}` : ""}
                </span>
              )}
            </span>
            {canWrite && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => toggle(t.id, !t.done)}
              >
                {t.done ? "Clear" : "Mark done"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
