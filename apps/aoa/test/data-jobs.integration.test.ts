import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
vi.mock("server-only", () => ({}));
import { withUserScope } from "@/lib/rls";
import { claimCollection, finishCollection, saveObservation, readJobHistory, readJobList, parseHistoryCursor, readCollectionStates } from "@/lib/data-jobs/store";
import { evaluateAccountAumEvidence } from "@/lib/data-jobs/application-evidence-evaluation";
import { getDataJobs } from "@/lib/data-jobs/registry";
import type { JobObservation, JobRun } from "@/lib/data-jobs/contracts";
import { UNKNOWN_SCHEDULE } from "@/lib/data-jobs/contracts";

const gated = process.env.AUDIT_TEST_DB_URL ? describe : describe.skip;
const def = getDataJobs("dev")[0];
const sourceDef = getDataJobs("prod").find((job) => job.id === "prod-account-aum")!;
const identity = { role: "OPERATIONS", email: "monitor-synthetic@example.test" };
let now: Date;
function run(id: string, status: JobRun["status"], offset = 0): JobRun {
  return { id, jobId: def.id, logicalRunId: id, retryOf: null, correlation: "exact", status, evidence: "provider_execution",
    startedAt: new Date(now.getTime() - 60000 + offset).toISOString(),
    finishedAt: status === "RUNNING" ? null : new Date(now.getTime() - 30000 + offset).toISOString(),
    observedAt: now.toISOString(), durationMs: 30000, recordsProcessed: null, recordsRejected: null, code: null, executionUrl: null };
}
function observation(runs: JobRun[]): JobObservation {
  return { jobId: def.id, observedAt: now.toISOString(), enabled: true, schedule: { ...UNKNOWN_SCHEDULE }, runs,
    coverage: "complete_window", windowStart: new Date(now.getTime() - 86400000).toISOString(), windowEnd: now.toISOString(), code: null };
}

