import { describe, expect, it } from "vitest";
import type { JobDefinition, JobObservation, JobRun } from "@/lib/data-jobs/contracts";
import { UNKNOWN_SCHEDULE } from "@/lib/data-jobs/contracts";
import {
  incidentKinds, nextExpectedDue, observationUnavailable, shouldReplaceRun, summarizeJob,
} from "@/lib/data-jobs/evaluation";
import { DATA_JOB_PROVIDER_CONFIG, getDataJobs } from "@/lib/data-jobs/registry";

const NOW = new Date("2026-09-18T12:00:00.000Z");
const definition: JobDefinition = {
  id: "dev-test-job", name: "Synthetic test job", source: "Synthetic source",
  environment: "dev", provider: "n8n", providerId: "syntheticWorkflow",
  trigger: "Synthetic schedule", runner: "Synthetic runner",
  destination: "Synthetic destination", consumers: ["Synthetic consumer"],
  owner: "Unassigned", jobUrl: "https://n8n-dev.example/workflow/syntheticWorkflow",
  expectedEnabled: true, graceSeconds: 15 * 60, maxRunSeconds: 30 * 60,
};

function run(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "attempt-1", jobId: definition.id, logicalRunId: null, retryOf: null,
    correlation: "attempt_only", status: "SUCCEEDED", evidence: "provider_execution",
    startedAt: "2026-09-18T11:58:00.000Z", finishedAt: "2026-09-18T11:59:00.000Z",
    observedAt: NOW.toISOString(), durationMs: 60_000, recordsProcessed: null,
    recordsRejected: null, code: null, executionUrl: null, ...overrides,
  };
}

function observation(overrides: Partial<JobObservation> = {}): JobObservation {
  return {
    jobId: definition.id, observedAt: NOW.toISOString(), enabled: true,
    schedule: { kind: "scheduled", expression: "*/15 * * * *", timezone: "America/New_York",
      nextRunAt: "2026-09-18T12:15:00.000Z", nextRunBasis: "calculated", nextRetryAt: null },
    runs: [], coverage: "complete_window", windowStart: "2026-09-17T12:00:00.000Z",
    windowEnd: NOW.toISOString(), code: null, ...overrides,
  };
}

