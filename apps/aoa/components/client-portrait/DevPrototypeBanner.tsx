import styles from "./DevPrototypeBanner.module.css";

export function DevPrototypeBanner() {
  return (
    <div className={styles.banner} role="note" aria-label="Development prototype notice">
      <span className={styles.mark} aria-hidden="true">DEV</span>
      <div>
        <strong>Prototype · synthetic sample data</strong>
        <p>
          Built for advisor review in development. Nothing on this page is an actual client result,
          recommendation, or communication.
        </p>
      </div>
    </div>
  );
}
