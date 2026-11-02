import "server-only";
import { randomUUID } from "node:crypto";
import { withUserScope, type Identity } from "@/lib/rls";
import type { JobDefinition, JobEnvironment, JobHistoryResponse, JobIncident, JobListResponse, JobObservation, JobRun, JobSummary } from "./contracts";
import { getDataJobs } from "./registry";
import { HISTORY_WINDOW_MS, MONITOR_STALE_MS, incidentKinds, nextExpectedDue, observationUnavailable, runTime, summarizeJob } from "./evaluation";
import { validateObservation, validateProviderCheckpoint } from "./validation";
import type { N8nCollectionState } from "./providers/n8n-coverage";
import type { JobApplicationEvidence } from "./application-evidence-types";
import { applicationSourceForJob } from "./application-evidence-association";
import { applicationEvidenceForDisplay, validateApplicationEvidence } from "./application-evidence-validation";
import { applicationAttention } from "./application-attention";
import { dataHealthEnabled, dataJobMonitoringEnabled } from "@/lib/flags";
import { appWritesPaused } from "@/lib/maintenance";

export const JOB_WORKER: Identity = { role: "OPERATIONS", email: "data-job-collector@system" };
const TX_OPTIONS = { timeout: 20_000, maxWait: 3_000 };
export function jobEnvironment(): JobEnvironment | null {
  return process.env.APP_ENV === "prod" ? "prod" : process.env.APP_ENV === "dev" ? "dev" : null;
}
export function canReadJobs(identity: Identity): boolean {
  return dataHealthEnabled() && dataJobMonitoringEnabled() && Boolean(identity.email?.trim())
    && ["ADMIN", "OPERATIONS"].includes(identity.role ?? "");
}

export async function claimCollection(environment: JobEnvironment, now: Date): Promise<string | null> {
  if (appWritesPaused()) return null;
  const token = randomUUID();
  return withUserScope(JOB_WORKER, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ lease_token: string }>>`
      INSERT INTO app.data_job_collector(environment, lease_token, lease_until)
      VALUES (${environment}, ${token}::uuid, ${new Date(now.getTime() + 10 * 60_000)})
      ON CONFLICT(environment) DO UPDATE SET lease_token = excluded.lease_token, lease_until = excluded.lease_until
      WHERE app.data_job_collector.lease_until IS NULL OR app.data_job_collector.lease_until < ${now}
      RETURNING lease_token`;
    return rows.length ? token : null;
  }, TX_OPTIONS);
}

/** Server-only checkpoint read. Reader routes select summary, never this column. */
export async function readCollectionStates(environment: JobEnvironment): Promise<Map<string, unknown>> {
  const rows = await withUserScope(JOB_WORKER, (tx) => tx.$queryRaw<Array<{ job_id: string; provider_state: unknown }>>`
    SELECT job_id,provider_state FROM app.data_job_snapshot
    WHERE environment = ${environment} AND provider_state IS NOT NULL LIMIT 200`, { timeout: 5_000, maxWait: 2_000 });
  return new Map(rows.map((row) => [row.job_id, row.provider_state]));
}

