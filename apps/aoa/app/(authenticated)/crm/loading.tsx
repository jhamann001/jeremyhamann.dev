import styles from "./page.module.css";

export default function CrmExplorerLoading() {
  return (
    <div aria-busy="true" aria-label="Loading CRM Explorer">
      <div className={styles.loadingEyebrow}>CRM relationship layer</div>
      <div className={styles.loadingTitle} />
      <div className={styles.loadingIntro} />
      <div className={styles.loadingStats}>
        {Array.from({ length: 4 }, (_, index) => (
          <div className={styles.loadingStat} key={index} />
        ))}
      </div>
      <div className={styles.loadingCard}>
        <div className={styles.loadingCardHeader} />
        {Array.from({ length: 5 }, (_, index) => (
          <div className={styles.loadingRow} key={index} />
        ))}
      </div>
      <span className={styles.srOnly}>Loading CRM records…</span>
    </div>
  );
}
