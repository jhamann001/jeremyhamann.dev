import type { FunnelStage } from "@/lib/data/types";
import styles from "./Funnel.module.css";

// Transfer-pipeline funnel bar (B1, TDD §6). One tone-accented segment per stage,
// showing count / stage / desc. Presentational server component — data comes from
// the `commandCenterData` seam: the mock fixture by default (labeled with a
// PreviewBadge on the page), or real app.deal counts when COMMAND_CENTER_FUNNEL_LIVE
// is on (badge dropped). Source-agnostic — unchanged either way.

const TONE_CLASS: Record<FunnelStage["tone"], string> = {
  green: styles.green,
  gold: styles.gold,
  blue: styles.blue,
  amber: styles.amber,
  red: styles.red,
};

export function Funnel({ stages }: { stages: FunnelStage[] }) {
  return (
    <div className={styles.funnel}>
      {stages.map((s) => (
        <div key={s.stage} className={`${styles.segment} ${TONE_CLASS[s.tone]}`}>
          <div className={styles.count}>{s.count}</div>
          <div className={styles.stage}>{s.stage}</div>
          <div className={styles.desc}>{s.desc}</div>
        </div>
      ))}
    </div>
  );
}
