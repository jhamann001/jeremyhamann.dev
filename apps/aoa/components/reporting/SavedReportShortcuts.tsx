import Link from "next/link";
import type { SavedReportShortcut } from "@/lib/reporting/saved-reports";
import styles from "@/components/crm/ReportingViewTools.module.css";

export function SavedReportLinks({ reports }: { reports: readonly SavedReportShortcut[] }) {
  return reports.map(report => (
    <Link key={report.id} href={report.href} prefetch={false} className={styles.viewLink} title={report.description}>
      {report.label}
    </Link>
  ));
}

export function SavedReportShortcuts({ reports }: { reports: readonly SavedReportShortcut[] }) {
  if (reports.length === 0) return null;
  return (
    <section className={styles.tools} aria-label="Saved reports">
      <div className={styles.viewLane}>
        <span className={styles.laneLabel}>Saved reports</span>
        <div className={styles.viewLinks}><SavedReportLinks reports={reports} /></div>
      </div>
    </section>
  );
}