describe("data jobs evidence evaluation", () => {
  it("does not hide unresolved waiting/unknown execution behind a prior success", () => {
    const waiting = run({ id: "waiting-old", status: "UNKNOWN", startedAt: "2026-09-01T00:00:00.000Z", finishedAt: null, code: "n8n_execution_waiting" });
    const value = summarizeJob(definition, observation(), [waiting, run()], [], NOW);
    expect(value.status).toBe("UNKNOWN"); expect(value.reason).toContain("waiting");
    expect(value.stats.running).toBe(0);
  });
  it("keeps statistics on the observed completion window when persistence finishes later", () => {
    const failed = run({ id: "boundary-failure", status: "FAILED", startedAt: "2026-09-17T11:59:00.000Z", finishedAt: "2026-09-17T12:00:01.000Z" });
    const value = summarizeJob(definition, observation(), [failed, run()], [], new Date(NOW.getTime() + 60000));
    expect(value.stats).toMatchObject({ windowStart: observation().windowStart, windowEnd: observation().windowEnd, failed: 1, succeeded: 1, successRate: 50 });
  });
  it.each(["provider_completion_window_warming", "provider_null_start_history_unverified"])("discloses %s without treating successful partial collection as a network outage", (code) => {
    const partial = observation({ coverage: "partial", code });
    expect(observationUnavailable(partial, NOW)).toBe(false);
    expect(summarizeJob(definition, partial, [run()], [], NOW).stats.successRate).toBeNull();
  });
  it("counts failed delivery events separately without inventing execution counts", () => {
    const value = summarizeJob(definition, observation(), [run({ status: "FAILED", correlation: "event_only", evidence: "delivery_only" })], [], NOW);
    expect(value.stats).toMatchObject({ executions: 0, failed: 0, deliveryFailed: 1, successRate: null });
  });
  it("keeps missing monitoring Unknown rather than making an empty green row", () => {
    const value = summarizeJob(definition, null, [], [], NOW);
    expect(value.status).toBe("UNKNOWN");
    expect(value.monitoringStale).toBe(true);
    expect(value.stats.successRate).toBeNull();
    expect(incidentKinds(value)).toEqual(["monitoring_unavailable"]);
  });

  it("labels provider success without claiming source freshness or committed records", () => {
    const value = summarizeJob(definition, observation(), [run()], [], NOW);
    expect(value.status).toBe("HEALTHY");
    expect(value.reason).toMatch(/does not independently verify/);
    expect(value.stats).toMatchObject({ executions: 1, succeeded: 1, failed: 0, successRate: 100 });
    expect(value.latestRun?.recordsProcessed).toBeNull();
  });

  it("distinguishes application-commit evidence without inferring fresh source dates", () => {
    const value = summarizeJob(definition, observation(), [run({ evidence: "application_commit" })], [], NOW);
    expect(value.reason).toMatch(/Application commitment was verified/);
    expect(value.reason).toMatch(/freshness remains a separate check/);
  });

  it("preserves an earlier failed attempt when a later execution succeeds", () => {
    const failed = run({ id: "failure-1", status: "FAILED", startedAt: "2026-09-18T11:50:00.000Z", finishedAt: "2026-09-18T11:51:00.000Z" });
    const value = summarizeJob(definition, observation(), [failed, run()], [], NOW);
    expect(value.status).toBe("HEALTHY");
    expect(value.lastFailureAt).toBe("2026-09-18T11:51:00.000Z");
    expect(value.stats).toMatchObject({ executions: 2, succeeded: 1, failed: 1, successRate: 50 });
    expect(value.latestRun?.id).toBe("attempt-1");
  });

  it("opens a failure condition for the latest failed execution", () => {
    const value = summarizeJob(definition, observation(), [run({ status: "FAILED" })], [], NOW);
    expect(value.status).toBe("FAILED");
    expect(incidentKinds(value)).toEqual(["failure"]);
  });

  it("does not call a canceled terminal attempt a successful run", () => {
    const value = summarizeJob(definition, observation(), [run({ status: "CANCELED" })], [], NOW);
    expect(value.status).toBe("FAILED");
    expect(value.stats.successRate).toBe(0);
  });

  it("does not round a 99.95% window up to 100% when one attempt failed", () => {
    const successes = Array.from({ length: 1999 }, (_, index) => run({ id: `success-${index}` }));
    const value = summarizeJob(definition, observation(), [...successes, run({ id: "one-failure", status: "FAILED" })], [], NOW);
    expect(value.stats).toMatchObject({ executions: 2000, succeeded: 1999, failed: 1 });
    expect(value.stats.successRate).toBeCloseTo(99.95, 8);
    expect(value.stats.successRate).toBeLessThan(100);
  });

  it("does not calculate a complete-window success rate from a partial sample", () => {
    const value = summarizeJob(definition, observation({ coverage: "partial" }), [run()], [], NOW);
    expect(value.stats.successRate).toBeNull();
  });

  it("does not calculate a success rate while provider history is unavailable", () => {
    const value = summarizeJob(definition, observation({ coverage: "unavailable" }), [run()], [], NOW);
    expect(value.monitoringStale).toBe(true);
    expect(value.stats.successRate).toBeNull();
    expect(value.status).toBe("UNKNOWN");
  });

  it("does not turn a failed provider read green just because partial success evidence survived", () => {
    const value = summarizeJob(definition, observation({ coverage: "partial", code: "provider_timeout" }), [run()], [], NOW);
    expect(value.status).toBe("UNKNOWN");
    expect(value.monitoringStale).toBe(true);
    expect(incidentKinds(value)).toContain("monitoring_unavailable");
  });

  it("keeps Scheduler delivery acknowledgements out of execution denominators", () => {
    const acknowledged = run({ correlation: "event_only", evidence: "delivery_only", status: "ACKNOWLEDGED", durationMs: null });
    const value = summarizeJob(definition, observation(), [acknowledged], [], NOW);
    expect(value.status).toBe("UNKNOWN");
    expect(value.reason).toMatch(/delivery was acknowledged/);
    expect(value.stats).toMatchObject({ executions: 0, acknowledged: 1, successRate: null });
  });

  it("never diagnoses an unpaired Scheduler start as a stalled logical execution", () => {
    const started = run({ correlation: "event_only", evidence: "delivery_only", status: "UNKNOWN", startedAt: "2026-09-18T08:00:00.000Z", finishedAt: null, durationMs: null });
    const value = summarizeJob(definition, observation(), [started], [], NOW);
    expect(value.status).toBe("UNKNOWN");
    expect(value.stats.running).toBe(0);
    expect(incidentKinds(value)).not.toContain("stalled");
  });

  it("can report an independent Scheduler delivery failure without invented run counts", () => {
    const failed = run({ correlation: "event_only", evidence: "delivery_only", status: "FAILED", durationMs: null });
    const value = summarizeJob(definition, observation(), [failed], [], NOW);
    expect(value.status).toBe("FAILED");
    expect(value.stats).toMatchObject({ executions: 0, failed: 0, successRate: null });
    expect(value.lastFailureAt).toBe(failed.finishedAt);
  });

  it("reports live active attempts and detects an overlong reported execution", () => {
    const active = run({ status: "RUNNING", startedAt: "2026-09-18T11:50:00.000Z", finishedAt: null, durationMs: null });
    expect(summarizeJob(definition, observation(), [active], [], NOW).status).toBe("RUNNING");
    const stalled = summarizeJob(definition, observation(), [{ ...active, startedAt: "2026-09-18T11:29:00.000Z" }], [], NOW);
    expect(stalled.status).toBe("STALLED");
    expect(incidentKinds(stalled)).toEqual(["stalled"]);
  });

  it("cannot assert an active run is still running or stalled after monitoring goes stale", () => {
    const stale = observation({ observedAt: "2026-09-18T11:44:00.000Z" });
    const active = run({ status: "RUNNING", startedAt: "2026-09-18T10:00:00.000Z", finishedAt: null });
    const value = summarizeJob(definition, stale, [active], [], NOW);
    expect(value.status).toBe("UNKNOWN");
    expect(value.monitoringStale).toBe(true);
    expect(incidentKinds(value)).toEqual(["monitoring_unavailable"]);
  });

  it("demotes a previous success when monitoring evidence is stale", () => {
    const value = summarizeJob(definition, observation({ observedAt: "2026-09-18T11:44:00.000Z" }), [run()], [], NOW);
    expect(value.status).toBe("UNKNOWN");
    expect(value.lastSuccessAt).toBe("2026-09-18T11:59:00.000Z");
  });

  it("distinguishes an unexpected paused job from an intentionally disabled definition", () => {
    const paused = observation({ enabled: false });
    const unexpected = summarizeJob(definition, paused, [], [], NOW);
    expect(unexpected.status).toBe("PAUSED");
    expect(incidentKinds(unexpected)).toEqual(["failure"]);
    const intentional = summarizeJob({ ...definition, expectedEnabled: false }, paused, [], [], NOW);
    expect(intentional.status).toBe("PAUSED");
    expect(incidentKinds(intentional)).toEqual([]);
  });

  it("marks a known missed start overdue only after grace expires", () => {
    const due = "2026-09-18T11:30:00.000Z";
    const value = summarizeJob(definition, observation(), [], [], NOW, due);
    expect(value.status).toBe("OVERDUE");
    expect(incidentKinds(value)).toEqual(["overdue"]);
    expect(summarizeJob(definition, observation(), [], [], new Date("2026-09-18T11:40:00.000Z"), due).status).toBe("UNKNOWN");
  });

  it("does not infer missed starts while provider collection is unavailable", () => {
    const value = summarizeJob(definition, observation({ coverage: "unavailable" }), [], [], NOW, "2026-09-18T10:00:00.000Z");
    expect(value.status).toBe("UNKNOWN");
    expect(incidentKinds(value)).not.toContain("overdue");
  });

  it("excludes execution outcomes outside the fixed 24-hour statistics window", () => {
    const old = run({ id: "old", status: "FAILED", startedAt: "2026-09-17T10:00:00.000Z", finishedAt: "2026-09-17T10:01:00.000Z" });
    const future = run({ id: "future", status: "FAILED", startedAt: "2026-09-18T13:00:00.000Z", finishedAt: "2026-09-18T13:01:00.000Z" });
    const value = summarizeJob(definition, observation(), [old, run(), future], [], NOW);
    expect(value.stats).toMatchObject({ executions: 1, failed: 0, succeeded: 1 });
  });

  it("keeps the last known weekday result visible outside the statistics window", () => {
    const friday = run();
    const sunday = new Date("2026-09-20T12:00:00.000Z");
    const observed = observation({ observedAt: sunday.toISOString(),
      windowStart: "2026-09-19T12:00:00.000Z", windowEnd: sunday.toISOString() });
    const value = summarizeJob(definition, observed, [friday], [], sunday);
    expect(value.latestRun?.id).toBe(friday.id);
    expect(value.lastSuccessAt).toBe(friday.finishedAt);
    expect(value.stats).toMatchObject({ executions: 0, successRate: null });
  });

  it("keeps an explicitly active execution stalled even when its start is older than 24 hours", () => {
    const active = run({ id: "old-active", status: "RUNNING", startedAt: "2026-09-17T10:00:00.000Z", finishedAt: null, durationMs: null });
    const value = summarizeJob(definition, observation(), [active, run()], [], NOW);
    expect(value.status).toBe("STALLED");
    expect(incidentKinds(value)).toContain("stalled");
    expect(value.stats.running).toBe(0);
  });

  it("cannot let a newer active attempt hide a separately confirmed stalled attempt", () => {
    const stalled = run({ id: "old-active", status: "RUNNING", startedAt: "2026-09-17T10:00:00.000Z", finishedAt: null, durationMs: null });
    const recent = run({ id: "new-active", status: "RUNNING", startedAt: "2026-09-18T11:55:00.000Z", finishedAt: null, durationMs: null });
    const value = summarizeJob(definition, observation(), [stalled, recent], [], NOW);
    expect(value.status).toBe("STALLED");
    expect(incidentKinds(value)).toContain("stalled");
  });

  it("keeps a retained but no-longer-confirmed active attempt Unknown rather than recovered", () => {
    const retained = run({ id: "old-active", status: "RUNNING", startedAt: "2026-09-17T10:00:00.000Z", finishedAt: null,
      observedAt: "2026-09-18T11:40:00.000Z", durationMs: null });
    const value = summarizeJob(definition, observation(), [retained, run()], [], NOW);
    expect(value.status).toBe("UNKNOWN");
    expect(value.monitoringStale).toBe(true);
    expect(incidentKinds(value)).toContain("monitoring_unavailable");
  });
});