export async function saveObservation(def: JobDefinition, input: JobObservation, token: string, now: Date,
  supplemental: { checkpoint?: N8nCollectionState; applicationEvidence?: JobApplicationEvidence | null } = {},
): Promise<void> {
  if (appWritesPaused()) throw new Error("writes_paused");
  const observation = validateObservation(def, input);
  const checkpoint = supplemental.checkpoint ? validateProviderCheckpoint(supplemental.checkpoint) : null;
  if (checkpoint && (def.provider !== "n8n" || Date.parse(checkpoint.startedCoverageThrough) > Date.parse(observation.observedAt))) throw new Error("invalid_provider_checkpoint");
  const applicationEvidence = supplemental.applicationEvidence ? validateApplicationEvidence(supplemental.applicationEvidence) : null;
  if (applicationEvidence && (applicationEvidence.environment !== def.environment || applicationEvidence.sourceKey !== applicationSourceForJob(def)
    || Date.parse(applicationEvidence.observedAt) > Date.parse(observation.observedAt) || Date.parse(applicationEvidence.observedAt) > now.getTime())) {
    throw new Error("invalid_application_evidence_association");
  }
  await withUserScope(JOB_WORKER, async (tx) => {
    const leases = await tx.$queryRaw<Array<{ valid: boolean }>>`
      SELECT true AS valid FROM app.data_job_collector WHERE environment = ${def.environment}
      AND lease_token = ${token}::uuid AND lease_until > now() FOR UPDATE`;
    if (!leases.length) throw new Error("job_collector_lease_lost");
    const old = await tx.$queryRaw<Array<{ observed_at: Date; expected_due_at: Date | null }>>`
      SELECT observed_at, expected_due_at FROM app.data_job_snapshot
      WHERE environment = ${def.environment} AND job_id = ${def.id} FOR UPDATE`;
    if (old[0] && old[0].observed_at > new Date(observation.observedAt)) return;
    // Bounded metadata batches; no network request is made inside this transaction.
    for (let index = 0; index < observation.runs.length; index += 100) {
      const batch = observation.runs.slice(index, index + 100).map((run) => ({
        run_id: run.id, event_at: runTime(run), observed_at: run.observedAt,
        terminal: !["RUNNING", "UNKNOWN"].includes(run.status), run,
      }));
      await tx.$executeRaw`
        INSERT INTO app.data_job_run(environment, job_id, run_id, event_at, observed_at, terminal, run)
        SELECT ${def.environment}, ${def.id}, b.run_id, b.event_at, b.observed_at, b.terminal, b.run
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
          AS b(run_id text, event_at timestamptz, observed_at timestamptz, terminal boolean, run jsonb)
        ON CONFLICT(environment,job_id,run_id) DO UPDATE
          SET event_at = excluded.event_at, observed_at = excluded.observed_at, terminal = excluded.terminal, run = excluded.run
        WHERE app.data_job_run.observed_at <= excluded.observed_at
          AND (NOT app.data_job_run.terminal OR excluded.terminal)`;
    }
    const history = await tx.$queryRaw<Array<{ run: JobRun }>>`
      SELECT run FROM app.data_job_run WHERE environment = ${def.environment} AND job_id = ${def.id}
      AND event_at >= ${new Date(observation.windowStart)} AND event_at <= ${new Date(observation.windowEnd)}
      ORDER BY event_at DESC, run_id DESC LIMIT 5001`;
    const anchors = await tx.$queryRaw<Array<{ run: JobRun }>>`
      (SELECT run FROM app.data_job_run WHERE environment = ${def.environment} AND job_id = ${def.id}
       ORDER BY event_at DESC,run_id DESC LIMIT 1)
      UNION ALL (SELECT run FROM app.data_job_run WHERE environment = ${def.environment} AND job_id = ${def.id}
       AND run->>'status' = 'SUCCEEDED' ORDER BY event_at DESC,run_id DESC LIMIT 1)
      UNION ALL (SELECT run FROM app.data_job_run WHERE environment = ${def.environment} AND job_id = ${def.id}
       AND run->>'status' = 'FAILED' ORDER BY event_at DESC,run_id DESC LIMIT 1)
      UNION ALL (SELECT run FROM app.data_job_run WHERE environment = ${def.environment} AND job_id = ${def.id}
       AND run->>'status' IN ('RUNNING','UNKNOWN') AND run->>'correlation' <> 'event_only' ORDER BY event_at DESC,run_id DESC LIMIT 201)`;
    if (history.length > 5000) observation.coverage = "partial";
    const expectedDue = nextExpectedDue(old[0]?.expected_due_at?.toISOString() ?? null, observation);
    const evidence = [...new Map([...history.slice(0, 5000), ...anchors].map((row) => [row.run.id, row.run])).values()];
    const summary = summarizeJob(def, observation, evidence, [], now, expectedDue);
    summary.applicationEvidence = applicationEvidence;
    const kinds = incidentKinds(summary);
    // Capture each failure even if it already recovered before this poll. The
    // evidence key makes replay idempotent; the run itself is never deleted.
    const failureIncidents = observation.runs.filter((entry) => entry.status === "FAILED" || entry.status === "CANCELED").map((run) => {
      const failureAt = new Date(run.finishedAt ?? run.startedAt ?? run.observedAt);
      const recovered = observation.runs.filter((entry) => ["SUCCEEDED", "ACKNOWLEDGED"].includes(entry.status)
        && entry.evidence === run.evidence && Date.parse(runTime(entry)) > failureAt.getTime())
        .sort((a, b) => Date.parse(runTime(a)) - Date.parse(runTime(b)))[0];
      return { id: randomUUID(), evidence_run_id: run.id, opened_at: failureAt.toISOString(), resolved_at: recovered ? runTime(recovered) : null };
    });
    await tx.$executeRaw`
      INSERT INTO app.data_job_incident(id,environment,job_id,kind,evidence_run_id,opened_at,resolved_at)
      SELECT b.id,${def.environment},${def.id},'failure',b.evidence_run_id,b.opened_at,b.resolved_at
      FROM jsonb_to_recordset(${JSON.stringify(failureIncidents)}::jsonb)
        AS b(id uuid,evidence_run_id text,opened_at timestamptz,resolved_at timestamptz)
      ON CONFLICT(environment,job_id,kind,evidence_run_id) WHERE evidence_run_id IS NOT NULL DO NOTHING`;
    // A late catch-up must not erase a missed-start deadline between polls.
    const priorDue = old[0]?.expected_due_at;
    if (priorDue && observation.enabled === true && observation.schedule.kind === "scheduled" && observation.coverage === "complete_window") {
      const firstStart = observation.runs.filter((run) => run.startedAt && Date.parse(run.startedAt) >= priorDue.getTime())
        .sort((a, b) => Date.parse(a.startedAt!) - Date.parse(b.startedAt!))[0];
      if (firstStart?.startedAt && Date.parse(firstStart.startedAt) > priorDue.getTime() + def.graceSeconds * 1000) {
        await tx.$executeRaw`
          INSERT INTO app.data_job_incident(id,environment,job_id,kind,evidence_run_id,opened_at,resolved_at)
          VALUES (${randomUUID()}::uuid,${def.environment},${def.id},'overdue',${`due:${priorDue.toISOString()}`},${new Date(priorDue.getTime() + def.graceSeconds * 1000)},${new Date(firstStart.startedAt)})
          ON CONFLICT(environment,job_id,kind,evidence_run_id) WHERE evidence_run_id IS NOT NULL DO NOTHING`;
      }
    }
    for (const kind of kinds) {
      if (kind === "failure" && summary.status !== "PAUSED") continue;
      await tx.$executeRaw`
        INSERT INTO app.data_job_incident(id,environment,job_id,kind,opened_at)
        VALUES (${randomUUID()}::uuid, ${def.environment}, ${def.id}, ${kind}, ${now})
        ON CONFLICT (environment,job_id,kind) WHERE resolved_at IS NULL AND evidence_run_id IS NULL DO NOTHING`;
    }
    // An unavailable provider is not evidence that its failures recovered.
    if (!summary.monitoringStale) {
      await tx.$executeRaw`
        UPDATE app.data_job_incident SET resolved_at = ${now}
        WHERE environment = ${def.environment} AND job_id = ${def.id} AND resolved_at IS NULL
          AND kind <> 'failure' AND NOT (kind = ANY(${kinds}::text[]))`;
      // Starting a retry, disappearing from retention, or lack of new failure
      // evidence is not recovery. Require a later positive result of the same
      // evidence class as the failed attempt.
      await tx.$executeRaw`
        UPDATE app.data_job_incident incident SET resolved_at = ${now}
        WHERE environment = ${def.environment} AND job_id = ${def.id} AND resolved_at IS NULL AND kind = 'failure'
          AND EXISTS (SELECT 1 FROM app.data_job_run recovery
            LEFT JOIN app.data_job_run failed ON failed.environment = incident.environment
              AND failed.job_id = incident.job_id AND failed.run_id = incident.evidence_run_id
            WHERE recovery.environment = incident.environment AND recovery.job_id = incident.job_id
              AND recovery.event_at > incident.opened_at
              AND recovery.run->>'status' IN ('SUCCEEDED','ACKNOWLEDGED')
              AND (incident.evidence_run_id IS NULL OR recovery.run->>'evidence' = failed.run->>'evidence'))`;
    }
    const incidents = await tx.$queryRaw<Array<{ kind: JobIncident["kind"]; opened_at: Date; resolved_at: Date | null }>>`
      SELECT kind,opened_at,resolved_at FROM app.data_job_incident
      WHERE environment = ${def.environment} AND job_id = ${def.id}
      ORDER BY opened_at DESC LIMIT 10`;
    summary.incidents = incidents.map((row) => ({ kind: row.kind, openedAt: row.opened_at.toISOString(), resolvedAt: row.resolved_at?.toISOString() ?? null, delivery: "DISABLED" }));
    const { runs: _runs, ...metadata } = observation;
    await tx.$executeRaw`
      INSERT INTO app.data_job_snapshot(environment,job_id,observed_at,expected_due_at,observation,summary,provider_state)
      VALUES (${def.environment},${def.id},${new Date(observation.observedAt)},${expectedDue ? new Date(expectedDue) : null},${JSON.stringify(metadata)}::jsonb,${JSON.stringify(summary)}::jsonb,${checkpoint ? JSON.stringify(checkpoint) : null}::jsonb)
      ON CONFLICT(environment,job_id) DO UPDATE SET observed_at = excluded.observed_at, expected_due_at = excluded.expected_due_at,
        observation = excluded.observation, summary = excluded.summary,
        provider_state = COALESCE(excluded.provider_state,app.data_job_snapshot.provider_state)`;
  }, TX_OPTIONS);
}

