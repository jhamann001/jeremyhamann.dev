import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { Card, CardBody, CardHeader, PageHeader, Pill, StatTile, SummaryGrid } from "@/components/ui";
import { dataHealthEnabled, dataJobMonitoringEnabled } from "@/lib/flags";
import {
  canViewSourceHealth,
  getSourceHealth,
  type SourceHealthRow,
} from "@/lib/data/source-health";
import {
  formatOperationalTimestamp,
  formatSourceBusinessDate,
  type SourceHealthStatus,
} from "@/lib/data/source-health-evaluation";
import styles from "./page.module.css";

function tone(status: SourceHealthStatus): "green" | "red" | "amber" | "gray" {
  if (status === "HEALTHY") return "green";
  if (status === "ATTENTION") return "red";
  if (status === "UNKNOWN" || status === "AVAILABLE") return "amber";
  return "gray";
}

function statusLabel(status: SourceHealthStatus): string {
  if (status === "AVAILABLE") return "Available now";
  return status.toLowerCase().replace(/^\w/, (value) => value.toUpperCase());
}

function SourceCard({ row }: { row: SourceHealthRow }) {
  const snapshotAt = row.latestSuccessAt ?? row.availabilityCheckedAt ?? row.lastAttemptAt;
  const snapshotLabel = row.latestSuccessAt
    ? row.latestSuccessLabel ?? "Latest completed success"
    : row.availabilityCheckedAt
      ? "Availability checked"
      : row.lastAttemptAt
        ? row.lastAttemptLabel ?? "Last attempted run"
        : "Latest evidence";

  return (
    <Card className={styles.sourceCard} data-status={row.status}>
      <CardBody className={styles.sourceBody}>
        <details className={styles.sourceDetails}>
          <summary className={styles.sourceSummary}>
            <div className={styles.sourceIdentity}>
              <h2>{row.label}</h2>
              <p>{row.statusReason}</p>
            </div>
            <div className={styles.snapshot}>
              <span>{snapshotLabel}</span>
              <b>{snapshotAt ? formatOperationalTimestamp(snapshotAt) : "Not recorded"}</b>
            </div>
            <Pill tone={tone(row.status)} dot>{statusLabel(row.status)}</Pill>
            <span className={styles.chevron} aria-hidden="true">⌄</span>
          </summary>
          <div className={styles.expandedEvidence}>
            <p className={styles.provenance}><b>Source:</b> {row.source}</p>
            <p className={styles.coverage}><b>Monitoring coverage:</b> {row.coverage}</p>
            {row.metrics && row.metrics.length > 0 && (
              <dl className={styles.metrics}>
                {row.metrics.map((metric) => (
                  <div key={metric.label} data-tone={metric.tone ?? "neutral"}>
                    <dt>{metric.label}</dt>
                    <dd>{metric.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <dl className={styles.evidence}>
              <div>
                <dt>Source business as-of</dt>
                <dd>{row.businessAsOf ? formatSourceBusinessDate(row.businessAsOf) : "Not published"}</dd>
                {row.expectedBusinessAsOf && (
                  <small>Expected at least {formatSourceBusinessDate(row.expectedBusinessAsOf)}</small>
                )}
              </div>
              <div>
                <dt>{row.latestSuccessLabel ?? "Latest completed success"}</dt>
                <dd>{row.latestSuccessAt ? formatOperationalTimestamp(row.latestSuccessAt) : "Not recorded"}</dd>
              </div>
              <div>
                <dt>{row.lastAttemptLabel ?? "Last attempted run"}</dt>
                <dd>{row.lastAttemptAt ? formatOperationalTimestamp(row.lastAttemptAt) : "Not recorded"}</dd>
              </div>
              <div>
                <dt>Latest recorded failure or issue</dt>
                <dd>{row.lastFailureAt ? formatOperationalTimestamp(row.lastFailureAt) : "No durable record"}</dd>
              </div>
              {row.availabilityCheckedAt && (
                <div>
                  <dt>Live availability checked</dt>
                  <dd>{formatOperationalTimestamp(row.availabilityCheckedAt)}</dd>
                </div>
              )}
            </dl>
            <p className={styles.detail}>{row.detail}</p>
            <p className={styles.limit}><b>Evidence limit:</b> {row.attemptEvidence}</p>
            {row.actionHref && row.actionLabel && (
              <Link className={styles.action} href={row.actionHref} prefetch={false}>
                {row.actionLabel} →
              </Link>
            )}
          </div>
        </details>
      </CardBody>
    </Card>
  );
}

export default async function DataHealthPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  if (!dataHealthEnabled() || !canViewSourceHealth(role)) notFound();

  const result = await getSourceHealth({
    role,
    email: session.user.email ?? null,
  });
  if (!result.ok) notFound();

  const count = (status: SourceHealthStatus) =>
    result.rows.filter((row) => row.status === status).length;

  return (
    <>
      <PageHeader
        eyebrow="Admin · operations"
        title="Data health"
        description="Source dates and run evidence are shown separately. Missing metadata stays unknown rather than being inferred from client records."
        actions={dataJobMonitoringEnabled()
          ? <Link href="/data-health/jobs" prefetch={false}>Data sources & jobs →</Link>
          : <Pill tone="green">PII-free operational metadata</Pill>}
      />

      <SummaryGrid>
        <StatTile label="Healthy" value={count("HEALTHY")} />
        <StatTile label="Needs attention" value={count("ATTENTION")} />
        <StatTile label="Unknown" value={count("UNKNOWN")} />
        <StatTile label="Available now" value={count("AVAILABLE")} />
      </SummaryGrid>

      {result.warnings.length > 0 && (
        <Card className={styles.warning}>
          <CardBody>
            <h2>Some operational evidence could not be read</h2>
            <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </CardBody>
        </Card>
      )}

      <p className={styles.generated}>Evaluated {formatOperationalTimestamp(result.generatedAt)}</p>
      <div className={styles.grid}>
        {result.rows.map((row) => <SourceCard key={row.key} row={row} />)}
      </div>

      <Card className={styles.definitions}>
        <CardHeader><h2>How to read this page</h2></CardHeader>
        <CardBody>
          <ul>
            <li><b>Source business as-of</b> is the date the source says the data represents. It is not the time AOA loaded it.</li>
            <li><b>Latest completed success</b> is durable evidence that a full committed operation finished.</li>
            <li><b>Attempt, failure, and issue</b> appear only when the workflow persists that evidence. “Not recorded” or “No durable record” does not prove no attempt or failure occurred.</li>
            <li><b>Needs attention</b> means the latest durable success is old, a newer failure exists, a run appears stalled, or AUM’s source-date check is stale.</li>
            <li><b>Available now</b> means a PII-free live query succeeded, but complete freshness evidence is unavailable.</li>
          </ul>
        </CardBody>
      </Card>
    </>
  );
}