describe("data jobs observation availability", () => {
  it.each(["provider_timeout", "provider_access_denied", "provider_invalid_response", "collector_budget_exceeded"])("treats %s as monitoring unavailable even with partial evidence", (code) => {
    expect(observationUnavailable(observation({ coverage: "partial", code }), NOW)).toBe(true);
  });

  it.each(["published_schedule_unavailable", "provider_execution_history_disabled", "provider_history_retention_unverified"])("keeps %s as an explicit coverage limit without inventing transport failure", (code) => {
    expect(observationUnavailable(observation({ coverage: "partial", code }), NOW)).toBe(false);
  });

  it("does not confuse fresh collection metadata with a full history window", () => {
    const partial = observation({ coverage: "partial", code: "provider_history_retention_unverified" });
    expect(observationUnavailable(partial, NOW)).toBe(false);
    const value = summarizeJob(definition, partial, [run()], [], NOW, "2026-09-18T10:00:00.000Z");
    expect(value.stats.successRate).toBeNull();
    expect(value.status).not.toBe("OVERDUE");
  });
});

describe("data jobs schedule checkpoints", () => {
  it("remembers the next normal scheduled time from a first observation", () => {
    expect(nextExpectedDue(null, observation())).toBe("2026-09-18T12:15:00.000Z");
  });

  it("does not let a newer provider schedule erase an unobserved expected run", () => {
    expect(nextExpectedDue("2026-09-18T11:30:00.000Z", observation())).toBe("2026-09-18T11:30:00.000Z");
  });

  it("does not clear a due date with an attempt that started before it", () => {
    const old = run({ startedAt: "2026-09-18T11:00:00.000Z", finishedAt: "2026-09-18T11:59:00.000Z" });
    expect(nextExpectedDue("2026-09-18T11:30:00.000Z", observation({ runs: [old] }))).toBe("2026-09-18T11:30:00.000Z");
  });

  it("advances after start evidence for the due interval is present", () => {
    expect(nextExpectedDue("2026-09-18T11:45:00.000Z", observation({ runs: [run()] }))).toBe("2026-09-18T12:15:00.000Z");
  });

  it("clears due dates when a provider explicitly disables the schedule", () => {
    expect(nextExpectedDue("2026-09-18T11:30:00.000Z", observation({ enabled: false }))).toBeNull();
  });

  it("does not substitute a provider wake or retry for the normal scheduled deadline", () => {
    const schedule = { ...UNKNOWN_SCHEDULE, kind: "scheduled" as const,
      nextWakeAt: "2026-09-18T12:01:00.000Z", nextWakeBasis: "provider" as const,
      nextRetryAt: "2026-09-18T12:01:00.000Z" };
    expect(nextExpectedDue(null, observation({ schedule }))).toBeNull();
  });

  it("does not invent a next scheduled run for manual or event workflows", () => {
    for (const kind of ["event", "manual"] as const) {
      expect(nextExpectedDue(null, observation({ schedule: { ...UNKNOWN_SCHEDULE, kind } }))).toBeNull();
    }
  });

  it("clears an obsolete due time after a positively observed manual/event trigger change", () => {
    for (const kind of ["event", "manual"] as const) {
      expect(nextExpectedDue("2026-09-18T11:30:00.000Z", observation({ schedule: { ...UNKNOWN_SCHEDULE, kind } }))).toBeNull();
    }
  });
});