gated("Data job monitoring: real PostgreSQL and forced RLS", () => {
  let owner: PrismaClient;
  const cleanup = async () => {
    await owner.$executeRaw`DELETE FROM app.data_job_incident WHERE environment = 'dev' AND job_id = ${def.id}`;
    await owner.$executeRaw`DELETE FROM app.data_job_run WHERE environment = 'dev' AND job_id = ${def.id}`;
    await owner.$executeRaw`DELETE FROM app.data_job_snapshot WHERE environment = 'dev' AND job_id = ${def.id}`;
    await owner.$executeRaw`DELETE FROM app.data_job_collector WHERE environment = 'dev'`;
    await owner.$executeRaw`DELETE FROM app.data_job_snapshot WHERE environment = 'prod' AND job_id = ${sourceDef.id}`;
    await owner.$executeRaw`DELETE FROM app.data_job_incident WHERE environment = 'prod' AND job_id = ${sourceDef.id}`;
    await owner.$executeRaw`DELETE FROM app.data_job_collector WHERE environment = 'prod'`;
  };
  beforeAll(async () => {
    if (!process.env.AUDIT_TEST_CLEANUP_URL) throw new Error("synthetic_db_owner_required");
    owner = new PrismaClient({ datasources: { db: { url: process.env.AUDIT_TEST_CLEANUP_URL } } });
  });
  beforeEach(async () => {
    await cleanup(); now = new Date();
    vi.stubEnv("APP_ENV", "dev"); vi.stubEnv("DATA_HEALTH", "1"); vi.stubEnv("DATA_JOB_MONITORING", "1");
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No network in database tests"); }));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => { if (owner) { await cleanup(); await owner.$disconnect(); } });

  it("fences concurrent collectors and deduplicates replays without regressing terminal results", async () => {
    const [a, b] = await Promise.all([claimCollection("dev", now), claimCollection("dev", now)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const token = (a ?? b)!;
    await saveObservation(def, observation([run("synthetic:1", "SUCCEEDED")]), token, now);
    await saveObservation(def, observation([run("synthetic:1", "RUNNING")]), token, now);
    const history = await readJobHistory(identity, def.id, null);
    expect(history.runs).toHaveLength(1); expect(history.runs[0].status).toBe("SUCCEEDED");
    await finishCollection("dev", token, now);
    await expect(saveObservation(def, observation([]), token, now)).rejects.toThrow("lease_lost");
  });

  it("preserves an incident for a failure and recovery that both happen between polls", async () => {
    const token = (await claimCollection("dev", now))!;
    const value = observation([run("synthetic:failed", "FAILED", -10000), run("synthetic:recovered", "SUCCEEDED")]);
    await saveObservation(def, value, token, now);
    await saveObservation(def, value, token, now);
    const incidents = await owner.$queryRaw<Array<{ evidence_run_id: string; resolved_at: Date | null; delivery: string }>>`
      SELECT evidence_run_id,resolved_at,delivery FROM app.data_job_incident WHERE job_id = ${def.id}`;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ evidence_run_id: "synthetic:failed", delivery: "DISABLED" });
    expect(incidents[0].resolved_at).not.toBeNull();
    const list = await readJobList(identity, {}, now);
    expect(list.jobs.find((job) => job.definition.id === def.id)?.stats).toMatchObject({ successRate: 50, failed: 1, succeeded: 1 });
  });

  it("paginates history without duplicating equal-time attempts and sanitizes unknown fields", async () => {
    const token = (await claimCollection("dev", now))!;
    const value = observation(Array.from({ length: 30 }, (_, i) => ({ ...run(`synthetic:${String(i).padStart(2, "0")}`, "SUCCEEDED"), secret: "must_not_persist" })));
    await saveObservation(def, value, token, now);
    const first = await readJobHistory(identity, def.id, null);
    const second = await readJobHistory(identity, def.id, parseHistoryCursor(first.nextCursor));
    expect(first.runs).toHaveLength(25); expect(second.runs).toHaveLength(5);
    expect(new Set([...first.runs, ...second.runs].map((row) => row.id)).size).toBe(30);
    expect(JSON.stringify(first)).not.toContain("must_not_persist");
  });

  it("does not call a retry-start recovery and preserves runs older than the statistics window", async () => {
    const token = (await claimCollection("dev", now))!;
    await saveObservation(def, observation([run("synthetic:failed", "FAILED", -10000)]), token, now);
    await saveObservation(def, observation([run("synthetic:retry", "RUNNING")]), token, now);
    const incidents = await owner.$queryRaw<Array<{ resolved_at: Date | null }>>`
      SELECT resolved_at FROM app.data_job_incident WHERE job_id = ${def.id} AND kind = 'failure'`;
    expect(incidents).toHaveLength(1); expect(incidents[0].resolved_at).toBeNull();
    const longRun = { ...run("synthetic:long", "RUNNING"), startedAt: new Date(now.getTime() - 25 * 3600000).toISOString() };
    await saveObservation(def, observation([longRun, run("synthetic:retry", "SUCCEEDED")]), token, now);
    const list = await readJobList(identity, {}, now);
    expect(list.jobs.find((job) => job.definition.id === def.id)?.status).toBe("STALLED");
  });

  it("keeps last-known successful run over a quiet weekend and refuses partial-error green", async () => {
    const token = (await claimCollection("dev", now))!;
    const oldRun = run("synthetic:friday", "SUCCEEDED", -48 * 3600000);
    await saveObservation(def, observation([oldRun]), token, now);
    await saveObservation(def, observation([]), token, now);
    let list = await readJobList(identity, {}, now);
    let job = list.jobs.find((row) => row.definition.id === def.id)!;
    expect(job.lastSuccessAt).toBe(oldRun.finishedAt); expect(job.latestRun?.id).toBe(oldRun.id);
    expect(job.stats.executions).toBe(0);
    await saveObservation(def, { ...observation([oldRun]), coverage: "partial", code: "provider_timeout" }, token, now);
    list = await readJobList(identity, {}, now); job = list.jobs.find((row) => row.definition.id === def.id)!;
    expect(job).toMatchObject({ monitoringStale: true, status: "UNKNOWN" });
  });

  it("blocks ordinary operations writes, advisor reads and cross-environment results", async () => {
    const token = (await claimCollection("dev", now))!;
    await saveObservation(def, observation([run("synthetic:success", "SUCCEEDED")]), token, now);
    await expect(withUserScope(identity, (tx) => tx.$executeRaw`
      INSERT INTO app.data_job_collector(environment) VALUES ('prod')`)).rejects.toThrow();
    expect(await withUserScope({ role: "ADVISOR", email: identity.email }, (tx) => tx.$queryRaw`
      SELECT * FROM app.data_job_snapshot`)).toEqual([]);
    await expect(readJobList({ role: "ADVISOR", email: identity.email }, {})).rejects.toThrow("forbidden");
    await expect(readJobList({ role: "OPERATIONS", email: "" }, {})).rejects.toThrow("forbidden");
    vi.stubEnv("APP_ENV", "prod");
    const list = await readJobList(identity, {});
    expect(list.jobs.every((job) => job.observation === null)).toBe(true);
  });

  it("pins forced RLS and collector-only mutations on all four audit-exempt monitoring tables", async () => {
    const names = ["data_job_collector", "data_job_incident", "data_job_run", "data_job_snapshot"];
    const tables = await owner.$queryRaw<Array<{ name: string; enabled: boolean; forced: boolean }>>`
      SELECT c.relname AS name,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='app' AND c.relname=ANY(${names}::text[]) ORDER BY c.relname`;
    expect(tables).toEqual(names.map((name) => ({ name, enabled: true, forced: true })));
    const [runtimeRole] = await withUserScope(identity, (tx) => tx.$queryRaw<Array<{
      name: string; superuser: boolean; bypass: boolean;
    }>>`SELECT rolname AS name,rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`);
    expect(runtimeRole).toEqual({ name: "app_rw", superuser: false, bypass: false });

    const token = (await claimCollection("dev", now))!;
    await saveObservation(def, observation([run("synthetic:rls-failure", "FAILED")]), token, now);
    const [visible] = await withUserScope(identity, (tx) => tx.$queryRaw<Array<{
      collectors: bigint; incidents: bigint; runs: bigint; snapshots: bigint;
    }>>`SELECT
      (SELECT count(*) FROM app.data_job_collector WHERE environment='dev') AS collectors,
      (SELECT count(*) FROM app.data_job_incident WHERE environment='dev' AND job_id=${def.id}) AS incidents,
      (SELECT count(*) FROM app.data_job_run WHERE environment='dev' AND job_id=${def.id}) AS runs,
      (SELECT count(*) FROM app.data_job_snapshot WHERE environment='dev' AND job_id=${def.id}) AS snapshots`);
    expect(visible).toEqual({ collectors: 1n, incidents: 1n, runs: 1n, snapshots: 1n });

    // Valid inserts use unused keys inside the existing exact-cleanup scope:
    // denial must come from RLS, not a duplicate key or malformed fixture.
    const mutations = [
      {
        insert: Prisma.sql`INSERT INTO app.data_job_collector(environment) VALUES ('prod')`,
        update: Prisma.sql`UPDATE app.data_job_collector SET lease_until=lease_until WHERE environment='dev'`,
        remove: Prisma.sql`DELETE FROM app.data_job_collector WHERE environment='dev'`,
      },
      {
        insert: Prisma.sql`INSERT INTO app.data_job_incident(id,environment,job_id,kind,evidence_run_id,opened_at)
          VALUES ('d2397574-88e0-4527-b4d5-d00669326846'::uuid,'dev',${def.id},'failure','synthetic:denied',${now})`,
        update: Prisma.sql`UPDATE app.data_job_incident SET opened_at=opened_at WHERE environment='dev' AND job_id=${def.id}`,
        remove: Prisma.sql`DELETE FROM app.data_job_incident WHERE environment='dev' AND job_id=${def.id}`,
      },
      {
        insert: Prisma.sql`INSERT INTO app.data_job_run(environment,job_id,run_id,event_at,observed_at,terminal,run)
          VALUES ('dev',${def.id},'synthetic:denied',${now},${now},true,'{}'::jsonb)`,
        update: Prisma.sql`UPDATE app.data_job_run SET observed_at=observed_at WHERE environment='dev' AND job_id=${def.id}`,
        remove: Prisma.sql`DELETE FROM app.data_job_run WHERE environment='dev' AND job_id=${def.id}`,
      },
      {
        insert: Prisma.sql`INSERT INTO app.data_job_snapshot(environment,job_id,observed_at,observation,summary)
          VALUES ('prod',${sourceDef.id},${now},'{}'::jsonb,'{}'::jsonb)`,
        update: Prisma.sql`UPDATE app.data_job_snapshot SET observed_at=observed_at WHERE environment='dev' AND job_id=${def.id}`,
        remove: Prisma.sql`DELETE FROM app.data_job_snapshot WHERE environment='dev' AND job_id=${def.id}`,
      },
    ];
    for (const actor of [
      identity,
      { role: "ADMIN", email: identity.email },
      // The reserved email alone must not confer worker authority.
      { role: "ADMIN", email: "data-job-collector@system" },
      { role: "ADVISOR", email: "data-job-collector@system" },
      { role: "OPERATIONS", email: "" },
    ]) {
      for (const mutation of mutations) {
        await expect(withUserScope(actor, (tx) => tx.$executeRaw(mutation.insert))).rejects.toThrow(/row-level security policy/i);
        await expect(withUserScope(actor, (tx) => tx.$executeRaw(mutation.update))).resolves.toBe(0);
        await expect(withUserScope(actor, (tx) => tx.$executeRaw(mutation.remove))).resolves.toBe(0);
      }
    }
    // The exact worker identity still owns the lease and can complete normally.
    await finishCollection("dev", token, now);
    expect((await readJobHistory(identity, def.id, null)).runs.map((entry) => entry.id)).toEqual(["synthetic:rls-failure"]);
  });

  it("keeps lease, checkpoint, run and incident lifecycle metadata out of the generic audit trail", async () => {
    const [{ lastId }] = await owner.$queryRaw<Array<{ lastId: bigint }>>`
      SELECT coalesce(max(id),0) AS "lastId" FROM audit.row_change`;
    const token = (await claimCollection("dev", now))!;
    expect(token).toBeTruthy();
    const [claimed] = await owner.$queryRaw<Array<{ lease_token: string; lease_until: Date }>>`
      SELECT lease_token,lease_until FROM app.data_job_collector WHERE environment='dev'`;
    expect(claimed.lease_token).toBe(token);
    expect(claimed.lease_until.getTime()).toBeGreaterThan(now.getTime());

    const oldFailure = run("synthetic:audit-old-failure", "FAILED", -92 * 86400000);
    const oldRecovery = run("synthetic:audit-old-recovery", "SUCCEEDED", -91 * 86400000);
    const recentFailure = run("synthetic:audit-recent-failure", "FAILED", -10000);
    const pending = run("synthetic:audit-pending", "RUNNING");
    const checkpoint = { schemaVersion: 1 as const, proofId: "private-audit-synthetic-proof",
      startedCoverageFrom: new Date(now.getTime() - 86400000).toISOString(), startedCoverageThrough: now.toISOString(),
      pendingExecutionIds: ["privateAuditPending"] };
    await saveObservation(def, observation([oldFailure, oldRecovery, recentFailure, pending]), token, now, { checkpoint });
    expect((await readCollectionStates("dev")).get(def.id)).toEqual(checkpoint);
    expect((await readJobHistory(identity, def.id, null)).runs).toHaveLength(4);
    const initialIncidents = await owner.$queryRaw<Array<{ evidence_run_id: string; resolved_at: Date | null }>>`
      SELECT evidence_run_id,resolved_at FROM app.data_job_incident
      WHERE environment='dev' AND job_id=${def.id} ORDER BY evidence_run_id`;
    expect(initialIncidents).toEqual([
      { evidence_run_id: oldFailure.id, resolved_at: new Date(oldRecovery.finishedAt!) },
      { evidence_run_id: recentFailure.id, resolved_at: null },
    ]);

    // Exercise run/checkpoint updates and a separate incident-recovery UPDATE.
    await saveObservation(def, observation([run(pending.id, "SUCCEEDED")]), token, now,
      { checkpoint: { ...checkpoint, pendingExecutionIds: [] } });
    expect((await readCollectionStates("dev")).get(def.id)).toEqual({ ...checkpoint, pendingExecutionIds: [] });
    expect((await readJobHistory(identity, def.id, null)).runs.find((entry) => entry.id === pending.id)?.status).toBe("SUCCEEDED");
    const [recovered] = await owner.$queryRaw<Array<{ resolved_at: Date | null }>>`
      SELECT resolved_at FROM app.data_job_incident
      WHERE environment='dev' AND job_id=${def.id} AND evidence_run_id=${recentFailure.id}`;
    expect(recovered.resolved_at).toEqual(now);

    // Completion clears the lease and deletes expired runs/closed incidents.
    await finishCollection("dev", token, now);
    const [completed] = await owner.$queryRaw<Array<{ lease_token: null; lease_until: null; last_completed_at: Date }>>`
      SELECT lease_token,lease_until,last_completed_at FROM app.data_job_collector WHERE environment='dev'`;
    expect(completed).toEqual({ lease_token: null, lease_until: null, last_completed_at: now });
    expect((await readJobHistory(identity, def.id, null)).runs.map((entry) => entry.id).sort())
      .toEqual([pending.id, recentFailure.id].sort());
    const retainedIncidents = await owner.$queryRaw<Array<{ evidence_run_id: string }>>`
      SELECT evidence_run_id FROM app.data_job_incident WHERE environment='dev' AND job_id=${def.id}`;
    expect(retainedIncidents).toEqual([{ evidence_run_id: recentFailure.id }]);
    const copied = await owner.$queryRaw<Array<{ table_name: string; op: string }>>`
      SELECT table_name,op FROM audit.row_change WHERE id>${lastId} AND schema_name='app'
      AND table_name IN ('data_job_collector','data_job_incident','data_job_run','data_job_snapshot')`;
    expect(copied).toEqual([]);
  });

  it("marks monitoring stale independently and never enables Slack delivery", async () => {
    const token = (await claimCollection("dev", now))!;
    await saveObservation(def, observation([run("synthetic:success", "SUCCEEDED")]), token, now);
    await finishCollection("dev", token, now);
    const list = await readJobList(identity, {}, new Date(now.getTime() + 16 * 60000));
    const job = list.jobs.find((row) => row.definition.id === def.id);
    expect(job).toMatchObject({ monitoringStale: true, status: "UNKNOWN" });
    expect(list.collector).toMatchObject({ stale: true, alertsEnabled: false });
    await expect(owner.$executeRaw`UPDATE app.data_job_incident SET delivery = 'SENT'`).resolves.toBe(0);
  });
  it("batches a failure storm without losing or duplicating incident evidence", async () => {
    const token = (await claimCollection("dev", now))!;
    const value = observation(Array.from({ length: 1200 }, (_, i) => run(`synthetic:storm:${i}`, "FAILED")));
    await saveObservation(def, value, token, now);
    await saveObservation(def, value, token, now);
    const [result] = await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM app.data_job_incident WHERE environment='dev' AND job_id=${def.id} AND kind='failure'`;
    expect(Number(result.count)).toBe(1200);
  });

  it("atomically stores private checkpoints, preserves invalidation and never exposes them in reader results", async () => {
    const token = (await claimCollection("dev", now))!;
    const checkpoint = { schemaVersion: 1 as const, proofId: "private-synthetic-proof", startedCoverageFrom: new Date(now.getTime() - 86400000).toISOString(),
      startedCoverageThrough: now.toISOString(), pendingExecutionIds: ["pending123"], invalidatedAt: now.toISOString() };
    await saveObservation(def, observation([run("synthetic:1", "SUCCEEDED")]), token, now, { checkpoint });
    expect((await readCollectionStates("dev")).get(def.id)).toEqual(checkpoint);
    await saveObservation(def, observation([]), token, now);
    expect((await readCollectionStates("dev")).get(def.id)).toEqual(checkpoint);
    expect(JSON.stringify(await readJobList(identity, {}, now))).not.toMatch(/private-synthetic-proof|pending123|provider_state/);
    expect(await readCollectionStates("prod")).toEqual(new Map());
    await finishCollection("dev", token, now);
    await expect(saveObservation(def, observation([]), token, now, { checkpoint: { ...checkpoint, pendingExecutionIds: [] } })).rejects.toThrow("lease_lost");
    expect((await readCollectionStates("dev")).get(def.id)).toEqual(checkpoint);
  });

  it("retains old unresolved failure evidence until a compatible recovery can resolve the incident", async () => {
    const token = (await claimCollection("dev", now))!;
    await saveObservation(def, observation([run("synthetic:old-failure", "FAILED", -91 * 86400000)]), token, now);
    await finishCollection("dev", token, now);
    expect((await readJobHistory(identity, def.id, null)).runs).toHaveLength(1);
    const secondToken = (await claimCollection("dev", now))!;
    await saveObservation(def, observation([run("synthetic:recovery", "SUCCEEDED")]), secondToken, now);
    const incidents = await owner.$queryRaw<Array<{ resolved_at: Date | null }>>`
      SELECT resolved_at FROM app.data_job_incident WHERE environment='dev' AND job_id=${def.id} AND evidence_run_id='synthetic:old-failure'`;
    expect(incidents).toHaveLength(1); expect(incidents[0].resolved_at).not.toBeNull();
    await finishCollection("dev", secondToken, now);
    expect((await readJobHistory(identity, def.id, null)).runs.map((entry) => entry.id)).toEqual(["synthetic:recovery"]);
  });
  it("retains unresolved old waiting executions as Unknown through history expiry", async () => {
    const token = (await claimCollection("dev", now))!;
    const waiting = { ...run("synthetic:waiting", "UNKNOWN", -91 * 86400000), finishedAt: null, code: "n8n_execution_waiting" };
    await saveObservation(def, observation([waiting, run("synthetic:success", "SUCCEEDED")]), token, now);
    await finishCollection("dev", token, now);
    expect((await readJobHistory(identity, def.id, null)).runs.map((entry) => entry.id)).toContain("synthetic:waiting");
    const job = (await readJobList(identity, {}, now)).jobs.find((entry) => entry.definition.id === def.id)!;
    expect(job.status).toBe("UNKNOWN"); expect(job.reason).toContain("waiting");
  });

  it("keeps source partial/stale evidence separate from execution rates and isolates corrupt supplemental snapshots", async () => {
    vi.stubEnv("APP_ENV", "prod");
    const token = (await claimCollection("prod", now))!;
    const applicationEvidence = evaluateAccountAumEvidence("prod", {
      audits: [{ at: new Date(now.getTime() - 60000), detail: JSON.stringify({ dry_run: false, received: 105, upserted: 100, rejected: 5, as_of_max: "2026-09-01", trigger: "scheduled_primary" }) }], warning: null,
    }, now);
    const sourceObservation = { ...observation([]), jobId: sourceDef.id };
    await saveObservation(sourceDef, sourceObservation, token, now, { applicationEvidence });
    const result = await readJobList(identity, { status: "SOURCE_ATTENTION" }, now);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ definition: { id: sourceDef.id }, applicationEvidence: { status: "PARTIAL", correlation: "source_only", recordsCommitted: 100 }, stats: { succeeded: 0, successRate: null } });
    const aged = (await readJobList(identity, {}, new Date(now.getTime() + 16 * 60000))).jobs.find((job) => job.definition.id === sourceDef.id)!;
    expect(aged).toMatchObject({ applicationEvidenceStale: true, applicationEvidence: { freshness: { status: "UNKNOWN" }, recordsCommitted: 100 } });
    await expect(saveObservation(sourceDef, sourceObservation, token, now, { applicationEvidence: { ...applicationEvidence, environment: "dev" } })).rejects.toThrow("association");
    const future = new Date(now.getTime() + 60000).toISOString();
    await expect(saveObservation(sourceDef, sourceObservation, token, now, { applicationEvidence: { ...applicationEvidence, observedAt: future, freshness: { ...applicationEvidence.freshness, checkedAt: future } } })).rejects.toThrow("association");
    await owner.$executeRaw`UPDATE app.data_job_snapshot SET summary = jsonb_set(summary,'{applicationEvidence}', '{"bad":"synthetic-malformed"}'::jsonb) WHERE environment='prod' AND job_id=${sourceDef.id}`;
    const resilient = await readJobList(identity, {}, now);
    expect(resilient.total).toBe(20);
    expect(resilient.jobs.find((job) => job.definition.id === sourceDef.id)).toMatchObject({ applicationEvidence: null, applicationEvidenceStale: true });
  });
});
