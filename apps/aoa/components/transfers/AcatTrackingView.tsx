import type { AcatTracking } from "@/lib/data/acat-tracking";
import { Card, Kpi } from "@/components/ui";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import { AcatTrackingList } from "./AcatTrackingList";
import styles from "./AcatTrackingData.module.css";

export function AcatTrackingView({ groups, summary, sourceCheckedAt, onUnlinked, onUnlinkError }: AcatTracking & {
  sourceCheckedAt?: number;
  onUnlinked?: () => void;
  onUnlinkError?: (message: string) => void;
}) {
  return <>
    <div className={styles.kpis}>
      <Card><Kpi label="Total records" value={summary.total} caption={`${summary.linked} linked · ${summary.unlinked} un-linked`} /></Card>
      <Card><Kpi label="In flight" value={summary.inFlight} caption="ACATs in flight" /></Card>
      <Card><Kpi label="Needs attention" value={summary.needsAttention} caption="Exception or position mismatch" /></Card>
      <Card><Kpi label="Completed" value={summary.completed} caption="Recently settled" /></Card>
    </div>
    <div className={styles.trackerLinkRow}>
      <a href={EXTERNAL_APPS.acatTracking} target="_blank" rel="noopener noreferrer" className={styles.trackerLink}>Open full tracker ↗</a>
    </div>
    <AcatTrackingList groups={groups} sourceCheckedAt={sourceCheckedAt} onUnlinked={onUnlinked} onUnlinkError={onUnlinkError} />
  </>;
}
