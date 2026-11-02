"use client";

import { Button, Pill } from "@/components/ui";
import type { JobHistoryResponse, JobRun, JobSummary } from "@/lib/data-jobs/contracts";
import { durationLabel, jobTimestamp, jobTone, nextRunLabel, statusLabel, successRateLabel } from "./presentation";
import styles from "./jobs.module.css";
import { ApplicationEvidence } from "./ApplicationEvidence";
import { applicationAttention } from "@/lib/data-jobs/application-attention";
import { isApplicationEvidenceStale } from "@/lib/data-jobs/application-evidence-validation";

type HistoryState = { data: JobHistoryResponse | null; loading: boolean; error: boolean; limited: boolean };

function Count({ value }: { value: number | null }) {
  return <>{value === null ? "Not reported" : value.toLocaleString("en-US")}</>;
}

export function JobRunTable({ runs }: { runs: JobRun[] }) {
  return (
    <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Execution history, scroll horizontally for all columns">
      <table className={styles.runTable}>
        <caption>Observed executions and attempts · newest first</caption>
        <thead><tr><th scope="col">Execution / evidence</th><th scope="col">Result</th><th scope="col">Started / finished</th><th scope="col">Duration</th><th scope="col">Records</th><th scope="col">Retry evidence</th></tr></thead>
        <tbody>{runs.map((run) => (
          <tr key={run.id}>
            <td>
              {run.executionUrl ? <a href={run.executionUrl} target="_blank" rel="noopener noreferrer">Open execution ↗<span className={styles.srOnly}> {run.id} in a new tab</span></a> : <span>Execution link unavailable</span>}
              <small>{run.evidence === "application_commit" ? "AOA committed result" : run.evidence === "delivery_only" ? "Delivery only · import unconfirmed" : "Provider execution · import unconfirmed"}</small>
              {run.code && <code>{run.code}</code>}
            </td>
            <td><Pill tone={jobTone(run.status)} dot>{statusLabel(run.status)}</Pill></td>
            <td><span>{jobTimestamp(run.startedAt)}</span><small>End: {jobTimestamp(run.finishedAt)}</small>{!run.startedAt && <small>Observed: {jobTimestamp(run.observedAt)}</small>}</td>
            <td>{durationLabel(run.durationMs)}</td>
            <td><span><Count value={run.recordsProcessed} /> processed</span><small><Count value={run.recordsRejected} /> rejected</small></td>
            <td>{run.retryOf ? "Linked retry" : run.correlation === "exact" ? "Correlated run" : "Not correlated"}<small>{run.correlation === "exact" ? "Provider-linked logical run" : "Do not infer a logical run or retry from this event."}</small></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function JobCard({ job, expanded, onToggle, history, onRetryHistory, onMoreHistory }: {
  job: JobSummary;
  expanded: boolean;
  onToggle: () => void;
  history: HistoryState;
  onRetryHistory: () => void;
  onMoreHistory: () => void;
}) {
  const definition = job.definition;
  const observation = job.observation;
  const schedule = observation?.schedule;
  const panelId = `job-panel-${definition.id}`;
  const headingId = `job-heading-${definition.id}`;
  const coverage = observation?.coverage;
  const deliveryOnly = definition.provider === "cloud-scheduler";
  const attention = applicationAttention(job, new Date());
  const applicationStale = job.applicationEvidenceStale || (!!job.applicationEvidence && isApplicationEvidenceStale(job.applicationEvidence, new Date()));
  const activeIncidents = job.incidents.filter((incident) => !incident.resolvedAt);
  const showWake = observation?.enabled !== false && schedule?.kind === "scheduled" && !schedule.nextRunAt && !!schedule.nextWakeAt;

  return (
    <section className={styles.jobCard} data-status={job.status} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.cardHeading}>
        <button type="button" className={styles.cardToggle} onClick={onToggle} aria-expanded={expanded} aria-controls={expanded ? panelId : undefined}>
          <span className={styles.identity}><span className={styles.jobName}>{definition.name}</span><span className={styles.source}>{definition.source} · {definition.provider === "n8n" ? "n8n" : "Cloud Scheduler"} · {definition.environment.toUpperCase()}</span></span>
          <span className={styles.summaryTime}><span>Last observed start</span><strong>{jobTimestamp(job.latestRun?.startedAt)}</strong></span>
          <span className={styles.summaryTime}><span>{showWake ? "Next wake · run or retry" : "Next scheduled run"}</span><strong>{showWake ? jobTimestamp(schedule?.nextWakeAt, schedule?.timezone ?? "UTC") : nextRunLabel(schedule, observation?.enabled)}</strong></span>
          <span className={styles.badges}><Pill tone={jobTone(job.status)} dot>{statusLabel(job.status)}</Pill>{job.monitoringStale && <Pill tone="amber">Monitoring stale</Pill>}{attention && <Pill tone={attention.tone}>{attention.label}</Pill>}</span>
          <span className={styles.chevron} aria-hidden="true">{expanded ? "−" : "+"}</span>
        </button>
      </h2>
      {expanded && <div id={panelId} className={styles.cardDetails}>
        <p className={styles.reason}>{job.reason}</p>
        <ol className={styles.flow} aria-label="Data journey">
          {[{ label: "Source", value: definition.source }, { label: "Trigger", value: definition.trigger }, { label: "Runs in", value: definition.runner }, { label: "AOA destination", value: definition.destination }].map((item) => <li key={item.label}><span>{item.label}</span><strong>{item.value}</strong></li>)}
        </ol>
        <div className={styles.detailGrid}>
          <dl className={styles.facts}>
            <div><dt>Used by</dt><dd>{definition.consumers.join(" · ") || "Not documented"}</dd></div>
            <div><dt>Owner</dt><dd>{definition.owner}</dd></div>
            <div><dt>Schedule</dt><dd>{schedule?.kind === "scheduled" ? <code>{schedule.expression ?? "Expression unavailable"}</code> : schedule?.kind === "manual" ? "Manual / on demand" : schedule?.kind === "event" ? "Event-driven" : "Not observed"}{schedule?.timezone && <small>{schedule.timezone}</small>}</dd></div>
            <div><dt>Next scheduled run</dt><dd>{nextRunLabel(schedule, observation?.enabled)}<small>{schedule?.nextRunBasis === "provider" ? "Reported by the provider" : schedule?.nextRunBasis === "calculated" ? "Calculated expectation, not a guaranteed start" : "No authoritative next-run timestamp"}</small></dd></div>
            <div><dt>Next retry</dt><dd>{schedule?.nextRetryAt ? jobTimestamp(schedule.nextRetryAt, schedule.timezone ?? "UTC") : "Not reported"}</dd></div>
            {schedule?.nextWakeAt && <div><dt>Next provider wake (schedule or retry)</dt><dd>{jobTimestamp(schedule.nextWakeAt, schedule.timezone ?? "UTC")}<small>Reported by the provider; a scheduled run and a retry cannot be distinguished.</small></dd></div>}
            <div><dt>Monitoring last observed</dt><dd>{jobTimestamp(observation?.observedAt)}{job.monitoringStale && <small>Job health may have changed since this observation.</small>}</dd></div>
            <div><dt>Last successful execution</dt><dd>{jobTimestamp(job.lastSuccessAt)}</dd></div>
            <div><dt>Last failed execution</dt><dd>{jobTimestamp(job.lastFailureAt)}</dd></div>
          </dl>
          <div className={styles.statsPanel}>
            <h3>{deliveryOnly ? "Observed delivery window" : "Observed execution window"}</h3>
            <p className={styles.window}>{jobTimestamp(job.stats.windowStart)} — {jobTimestamp(job.stats.windowEnd)}</p>
            <dl className={styles.stats}>
              <div><dt>Executions</dt><dd>{deliveryOnly ? "Not correlated" : job.stats.executions.toLocaleString("en-US")}</dd></div>
              <div><dt>Succeeded</dt><dd>{deliveryOnly ? "Not verified" : job.stats.succeeded.toLocaleString("en-US")}</dd></div>
              <div><dt>Failed</dt><dd>{deliveryOnly ? "Not correlated" : job.stats.failed.toLocaleString("en-US")}</dd></div>
              <div><dt>Delivery acknowledged</dt><dd>{job.stats.acknowledged.toLocaleString("en-US")}</dd></div>
              {deliveryOnly && <div><dt>Failed delivery events</dt><dd>{job.stats.deliveryFailed === undefined ? "Not recorded" : job.stats.deliveryFailed.toLocaleString("en-US")}</dd></div>}
              <div><dt>Running</dt><dd>{deliveryOnly ? "Not verified" : job.stats.running.toLocaleString("en-US")}</dd></div>
              <div><dt>Execution success rate</dt><dd>{deliveryOnly ? "Not available" : successRateLabel(job.stats.successRate)}</dd></div>
            </dl>
            <p className={styles.coverage}>{job.stats.rateLabel}</p>
            {deliveryOnly && <p className={styles.coverage}>Scheduler logs count delivery events, not correlated executions. A delivery failure is recorded separately from an unverified import result.</p>}
            <p className={styles.coverage}><b>Coverage:</b> {coverage === "complete_window" ? "Provider-reported window complete." : coverage === "partial" ? deliveryOnly ? "Partial delivery history; only observed event counts are shown. Execution success rate is unavailable." : "Partial history; only observed execution counts are shown. Success rate is unavailable." : "Unavailable; missing evidence does not mean there were no runs."} Provider success or delivery acknowledgement alone does not prove data was committed to AOA.</p>
          </div>
        </div>
        {job.applicationEvidence && <ApplicationEvidence evidence={job.applicationEvidence} stale={applicationStale} />}
        {!job.applicationEvidence && job.applicationEvidenceStale && <p className={styles.coverage}>AOA source evidence could not be verified. Provider history remains available separately.</p>}
        <div className={styles.cardLinks}>
          <a href={definition.jobUrl} target="_blank" rel="noopener noreferrer">Open workflow / job ↗<span className={styles.srOnly}> in a new tab</span></a>
          {definition.runbookUrl && <a href={definition.runbookUrl} target="_blank" rel="noopener noreferrer">Open runbook ↗<span className={styles.srOnly}> in a new tab</span></a>}
          <a href="/data-health">Check source freshness →</a>
        </div>
        <div className={styles.incidents}>
          <h3>Incidents <span>{activeIncidents.length} open</span></h3>
          {job.incidents.length ? <ul>{job.incidents.map((incident, index) => <li key={`${incident.kind}-${incident.openedAt}-${index}`}><b>{incident.kind.replaceAll("_", " ")}</b> · opened {jobTimestamp(incident.openedAt)} · {incident.resolvedAt ? `recovered ${jobTimestamp(incident.resolvedAt)}` : "open"}</li>)}</ul> : <p>No recorded incidents. This is not proof of uninterrupted health.</p>}
          <p>Slack delivery is disabled and not configured. Incident detection here is not an external alert.</p>
        </div>
        <div className={styles.historyHeading}><h3>Execution history</h3><Button variant="ghost" size="sm" onClick={onRetryHistory} disabled={history.loading}>Refresh history</Button></div>
        {history.error && <p className={styles.inlineError} role="alert">Execution history could not be refreshed. {history.data ? "Previously loaded history is shown. " : ""}<button type="button" onClick={onRetryHistory} disabled={history.loading}>Try again</button></p>}
        {history.loading && !history.data && <p className={styles.muted} role="status">Loading recorded executions…</p>}
        {history.data && history.data.runs.length === 0 && <p className={styles.muted}>No executions were recorded in the available history. This does not establish that the job has never run.</p>}
        {history.data && history.data.runs.length > 0 && <JobRunTable runs={history.data.runs} />}
        {history.data?.nextCursor && !history.limited && <Button variant="ghost" size="sm" onClick={onMoreHistory} disabled={history.loading}>{history.loading ? "Loading…" : "Load older executions"}</Button>}
        {history.limited && <p className={styles.muted}>Showing up to 75 recent executions. Open the provider job for older history.</p>}
      </div>}
    </section>
  );
}
