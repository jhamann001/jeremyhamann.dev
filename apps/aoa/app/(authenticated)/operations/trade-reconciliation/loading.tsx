import { SectionLabel } from "@/components/ui";
import styles from "./page.module.css";

export default function TradeReconciliationLoading() {
  return (
    <div aria-busy="true" aria-label="Opening Trade Reconciliation">
      <span className={styles.back}>← Operations Tools</span>
      <SectionLabel>Operations · Trade reconciliation</SectionLabel>
      <div className={styles.loadingTitle} />
      <div className={styles.loadingPanel} />
      <div className={styles.loadingGrid}>
        <span /><span /><span /><span />
      </div>
    </div>
  );
}
