"use client";

import { useMemo } from "react";
import type { DecisionTaskRow } from "@/lib/data/decision-cases";
import { TasksTable } from "./TasksTable";
import { ClosedTasks } from "./ClosedTasks";
import { partitionPersistedTasks, toPersistedTaskView } from "./tasks-model";

/** Saved Decision Center tasks with no linked transfer; the asset transfer work queue does not include them. */
export function NonTransferTasks({ tasks, canWrite, role }: { tasks: DecisionTaskRow[]; canWrite: boolean; role: string }) {
  const { active, inactive } = useMemo(
    () => partitionPersistedTasks(tasks.map((task) => toPersistedTaskView(task, role))),
    [tasks, role],
  );
  return (
    <section className="non-transfer-tasks" aria-labelledby="non-transfer-tasks-title" data-non-transfer-tasks>
      <h2 id="non-transfer-tasks-title">Other saved tasks</h2>
      <p className="small">
        These come from Decision Center decisions that are not linked to a transfer, so they are not part of the asset transfer work queue.
      </p>
      {active.length ? <TasksTable rows={active} canWrite={canWrite} /> : <p className="small">No open tasks.</p>}
      {inactive.length ? <ClosedTasks rows={inactive} /> : null}
    </section>
  );
}
