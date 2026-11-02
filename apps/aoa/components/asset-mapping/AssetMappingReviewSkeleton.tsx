import styles from "./AssetMappingReviewSkeleton.module.css";

// Suspense fallback for <AssetMappingReviewData>. Reserves height for the
// summary line + a couple of household review cards so the page doesn't jump
// when the live queue streams in. Purely presentational — no data, no fetch.

export function AssetMappingReviewSkeleton() {
  return (
    <div aria-hidden>
      <div className={`${styles.shimmer} ${styles.summary}`} />
      <div className={styles.cards}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className={styles.card}>
            <div className={`${styles.shimmer} ${styles.head}`} />
            <div className={`${styles.shimmer} ${styles.body}`} />
          </div>
        ))}
      </div>
      <span className={styles.srOnly}>Loading review queue…</span>
    </div>
  );
}
