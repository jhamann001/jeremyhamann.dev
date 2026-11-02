import type { TransferOpsStats } from "@/lib/data/transfers";
import { usdCompact } from "@/lib/format";
import styles from "./TransferOpsBar.module.css";

// The board's ops status bar (mockup `.opsbar`, WO ticket). Server-safe (no
// state). Every number is REAL — SQL-aggregated by `transferOpsStats` in the
// same user scope as the board rows, so the pills always equal the cards' sums
// by construction (the deals KPI idiom). The mockup's hard-coded `$38M · 27`
// is deliberately NOT reproduced (fabricated-number rule); the bouncing pill
// renders the real count even when it is 0.
export function TransferOpsBar({ stats }: { stats: TransferOpsStats }) {
  return (
    <div className={styles.bar}>
      <span className={styles.pill}>
        <b>{usdCompact(stats.outstanding)}</b>&nbsp;outstanding ·{" "}
        {stats.active} active transfers
      </span>
      <span className={`${styles.pill} ${styles.red}`}>
        <span className={styles.dot} aria-hidden="true" />
        <b>{stats.bouncing}</b>&nbsp;bouncing back to the advisor
      </span>
    </div>
  );
}
