"use client";

import { useMemo, useState } from "react";
import { Card, Kpi, PreviewBadge, SectionLabel } from "@/components/ui";
import { useTasks } from "@/components/workflow";
import type { TaskStatus } from "@/components/workflow";
import type { DecisionTaskRow } from "@/lib/data/decision-cases";
import { TasksTable, type TasksTableRow } from "./TasksTable";
import { TableEmptyState } from "./TableEmptyState";
import { StatusFilter, type FilterValue } from "./StatusFilter";
import { ClosedTasks } from "./ClosedTasks";
import { countTasks, partitionPersistedTasks, toPersistedTaskView } from "./tasks-model";
import { groupTasks } from "./grouped-tasks-model";
import { GroupedTasks } from "./GroupedTasks";
import styles from "./GroupedTasks.module.css";

const KPI_BUCKETS: { key: TaskStatus; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

// ticket: the totals, the filter chips and the working table come ONLY from
// persisted tasks this viewer can read, minus tasks that are no longer active
// work (listed separately in ClosedTasks, never counted). Demo sample rows from the
// ephemeral workflow store render only when the server-evaluated dev-only
// switch is on (tasksSampleRowsEnabled in lib/flags.ts), in their own block,
// and are never counted. The WorkflowProvider stays mounted by the route-group
// layout because Decision Center still uses it. Labels and route helpers come
// from the browser-safe decision-case-shared module via ./tasks-model.
export function TasksWorkspace({
  durableTasks,
  canWrite,
  role = "VIEWER",
  sampleRowsEnabled = false,
}: {
  durableTasks: DecisionTaskRow[];
  canWrite: boolean;
  role?: string;
  sampleRowsEnabled?: boolean;
}) {
  const sampleTasks = useTasks();
  const [status, setStatus] = useState<FilterValue>("all");
  const [view, setView] = useState<"grouped" | "flat">("grouped");
  const { active, inactive } = useMemo(
    () => partitionPersistedTasks(durableTasks.map((task) => toPersistedTaskView(task, role))),
    [durableTasks, role],
  );
  const rows: TasksTableRow[] = active;
  const counts = useMemo(() => countTasks(rows), [rows]);
  const filtered = status === "all" ? rows : rows.filter((row) => row.status === status);
  const grouped = useMemo(() => groupTasks(active, status), [active, status]);
  const sampleRows = useMemo<TasksTableRow[]>(
    () => (sampleRowsEnabled ? sampleTasks.map((task) => ({ ...task, isSample: true })) : []),
    [sampleRowsEnabled, sampleTasks],
  );

  return (
    <>
      <SectionLabel>Workflow · Execution</SectionLabel>
      <h1 style={{ marginTop: 6 }}>Tasks</h1>
      <p style={{ color: "var(--muted)", marginTop: 6 }}>
        Saved tasks by client and transfer, with each transfer&apos;s workflow and next step together.
      </p>
      <p style={{ color: "var(--faint)", marginTop: 4, fontSize: 12 }}>
        The totals count only real, saved tasks you can see. Tasks that are no longer active work, because a plan changed or the transfer was archived, are listed separately below.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginTop: 20 }}>
        <Card><Kpi label="Total tasks" value={counts.all} /></Card>
        {KPI_BUCKETS.map((bucket) => (
          <Card key={bucket.key}><Kpi label={bucket.label} value={counts[bucket.key]} /></Card>
        ))}
      </div>

      <div className={styles.viewToggle} role="group" aria-label="Task view">
        <button type="button" aria-pressed={view === "grouped"} onClick={() => setView("grouped")}>By client and transfer</button>
        <button type="button" aria-pressed={view === "flat"} onClick={() => setView("flat")}>Flat list</button>
      </div>
      <StatusFilter value={status} counts={counts} onChange={setStatus} />
      {view === "grouped" ? <p className={styles.filterHint}>Clients A–Z · Transfers oldest first. Updating a task or stage keeps each transfer in the same order.</p> : null}
      {view === "grouped" && status !== "all" ? <p className={styles.filterHint}>Matching transfers show their full active checklist. Other statuses are labeled as context and stay in the transfer&apos;s completion count.</p> : null}
      {rows.length === 0 ? (
        <TableEmptyState
          title="No tasks yet"
          hint="Tasks appear here when a transfer's funding plan is approved or a saved decision creates one."
        />
      ) : filtered.length === 0 ? (
        <TableEmptyState title="No tasks match this filter" hint="Clear the status filter to see all tasks." />
      ) : view === "flat" ? (
        <TasksTable rows={filtered} canWrite={canWrite} />
      ) : (
        <>
          <GroupedTasks clients={grouped.clients} canWrite={canWrite} />
          {grouped.other.length > 0 ? <div style={{ marginTop: grouped.clients.length > 0 ? 20 : 0 }}>
            <TasksTable rows={grouped.other} canWrite={canWrite} title="Other saved tasks" />
          </div> : null}
        </>
      )}

      {inactive.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <ClosedTasks rows={inactive} />
        </div>
      ) : null}

      {sampleRowsEnabled ? (
        <section aria-label="Demo sample workflow (dev only)" style={{ marginTop: 28 }}>
          <SectionLabel>Demo sample workflow (dev only)</SectionLabel>
          <p style={{ color: "var(--muted)", marginTop: 6, fontSize: 12, display: "flex", alignItems: "center", gap: 10 }}>
            Made-up rows for trying out the workflow. Not real work, not counted above, and reset on refresh.
            <PreviewBadge label="Demo only" />
          </p>
          {sampleRows.length === 0 ? (
            <TableEmptyState title="No demo sample tasks" hint="Saved tasks from an approved funding plan show up here." />
          ) : (
            <TasksTable rows={sampleRows} canWrite={canWrite} variant="sample" />
          )}
        </section>
      ) : null}
    </>
  );
}
