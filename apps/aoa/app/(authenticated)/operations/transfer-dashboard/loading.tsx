import styles from "@/components/operations/AcatTransferDashboard.module.css";

export default function TransferDashboardLoading() {
  return (
    <div aria-busy="true" className={styles.loading}>
      <p>Loading transfer dashboard…</p>
    </div>
  );
}