export async function finishCollection(environment: JobEnvironment, token: string, now: Date): Promise<void> {
  await withUserScope(JOB_WORKER, async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE app.data_job_collector SET lease_token = NULL, lease_until = NULL, last_completed_at = ${now}
      WHERE environment = ${environment} AND lease_token = ${token}::uuid`;
    if (changed !== 1) throw new Error("job_collector_lease_lost");
    // Bounded retention: 90 days, never a broad truncate or source-data deletion.
    await tx.$executeRaw`DELETE FROM app.data_job_run WHERE ctid IN (
      SELECT candidate.ctid FROM app.data_job_run candidate WHERE candidate.environment = ${environment} AND candidate.run->>'status' <> 'RUNNING'
        AND NOT (candidate.run->>'status' = 'UNKNOWN' AND candidate.run->>'evidence' = 'provider_execution')
        AND candidate.event_at < ${new Date(now.getTime() - 90 * HISTORY_WINDOW_MS)}
        AND NOT EXISTS (SELECT 1 FROM app.data_job_incident incident WHERE incident.environment = candidate.environment
          AND incident.job_id = candidate.job_id AND incident.evidence_run_id = candidate.run_id AND incident.resolved_at IS NULL)
      LIMIT 5000)`;
    await tx.$executeRaw`DELETE FROM app.data_job_incident WHERE id IN (
      SELECT id FROM app.data_job_incident WHERE environment = ${environment} AND resolved_at < ${new Date(now.getTime() - 90 * HISTORY_WINDOW_MS)} LIMIT 1000)`;
  }, TX_OPTIONS);
}

const priorities = { FAILED: 0, STALLED: 1, OVERDUE: 2, UNKNOWN: 3, RUNNING: 4, PAUSED: 5, HEALTHY: 6 };
export async function readJobList(identity: Identity, options: { q?: string; status?: string; offset?: number }, now = new Date()): Promise<JobListResponse> {
  const environment = jobEnvironment();
  if (!canReadJobs(identity) || !environment) throw new Error("jobs_forbidden");
  const definitions = getDataJobs(environment);
  const data = await withUserScope(identity, async (tx) => ({
    snapshots: await tx.$queryRaw<Array<{ job_id: string; summary: JobSummary }>>`
      SELECT job_id,summary FROM app.data_job_snapshot WHERE environment = ${environment} LIMIT 200`,
    collector: await tx.$queryRaw<Array<{ last_completed_at: Date | null }>>`
      SELECT last_completed_at FROM app.data_job_collector WHERE environment = ${environment}`,
  }), { timeout: 5_000, maxWait: 2_000 });
  const byId = new Map(data.snapshots.map((row) => [row.job_id, row.summary]));
  const jobs = definitions.map((definition) => {
    const saved = byId.get(definition.id);
    if (!saved) return summarizeJob(definition, null, [], [], now);
    const stale = saved.monitoringStale || observationUnavailable(saved.observation, now);
    let application: ReturnType<typeof applicationEvidenceForDisplay> | null = null;
    let invalidApplication = false;
    try {
      if (saved.applicationEvidence) {
        application = applicationEvidenceForDisplay(validateApplicationEvidence(saved.applicationEvidence), now);
        if (application.evidence.environment !== environment || application.evidence.sourceKey !== applicationSourceForJob(definition)) throw new Error();
      }
    } catch { application = null; invalidApplication = true; }
    return { ...saved, definition, monitoringStale: stale,
      applicationEvidence: application?.evidence ?? null, applicationEvidenceStale: invalidApplication || (application?.monitoringStale ?? false),
      ...(stale && ["HEALTHY", "RUNNING", "STALLED"].includes(saved.status) ? { status: "UNKNOWN" as const, reason: "Monitoring evidence is stale. Last recorded state does not prove current health." } : {}) };
  }).filter((job) => (!options.status || (options.status === "SOURCE_ATTENTION" ? !!applicationAttention(job, now) : job.status === options.status))
    && (!options.q || [job.definition.name, job.definition.source, job.definition.runner, job.definition.destination].join(" ").toLowerCase().includes(options.q.toLowerCase())))
    .sort((a, b) => Math.min(priorities[a.status], applicationAttention(a, now) ? 1 : 6) - Math.min(priorities[b.status], applicationAttention(b, now) ? 1 : 6) || a.definition.id.localeCompare(b.definition.id));
  const offset = options.offset ?? 0;
  const lastCompletedAt = data.collector[0]?.last_completed_at?.toISOString() ?? null;
  return { generatedAt: now.toISOString(), jobs: jobs.slice(offset, offset + 20), total: jobs.length,
    nextCursor: offset + 20 < jobs.length ? String(offset + 20) : null,
    collector: { lastCompletedAt, stale: !lastCompletedAt || now.getTime() - Date.parse(lastCompletedAt) > MONITOR_STALE_MS, alertsEnabled: false } };
}

export function parseHistoryCursor(value: string | null): { at: string; id: string } | null {
  if (!value) return null;
  if (value.length > 600) throw new Error("invalid_cursor");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error();
    const { at, id } = parsed as Record<string, unknown>;
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at)) || typeof id !== "string" || !/^[a-zA-Z0-9_:/.-]{1,240}$/.test(id)) throw new Error();
    return { at: new Date(at).toISOString(), id };
  } catch { throw new Error("invalid_cursor"); }
}

export async function readJobHistory(identity: Identity, jobId: string, cursor: { at: string; id: string } | null): Promise<JobHistoryResponse> {
  const environment = jobEnvironment();
  if (!canReadJobs(identity) || !environment || !getDataJobs(environment).some((job) => job.id === jobId)) throw new Error("jobs_forbidden");
  const rows = await withUserScope(identity, (tx) => tx.$queryRaw<Array<{ run: JobRun; event_at: Date; run_id: string }>>`
    SELECT run,event_at,run_id FROM app.data_job_run WHERE environment = ${environment} AND job_id = ${jobId}
      AND (${!cursor} OR (event_at,run_id) < (${cursor ? new Date(cursor.at) : new Date()},${cursor?.id ?? ""}))
    ORDER BY event_at DESC,run_id DESC LIMIT 26`, { timeout: 5_000, maxWait: 2_000 });
  const last = rows[24];
  return { runs: rows.slice(0, 25).map((row) => row.run),
    nextCursor: rows.length > 25 && last ? Buffer.from(JSON.stringify({ at: last.event_at.toISOString(), id: last.run_id })).toString("base64url") : null };
}
