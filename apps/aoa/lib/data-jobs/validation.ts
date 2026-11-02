import { z } from "zod";
import type { JobDefinition, JobObservation } from "./contracts";
import type { N8nCollectionState } from "./providers/n8n-coverage";

const date = z.string().datetime({ offset: true });
const identifier = z.string().regex(/^[a-zA-Z0-9_:/.-]{1,240}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const checkpointSchema = z.object({
  schemaVersion: z.literal(1), proofId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  startedCoverageFrom: date, startedCoverageThrough: date,
  invalidatedAt: date.nullable().optional(),
  pendingExecutionIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)).max(150),
});

/** Storage validation is independent of deployment proof; adapter rechecks that proof on use. */
export function validateProviderCheckpoint(input: unknown): N8nCollectionState {
  const value = checkpointSchema.parse(input);
  if (Date.parse(value.startedCoverageFrom) > Date.parse(value.startedCoverageThrough)
    || new Set(value.pendingExecutionIds).size !== value.pendingExecutionIds.length
    || Buffer.byteLength(JSON.stringify(value), "utf8") >= 24000) throw new Error("invalid_provider_checkpoint");
  return value;
}
const run = z.object({
  id: identifier, jobId: identifier, logicalRunId: identifier.nullable(), retryOf: identifier.nullable(),
  correlation: z.enum(["exact", "attempt_only", "event_only"]),
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "ACKNOWLEDGED", "UNKNOWN"]),
  evidence: z.enum(["provider_execution", "delivery_only", "application_commit"]),
  startedAt: date.nullable(), finishedAt: date.nullable(), observedAt: date,
  durationMs: count, recordsProcessed: count, recordsRejected: count,
  code: z.string().regex(/^[a-zA-Z0-9_:-]{1,80}$/).nullable(), executionUrl: z.string().max(2048).nullable(),
});
const observationSchema = z.object({
  jobId: identifier, observedAt: date, enabled: z.boolean().nullable(),
  schedule: z.object({
    kind: z.enum(["scheduled", "manual", "event", "unknown"]), expression: z.string().max(1500).nullable(),
    timezone: z.string().max(100).nullable(), nextRunAt: date.nullable(),
    nextRunBasis: z.enum(["provider", "calculated", "unknown"]), nextRetryAt: date.nullable(),
    nextWakeAt: date.nullable().optional(), nextWakeBasis: z.enum(["provider", "unknown"]).optional(),
  }),
  runs: z.array(run).max(6000), coverage: z.enum(["complete_window", "partial", "unavailable"]),
  windowStart: date, windowEnd: date, code: z.string().regex(/^[a-zA-Z0-9_:-]{1,80}$/).nullable(),
});

export function validateObservation(definition: JobDefinition, input: unknown): JobObservation {
  const value = observationSchema.parse(input);
  if (value.jobId !== definition.id || Date.parse(value.windowStart) > Date.parse(value.windowEnd)) throw new Error("invalid_job_observation");
  const origin = new URL(definition.jobUrl).origin;
  for (const entry of value.runs) {
    if (entry.jobId !== definition.id) throw new Error("invalid_job_run");
    if (entry.executionUrl) {
      const url = new URL(entry.executionUrl);
      if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) throw new Error("invalid_execution_url");
    }
  }
  // Zod strips all fields outside this allowlist before persistence.
  return value;
}
