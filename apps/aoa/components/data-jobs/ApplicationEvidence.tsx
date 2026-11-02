import type { JobApplicationEvidence } from "@/lib/data-jobs/application-evidence-types";
import { jobTimestamp } from "./presentation";
import styles from "./jobs.module.css";

const statuses = {
  COMPLETE: "Completed source snapshot", PROGRESSING: "Partial sweep progress", RUNNING: "Sweep page running",
  FAILED: "Application failure recorded", PARTIAL: "Partial application result", UNKNOWN: "Not verified",
};
const count = (value: number | null) => value === null ? "Not reported" : value.toLocaleString("en-US");

/** Source snapshots are intentionally outside the provider execution table. */
export function ApplicationEvidence({ evidence, stale = false }: { evidence: JobApplicationEvidence; stale?: boolean }) {
  const unavailable = evidence.coverage === "unavailable" || stale;
  return <section className={styles.applicationEvidence} aria-label="AOA source completion evidence">
    <h3>AOA source completion</h3>
    <p className={styles.coverage}>Source-level evidence only. This snapshot is not linked to a specific provider execution and does not change its success rate.</p>
    <dl className={styles.facts}>
      <div><dt>Latest application observation</dt><dd>{unavailable ? "Not currently verified" : statuses[evidence.status]}<small>{jobTimestamp(evidence.observedAt)}</small></dd></div>
      <div><dt>Last committed source result</dt><dd>{jobTimestamp(evidence.latestCommitAt)}<small>{evidence.sourceKey === "REVIEW_QUEUE" ? "Complete sweep across both sources; a completed page is not a complete sweep." : "Committed AUM snapshot, not proof of current mirror integrity."}</small></dd></div>
      <div><dt>Committed / rejected records</dt><dd>{count(evidence.recordsCommitted)} / {count(evidence.recordsRejected)}<small>Counts belong to the committed result above, not a provider attempt.</small></dd></div>
      <div><dt>Source business date</dt><dd>{evidence.businessAsOf ?? "Not reported"}</dd></div>
      <div><dt>Source freshness</dt><dd>{unavailable ? "Not currently verified" : evidence.freshness.status === "CURRENT" ? "Current at last check" : evidence.freshness.status === "STALE" ? "Stale at last check" : "Not verified"}<small>{evidence.freshness.basis === "committed_snapshot_date" ? "Calculated from committed snapshot date" : "Based on age of the last complete sweep"} · {jobTimestamp(evidence.freshness.checkedAt)}</small>{evidence.freshness.expectedBusinessAsOf && <small>Expected business date: {evidence.freshness.expectedBusinessAsOf}</small>}</dd></div>
      <div><dt>Last application failure</dt><dd>{jobTimestamp(evidence.lastFailureAt)}{evidence.lastFailureSource && <small>{evidence.lastFailureSource.replaceAll("_", " ")}</small>}</dd></div>
    </dl>
    {evidence.stages.length > 0 && <p className={styles.coverage}>{evidence.stages.map((stage) => `${stage.key.replaceAll("_", " ")}: ${stage.status.toLowerCase()} (${stage.basis === "last_completed_sweep" ? "last complete sweep" : "current checkpoint"})`).join(" · ")}</p>}
    {evidence.latestFeedWarning && <p className={styles.coverage}>Historical feed warning: {evidence.latestFeedWarning.code.replaceAll("_", " ")} · {jobTimestamp(evidence.latestFeedWarning.at)}. Only unhealthy checks are saved; this warning does not prove an ongoing failure or a verified recovery.</p>}
    {unavailable && <p className={styles.coverage}>Application evidence is unavailable or stale. Last-known timestamps are historical only.</p>}
  </section>;
}
