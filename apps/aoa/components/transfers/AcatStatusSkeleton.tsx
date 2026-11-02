import { Card, CardHeader, CardBody } from "@/components/ui";
import styles from "./AcatStatusSkeleton.module.css";

// Suspense fallback for <AcatStatusSection>. Mirrors AcatStatusCard's shell
// (titled header + a facts grid + a few asset rows) so the detail layout
// reserves height and doesn't jump when the live status streams in. Purely
// presentational — no data, no fetch.

export function AcatStatusSkeleton() {
  return (
    <Card>
      <CardHeader>
        <div>
          <span className={styles.eyebrow}>Live ACAT status · from tracker</span>
          <div className={`${styles.shimmer} ${styles.title}`} aria-hidden />
        </div>
        <div className={`${styles.shimmer} ${styles.pill}`} aria-hidden />
      </CardHeader>
      <CardBody>
        <div className={styles.facts} aria-hidden>
          <div className={`${styles.shimmer} ${styles.fact}`} />
          <div className={`${styles.shimmer} ${styles.fact}`} />
          <div className={`${styles.shimmer} ${styles.fact}`} />
          <div className={`${styles.shimmer} ${styles.fact}`} />
        </div>
        <div className={styles.rows} aria-hidden>
          <div className={`${styles.shimmer} ${styles.row}`} />
          <div className={`${styles.shimmer} ${styles.row}`} />
          <div className={`${styles.shimmer} ${styles.row}`} />
        </div>
        <span className={styles.srOnly}>Loading ACAT status…</span>
      </CardBody>
    </Card>
  );
}
