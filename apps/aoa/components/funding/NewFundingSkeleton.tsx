import { Card, CardHeader, CardBody, SectionLabel } from "@/components/ui";
import styles from "./NewFundingSkeleton.module.css";

// Suspense fallback for the New Funding card. Mirrors NewFundingCard's shell
// (titled card header + 3 method tiles + YTD callout) so the
// Core Financial layout reserves the right height and doesn't jump when the
// real, data-backed card streams in. Purely presentational — no data, no fetch.

export function NewFundingSkeleton() {
  return (
    <Card>
      <CardHeader>
        <div>
          <SectionLabel>New Funding · Trailing 12 Months</SectionLabel>
          <h2 className={styles.title}>External Cash Funding</h2>
        </div>
      </CardHeader>
      <CardBody>
        <div className={styles.methodGrid} aria-hidden>
          <div className={`${styles.shimmer} ${styles.tile}`} />
          <div className={`${styles.shimmer} ${styles.tile}`} />
          <div className={`${styles.shimmer} ${styles.tile}`} />
        </div>
        <div className={`${styles.shimmer} ${styles.ytd}`} aria-hidden />
        <span className={styles.srOnly}>Loading new funding…</span>
      </CardBody>
    </Card>
  );
}
