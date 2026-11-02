import { Pill } from "@/components/ui";
import type { SlackCloseoutStatus } from "@/lib/data/transfers";
import styles from "./SlackCloseoutCard.module.css";

// Slack closeout card body (SLACK_TRANSFER_CLOSEOUT) — the full READ-ONLY
// per-item checklist, mirroring the Slack message layout (owner ask
// 2026-07-24: show the boxes, not just the count). Standalone items first,
// then grouped items under their group header ("Trade Instructions"); a row's
// `note` renders as a subscript, same as Slack. The checklist is completed IN
// SLACK — this is a mirror: no inputs, no click handlers, no actions. Server
// component; items arrive merged + display-ordered from getSlackCloseout.

export function SlackCloseoutCard({
  closeout,
}: {
  closeout: SlackCloseoutStatus;
}) {
  // Items arrive ordered standalone-first (template sort), so a group header
  // renders once, whenever a row's group differs from the previous row's.
  let prevGroup: string | undefined;

  return (
    <div className={styles.wrap}>
      <div>
        <Pill tone={closeout.status === "COMPLETE" ? "green" : "gray"}>
          {closeout.status === "COMPLETE" ? "Complete" : "In progress"}
        </Pill>
      </div>
      <ul className={styles.list}>
        {closeout.items.map((item) => {
          const header = item.group !== prevGroup ? item.group : undefined;
          prevGroup = item.group;
          return (
            <li key={item.item_key} className={styles.item}>
              {header && <p className={styles.groupHeader}>{header}</p>}
              <div className={item.group ? styles.rowGrouped : styles.row}>
                <span
                  className={item.done ? styles.markerDone : styles.markerTodo}
                  aria-hidden="true"
                >
                  {item.done ? "✓" : ""}
                </span>
                <span className={styles.text}>
                  <span className={styles.label}>
                    {item.label}
                    <span className={styles.srOnly}>
                      {item.done ? " — done" : " — not done"}
                    </span>
                  </span>
                  {item.note && <span className={styles.note}>{item.note}</span>}
                  {item.done && (item.done_by || item.done_at) && (
                    <span className={styles.doneMeta}>
                      {item.done_by}
                      {item.done_by && item.done_at ? " · " : ""}
                      {item.done_at
                        ? new Date(item.done_at).toLocaleDateString()
                        : ""}
                    </span>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className={styles.summary}>
        Completed in Slack — {closeout.done} of {closeout.total}{" "}
        {closeout.total === 1 ? "item" : "items"} done.
      </p>
    </div>
  );
}
