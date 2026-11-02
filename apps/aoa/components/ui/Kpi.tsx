import type { ReactNode } from "react";
import styles from "./Kpi.module.css";

export function Kpi({
  label,
  value,
  delta,
  direction,
  caption,
}: {
  label: string;
  value: ReactNode;
  delta?: string;
  direction?: "up" | "down";
  // Neutral, muted sub-line for a breakdown/note (NOT an up/down movement — use
  // `delta` for that, which carries the green/red directional styling).
  caption?: string;
}) {
  return (
    <div className={styles.kpi}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {delta && (
        <div className={`${styles.delta} ${direction === "down" ? styles.down : styles.up}`}>{delta}</div>
      )}
      {caption && <div className={styles.caption}>{caption}</div>}
    </div>
  );
}
