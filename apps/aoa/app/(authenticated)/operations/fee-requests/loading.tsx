import { SectionLabel } from "@/components/ui";
import styles from "./page.module.css";

export default function OperationsFeeRequestsLoading() {
  return (
    <div aria-busy="true" aria-label="Opening Fee Credits and Service Guarantees">
      <span className={styles.back}>← Operations Tools</span>
      <SectionLabel>Operations · Fee credits &amp; service guarantees</SectionLabel>
      <div className={styles.loadingTitle} />
      <div className={styles.loadingNotice} />
      <div className={styles.loadingStats}>
        <span /><span /><span /><span />
      </div>
      <div className={styles.loadingCard} />
    </div>
  );
}
