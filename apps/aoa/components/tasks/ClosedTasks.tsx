import Link from "next/link";
import { Card, CardBody, Pill } from "@/components/ui";
import { TASK_STATUS_LABEL } from "@/components/workflow";
import { INACTIVE_REASON_LABEL } from "@/lib/data/decision-task-context";
import type { PersistedTaskView } from "./tasks-model";
import styles from "./ClosedTasks.module.css";

// Tasks that are no longer active work (ticket): partial-ACAT steps whose
// transfer's approved plan changed, the older excluded-positions records
// replaced on 2026-09-09, and unfinished tasks on archived transfers. Derived
// when the page loads; their stored status is untouched and shown as-is. They
// are listed apart from the working table and are never counted in the totals
// or filters. Wording stays neutral about who closed them, because the saved
// data cannot always tell. Read-only.
export function ClosedTasks({ rows }: { rows: PersistedTaskView[] }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardBody>
        <details className={styles.details}>
          <summary className={styles.summary}>
            No longer active · {rows.length}
            <span className={styles.hint}>Kept for reference. Not counted in the totals above.</span>
          </summary>
          <ul className={styles.list}>
            {rows.map((row) => {
              const reason = row.inactiveReason ? INACTIVE_REASON_LABEL[row.inactiveReason] : null;
              const { decision, transfer } = row.context;
              return (
                <li key={row.id} className={styles.item}>
                  <div className={styles.top}>
                    <strong>{row.desc}</strong>
                    {reason ? <Pill tone="gray">{reason.title}</Pill> : null}
                  </div>
                  <div className={styles.sub}>
                    {row.householdName} · {row.assignee.label} · Saved status: {TASK_STATUS_LABEL[row.status]}
                  </div>
                  {reason ? <div className={styles.sub}>{reason.detail}</div> : null}
                  {([["decision", decision], ["transfer", transfer]] as const).map(([key, view]) => view ? (
                    <div key={key} className={styles.sub}>
                      {view.kind === "link"
                        ? <Link href={view.href} className={styles.link}>{view.label}</Link>
                        : view.label}
                    </div>
                  ) : null)}
                </li>
              );
            })}
          </ul>
        </details>
      </CardBody>
    </Card>
  );
}
