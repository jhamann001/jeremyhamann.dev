/**
 * Shared types for the jobs runtime.
 *
 * Kept in their own module so `run.ts` can import every job and every job can import the context type
 * without a cycle.
 */
import type { AuditActor, RequestContext } from "@/types/domain";
import type { JobLogger } from "@/jobs/logger";

/**
 * Every job name the desk knows. The CLI refuses anything else — there is no dynamic job registry,
 * and a scheduler asking for a name that is not here fails loudly rather than half-running.
 *
 * Wave A shipped the first three. Wave B adds five (the build record, "Job names for
 * `src/jobs/run.ts`"): `digest`, `out-of-office`, `auto-close` and `follow-up-nudges`, and
 * `webhook-dispatch`. The NAMES live here, in one closed union, because Cloud Scheduler
 * arguments, the Terraform job definitions and the runbook all have to agree with the process; the
 * HANDLERS are wired in `run.ts`, which is what a slice contributes to.
 */
export type JobName =
  | "sla-sweep"
  | "event-alerts"
  | "duplicate-copy"
  | "digest"
  | "out-of-office"
  | "auto-close"
  | "follow-up-nudges"
  | "webhook-dispatch"
  // Integration round 1 (B1's integration note §1.2): the out-of-band FAN-OUT. The five call sites
  // that CREATE notifications are foundation-owned and only `digest` drained the queue — once a day,
  // over a one-hour window — so in practice almost nothing was ever dispatched.
  | "notification-dispatch";

export const JOB_NAMES = [
  "sla-sweep",
  "event-alerts",
  "duplicate-copy",
  "digest",
  "out-of-office",
  "auto-close",
  "follow-up-nudges",
  "webhook-dispatch",
  "notification-dispatch",
] as const satisfies readonly JobName[];

/** What `runJob` reports and what `JOB_RUN` records (the JOB_RUN row). */
export type JobResult = {
  name: JobName;
  ok: boolean;
  processed: number;
  skipped: number;
  posted: number;
  durationMs: number;
};

/**
 * Everything a job needs and nothing it does not: the seeded machine actor, the evidentiary context every
 * audit row carries, the single `now` the whole run is evaluated against (so a sweep cannot classify two
 * tickets against two different clocks), and the run's logger.
 */
export type JobContext = {
  name: JobName;
  actor: AuditActor;
  ctx: RequestContext;
  now: Date;
  log: JobLogger;
};

/**
 * What a job hands back to the runtime. `ok` defaults to true; a job sets it false when it completed but
 * something inside it did not (a Slack post that failed, a chain verification that did not verify).
 * `metadata` is merged into the `JOB_RUN` audit row's metadata — structured facts only, never free text.
 */
export type JobOutcome = {
  processed: number;
  skipped: number;
  posted: number;
  ok?: boolean;
  metadata?: Record<string, string | number | boolean | null>;
};

export type JobHandler = (job: JobContext) => Promise<JobOutcome>;
