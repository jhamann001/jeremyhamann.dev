import { StatTile } from "@/components/ui";
import {
  STAGE_ORDER,
  stageLabel,
  type DealStage,
} from "@/lib/data/deal-types";
import type { DealPipelineKpi } from "@/lib/data/deals";
import styles from "./DealsKpiRow.module.css";

// One tile per stage in pipeline order (POTENTIAL → COMMITTED → FUNDING → WON →
// LOST), each showing `count · $total` straight from dealPipelineKpis — real
// SQL-aggregated numbers, never fabricated (TDD §6). Server-safe (no state):
// the seam already coerced Decimals, and missing stages zero-fill here (the
// GROUP BY only returns stages present).

const usd = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

export function DealsKpiRow({ kpis }: { kpis: DealPipelineKpi[] }) {
  const byStage = new Map<DealStage, DealPipelineKpi>(
    kpis.map((k) => [k.stage, k]),
  );
  return (
    <div className={styles.row}>
      {STAGE_ORDER.map((stage) => {
        const k = byStage.get(stage);
        return (
          <StatTile
            key={stage}
            label={stageLabel(stage)}
            value={`${k?.count ?? 0} · ${usd(k?.totalAmount ?? 0)}`}
          />
        );
      })}
    </div>
  );
}
