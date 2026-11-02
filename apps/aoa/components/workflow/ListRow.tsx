import type { ReactNode } from "react";
import type { PillTone } from "@/components/ui";
import styles from "./ListRow.module.css";

// The shared `.rem` row grammar (TDD cross-screen patterns): a status-tinted icon
// slot + main content + a right-side action cluster. Every Workflow list row
// (decisions, nudge queue, etc.) is an instance of this. Server-safe (no state).
export function ListRow({
  tone = "gray",
  icon,
  children,
  actions,
}: {
  tone?: PillTone;
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={`${styles.icon} ${styles[tone]}`} aria-hidden={!icon}>
        {icon}
      </div>
      <div className={styles.main}>{children}</div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
