import styles from "./CrmPreview.module.css";

export function CrmPreviewNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.notice} role="note">
      <div>
        <strong>Development prototype</strong>
        <p>{children}</p>
      </div>
      <span className={styles.eyebrow}>Synthetic data only</span>
    </div>
  );
}
