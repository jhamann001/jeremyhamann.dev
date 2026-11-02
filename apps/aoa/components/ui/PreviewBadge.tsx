import styles from "./PreviewBadge.module.css";

// Honest-placeholder label (TDD ADR-2). Every section fed by a mock fixture wears
// this pill so mock screens are never presented as data-complete.
export function PreviewBadge({ label = "Preview · sample data" }: { label?: string }) {
  return (
    <span className={styles.badge} aria-label={label}>
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </span>
  );
}
