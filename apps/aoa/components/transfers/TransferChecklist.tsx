"use client";

import { useState, useTransition } from "react";
import type { TransferTaskRow } from "@/lib/data/transfer-types";
import { Button } from "@/components/ui";
import {
  addTask,
  toggleTask,
} from "@/app/(authenticated)/asset-transfer/actions";
import styles from "./TransferChecklist.module.css";

// To-do checklist card body (WO ticket, TDD ADR-3). Toggling calls the
// audited server action, which stamps completed_at/completed_by and
// revalidates the board + detail — board/checklist sync is SERVER
// persistence, never a client store (the anti-Phase-C-ephemera posture).
// Tasks can be added, never deleted (uncheck instead). VIEWER
// (canWrite=false): static markers, no checkboxes, no add row — the DB
// policies would reject the write anyway (ADR-4).

const stamp = (d: Date | string): string =>
  new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

export function TransferChecklist({
  transferId,
  tasks,
  canWrite,
}: {
  transferId: string;
  tasks: TransferTaskRow[];
  canWrite: boolean;
}) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (taskId: string, done: boolean) => {
    startTransition(async () => {
      const result = await toggleTask(transferId, taskId, done);
      setError(result && !result.ok ? result.errors[0]?.message : null);
    });
  };

  const add = () => {
    startTransition(async () => {
      const result = await addTask(transferId, title);
      if (result && !result.ok) {
        setError(result.errors[0]?.message ?? null);
      } else {
        setError(null);
        setTitle("");
      }
    });
  };

  const doneCount = tasks.filter((t) => t.done).length;

  return (
    <div className={styles.wrap}>
      <p className={styles.progress}>
        {doneCount}/{tasks.length} done
        <span className={styles.noDelete}>
          tasks are never deleted — uncheck instead
        </span>
      </p>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <ul className={styles.list}>
        {tasks.map((t) => (
          <li key={t.id} className={styles.row}>
            {canWrite ? (
              <input
                type="checkbox"
                className={styles.check}
                checked={t.done}
                disabled={pending}
                onChange={(e) => toggle(t.id, e.target.checked)}
                aria-label={`${t.title} — ${t.done ? "done" : "open"}`}
              />
            ) : (
              <span className={styles.marker} aria-hidden="true">
                {t.done ? "✓" : "○"}
              </span>
            )}
            <span className={t.done ? styles.titleDone : styles.title}>
              {t.title}
              {t.done && t.completed_at && (
                <span className={styles.stamp}>
                  {stamp(t.completed_at)}
                  {t.completed_by ? ` · ${t.completed_by}` : ""}
                </span>
              )}
            </span>
          </li>
        ))}
        {tasks.length === 0 && (
          <li className={styles.empty}>No checklist tasks yet.</li>
        )}
      </ul>

      {canWrite && (
        <form
          className={styles.addRow}
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            className={styles.addInput}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a task…"
            aria-label="New task title"
          />
          <Button size="sm" variant="ghost" type="submit" disabled={pending}>
            Add task
          </Button>
        </form>
      )}
    </div>
  );
}
