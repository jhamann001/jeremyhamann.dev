import styles from "./TableEmptyState.module.css";

// Centered muted prompt shown when the Tasks table has no rows to render — either
// no tasks exist yet, or the active status filter matched none. Server-safe (no
// state). Generic on purpose (title + hint) so both call-sites reuse it.
export function TableEmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.title}>{title}</div>
      <div className={styles.hint}>{hint}</div>
    </div>
  );
}
