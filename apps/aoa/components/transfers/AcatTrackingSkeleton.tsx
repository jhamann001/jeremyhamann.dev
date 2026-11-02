import styles from "./AcatTrackingSkeleton.module.css";

// Suspense fallback for <AcatTrackingData>. Mirrors the summary KPI row + a
// couple of grouped-list sections so the page reserves height and doesn't jump
// when the live list streams in. Purely presentational — no data, no fetch.

export function AcatTrackingSkeleton() {
  return (
    <div aria-hidden>
      <div className={styles.kpis}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={`${styles.shimmer} ${styles.kpi}`} />
        ))}
      </div>
      <div className={styles.groups}>
        {Array.from({ length: 2 }).map((_, g) => (
          <div key={g} className={styles.group}>
            <div className={`${styles.shimmer} ${styles.head}`} />
            {Array.from({ length: 3 }).map((_, r) => (
              <div key={r} className={`${styles.shimmer} ${styles.row}`} />
            ))}
          </div>
        ))}
      </div>
      <span className={styles.srOnly}>Loading ACAT records…</span>
    </div>
  );
}