describe("data jobs terminal update ordering", () => {
  it("accepts a terminal update after a running observation", () => {
    expect(shouldReplaceRun(run({ status: "RUNNING", finishedAt: null, observedAt: "2026-09-18T11:59:00.000Z" }), run())).toBe(true);
  });

  it("does not regress a terminal outcome to running or unknown even in a newer poll", () => {
    for (const status of ["RUNNING", "UNKNOWN"] as const) {
      expect(shouldReplaceRun(run(), run({ status, observedAt: "2026-09-18T12:01:00.000Z" }))).toBe(false);
    }
  });

  it("ignores an older observation instead of overwriting newer terminal evidence", () => {
    expect(shouldReplaceRun(run(), run({ status: "FAILED", observedAt: "2026-09-18T11:59:00.000Z" }))).toBe(false);
  });

  it("allows an idempotent terminal replay and a newer terminal correction", () => {
    expect(shouldReplaceRun(run(), run())).toBe(true);
    expect(shouldReplaceRun(run(), run({ status: "FAILED", observedAt: "2026-09-18T12:01:00.000Z" }))).toBe(true);
  });
});

describe("reviewed data job registry", () => {
  it("contains only the verified initial environment mappings", () => {
    const prod = getDataJobs("prod");
    const dev = getDataJobs("dev");
    expect(prod).toHaveLength(20);
    expect(dev).toHaveLength(12);
    expect(prod.filter((job) => job.provider === "cloud-scheduler")).toHaveLength(7);
    expect(dev.every((job) => job.provider === "n8n")).toBe(true);
    expect(dev.filter((job) => job.expectedEnabled)).toHaveLength(9);
  });

  it("keeps stable registry IDs unique and scoped even when provider IDs repeat", () => {
    const jobs = [...getDataJobs("prod"), ...getDataJobs("dev")];
    expect(new Set(jobs.map((job) => job.id)).size).toBe(32);
    for (const job of jobs) {
      expect(job.id).toMatch(/^[a-zA-Z0-9_-]{1,120}$/);
      expect(job.id.startsWith(`${job.environment}-`)).toBe(true);
      const url = new URL(job.jobUrl);
      expect(url.protocol).toBe("https:");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      if (job.provider === "n8n") {
        expect(url.origin).toBe(DATA_JOB_PROVIDER_CONFIG[job.environment].n8nOrigin);
      } else {
        expect(url.origin).toBe("https://console.cloud.google.com");
        expect(job.providerId).toMatch(/^projects\/ops-portal\/locations\/us-central1\/jobs\/[a-z0-9-]+$/);
      }
    }
  });

  it("does not share mutable consumers or definition objects between reads", () => {
    const mutated = getDataJobs("dev");
    mutated[0].name = "Changed";
    mutated[0].consumers.push("Changed");
    const fresh = getDataJobs("dev");
    expect(fresh[0].name).not.toBe("Changed");
    expect(fresh[0].consumers).not.toContain("Changed");
  });

  it("explicitly leaves operational owners unassigned instead of inventing a person", () => {
    expect(getDataJobs("prod").every((job) => job.owner.includes("owner not assigned"))).toBe(true);
  });
});
