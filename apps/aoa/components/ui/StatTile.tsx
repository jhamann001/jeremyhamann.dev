import type { ReactNode } from "react";
import type { StatusTone } from "./Pill";
import styles from "./StatTile.module.css";

// Compact stat (label + value), token-styled. Complements the larger Kpi tile
// for dense secondary metrics (TDD §5). `tone` adds a status accent.
export function StatTile({
  label,
  value,
  caption,
  tone,
}: {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div className={tone ? `${styles.tile} ${styles[tone]}` : styles.tile} data-tone={tone}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {caption ? <div className={styles.caption}>{caption}</div> : null}
    </div>
  );
}
