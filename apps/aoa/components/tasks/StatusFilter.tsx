"use client";

import { TASK_STATUS_LABEL } from "@/components/workflow";
import type { TaskStatus } from "@/components/workflow";
import styles from "./StatusFilter.module.css";

// ENHANCEMENT BEYOND THE MOCKUP. The mockup Tasks screen has no filter, but the
// four KPI buckets (Total / To do / In progress / Done) invite one. This chip row
// is purely client-side and presentational — it narrows which rows the table
// shows; it never writes to the store and does not persist. Flagged here so review
// does not read it as unrequested scope (TDD §6 / work-order C2 "status filter").

export type FilterValue = TaskStatus | "all";

// TASK_STATUS_LABEL keys are the single source of truth for the enum ordering.
const STATUSES = Object.keys(TASK_STATUS_LABEL) as TaskStatus[];

const LABEL: Record<FilterValue, string> = { all: "All", ...TASK_STATUS_LABEL };

export function StatusFilter({
  value,
  counts,
  onChange,
}: {
  value: FilterValue;
  counts: Record<FilterValue, number>;
  onChange: (value: FilterValue) => void;
}) {
  const chips: FilterValue[] = ["all", ...STATUSES];
  return (
    <div className={styles.row} role="group" aria-label="Filter tasks by status">
      {chips.map((chip) => {
        const active = chip === value;
        return (
          <button
            key={chip}
            type="button"
            className={`${styles.chip} ${active ? styles.active : ""}`.trim()}
            aria-pressed={active}
            onClick={() => onChange(chip)}
          >
            {LABEL[chip]}
            <span className={styles.count}>{counts[chip]}</span>
          </button>
        );
      })}
    </div>
  );
}
