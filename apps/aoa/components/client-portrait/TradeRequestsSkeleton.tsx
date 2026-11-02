import { Card } from "@/components/ui";
import styles from "./TradeRequestsCard.module.css";

// Suspense fallback for <TradeRequestsSection>. Mirrors the card's shell (titled
// compact header) so the portrait reserves the collapsed card height and
// doesn't jump when the live panel streams in. Purely presentational — no data,
// no fetch.

const bar = (w: number | string): React.CSSProperties => ({
  height: 12,
  width: w,
  borderRadius: 4,
  background: "var(--border)",
  opacity: 0.6,
});

export function TradeRequestsSkeleton() {
  return (
    <Card>
      <div className={`${styles.summary} ${styles.skeletonSummary}`}>
        <div className={styles.titleGroup}>
          <span className={styles.eyebrow}>
            Trade requests · from Trade-Request app
          </span>
          <h2 className={styles.title}>Trade requests</h2>
        </div>
        <span className={styles.skeletonCount} style={bar(72)} aria-hidden />
        <span className={styles.srOnly}>Loading trade requests…</span>
      </div>
    </Card>
  );
}
