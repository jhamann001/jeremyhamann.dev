/**
 * Jobs runtime entry point — `tsx src/jobs/run.ts <job-name> [<job-name> …]`
 *.
 *
 * Nothing in this app ran on a clock before Wave A. This is the whole clock: one container image, one
 * command, one job name per argument, executed in order. There is no scheduler inside the process, no
 * daemon and no `setInterval` — Cloud Scheduler decides when, Cloud Run Jobs decides where, and this
 * decides what, once, and then exits.
 *
 * WHAT EVERY RUN GUARANTEES
 *  - **A seeded, still-active machine actor.** The run acts as the `svc_jobs` User row, so
 *    `AuditLog.actorId` stays a foreign key and "who did this" survives with no human present. Not
 *    `SYSTEM_ACTOR`, which costs the FK — that is the fallback only when the seeded row is missing and
 *    the alternative would be losing the JOB_RUN row entirely.
 *  - **One `JOB_RUN` audit row**, awaited at the end, recording the outcome and the counts.
 *    It is written even when the job threw: a run that failed is a fact about the desk.
 *  - **`metadata.via = "job"`** on every row the run writes, so `metadata->>'via'` partitions the ledger.
 *  - **Structured JSON logs** on stdout, one object per line, PII-sanitized.
 *  - **Idempotence.** Each job is safe to re-run: the sweep dedupes on a unique constraint, the alert job
 *    on a durable cursor, the duplicate copy on a date-keyed prefix.
 *  - **An exit code that means something.** 0 only when every requested job reported ok.
 */
import { pathToFileURL } from "node:url";
import {
  AUDIT_VIA,
  SYSTEM_ACTOR,
  actorFromMachineUser,
  resolveJobActorEmail,
  systemRequestContext,
  writeAudit,
} from "@/lib/audit";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { AuditActor } from "@/types/domain";
import { JOB_NAMES } from "@/jobs/types";
import type { JobContext, JobHandler, JobName, JobResult } from "@/jobs/types";
import { createJobLogger, errorLabel } from "@/jobs/logger";
import { runSlaSweep } from "@/jobs/sla-sweep";
import { runEventAlerts } from "@/jobs/event-alerts";
import { runDuplicateCopy } from "@/jobs/duplicate-copy";
import { runOutOfOffice } from "@/jobs/out-of-office";
import { runAutoClose } from "@/jobs/auto-close";
import { runFollowUpNudges } from "@/jobs/follow-up-nudges";
import { runDigestJob } from "@/jobs/digest";
import { runNotificationDispatchJob } from "@/server/notifications-dispatch";
import { runWebhookDispatchJob } from "@/jobs/webhook-dispatch";

export type { JobName, JobResult } from "@/jobs/types";

/**
 * The names whose handler this build actually carries.
 *
 * `JOB_NAMES` (src/jobs/types.ts) is the DECLARED surface — every job the desk is scheduled to run,
 * because Cloud Scheduler, Terraform and the runbook all key off it. This is the subset that is
 * WIRED. The two are deliberately allowed to differ, and the difference is loud rather than silent:
 * `handlerFor` throws for a declared name with no handler, `runJob` records that throw as a failed
 * `JOB_RUN` row with the reason, and the process exits non-zero, which Cloud Run Jobs shows as a
 * failed execution.
 *
 * Wave B splits the job bodies across slices: B4 owns this registry, B1 contributes
 * `digest` and B5 contributes `webhook-dispatch`, each as a `(JobContext) => Promise<JobOutcome>`
 * beside the module's own richer entry point. Both had landed when this registry was wired, so all
 * eight declared names are registered and `UNREGISTERED_JOB_NAMES` is empty. If a future wave
 * declares a name before its body exists, that is the shape this file is built to survive: the
 * scheduler's call fails loudly with the slice named, rather than reporting success for a job that
 * does not exist — which is how a digest nobody receives looks healthy for a month.
 */
export const REGISTERED_JOB_NAMES = [
  "sla-sweep",
  "event-alerts",
  "duplicate-copy",
  "out-of-office",
  "auto-close",
  "follow-up-nudges",
  "digest",
  "webhook-dispatch",
  "notification-dispatch",
] as const satisfies readonly JobName[];

export type RegisteredJobName = (typeof REGISTERED_JOB_NAMES)[number];

/** The only dispatch table. A name that is not a key here is not a job this build can run. */
export const JOB_HANDLERS: Readonly<Record<RegisteredJobName, JobHandler>> = {
  "sla-sweep": runSlaSweep,
  "event-alerts": runEventAlerts,
  "duplicate-copy": (job) => runDuplicateCopy(job),
  "out-of-office": runOutOfOffice,
  "auto-close": runAutoClose,
  "follow-up-nudges": runFollowUpNudges,
  digest: runDigestJob,
  "webhook-dispatch": runWebhookDispatchJob,
  // B1's fan-out, registered in integration round 1. Idempotent (it leases what it sends), so a
  // double fire costs one query and sends nothing twice. Suggested cadence: every 5 minutes, the same
  // as `sla-sweep`. It transmits nothing while SLACK_USER_MAP and the VAPID keys are unset.
  "notification-dispatch": runNotificationDispatchJob,
};

/** Declared in `JOB_NAMES` but not wired here. Empty is the goal; non-empty is a fact, not a stub. */
export const UNREGISTERED_JOB_NAMES: readonly JobName[] = JOB_NAMES.filter(
  (n) => !(REGISTERED_JOB_NAMES as readonly string[]).includes(n),
);

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

export function isRegisteredJobName(name: JobName): name is RegisteredJobName {
  return (REGISTERED_JOB_NAMES as readonly string[]).includes(name);
}

/**
 * The handler for a DECLARED job, or a loud INTERNAL error naming the slice that owes it.
 *
 * This is the gate `runJob` goes through, and it is two gates stacked, one per wave:
 *
 *  - Wave B's: a name in `JOB_NAMES` with no entry in `JOB_HANDLERS` fails here, naming the file and
 *    the note that says which two lines wire it, rather than reporting success for a job that does
 *    not exist. `UNREGISTERED_JOB_NAMES` is empty today; the mechanism is what makes that provable.
 *  - Wave A's: the actual lookup is delegated to {@link jobHandlerFor}, an allowlisted `switch`, so no
 *    argv-derived string ever indexes the registry. `return JOB_HANDLERS[name]` here would have put
 *    back exactly the dynamic member access the security scanner sweep removed (CWE-94;
 *    the build record)
 */
export function handlerFor(name: JobName): JobHandler {
  if (!isRegisteredJobName(name)) {
    throw new AppError(
      "INTERNAL",
      `The job "${name}" is declared in JOB_NAMES but no handler is registered in src/jobs/run.ts; ` +
        `add it to JOB_HANDLERS and to the switch in jobHandlerFor`,
      500,
    );
  }
  return jobHandlerFor(name);
}

/**
 * The job name to its handler, through an explicit allowlisted dispatch.
 *
 * This is deliberately a `switch` over literal keys rather than `JOB_HANDLERS[name]`. The name
 * reaching `runJob` comes from `process.argv` — Cloud Scheduler's job arguments — and security scanner reports an
 * object indexed by that kind of value as "Unsafe Dynamic Method Invocation" (CWE-94),
 * whose own prescribed remedy is exactly this: a whitelist the caller's
 * string cannot walk outside of. `parseJobNames` already refuses an unknown name, so the throw below
 * is the second of two gates, not the first — but it is the one that holds for a caller that skipped
 * the first, and it is the one that makes the property access static.
 *
 * Every lookup is a literal key, so no argv-derived string ever selects a property: `Object`'s own
 * members (`constructor`, `__proto__`, `toString`) are unreachable here by construction rather than
 * by a `hasOwnProperty` check somebody has to remember to keep. The registry object is still the
 * thing read, so a test can replace one handler on it.
 *
 * It takes a `RegisteredJobName` — the WIRED subset, not the declared surface — because that is the
 * union the `default` branch has to exhaust. Wave B allows `JOB_NAMES` to carry a name this build has
 * no body for, and that case belongs to {@link handlerFor}, which reports it as the missing-slice
 * INTERNAL error rather than as a bad argument. Adding a job is still three edits the compiler forces
 * together: `JOB_NAMES`, `JOB_HANDLERS`/`REGISTERED_JOB_NAMES`, and a `case` here — omit the last and
 * `name` is not `never` in the default branch and `tsc` fails.
 */
export function jobHandlerFor(name: RegisteredJobName): JobHandler {
  switch (name) {
    case "sla-sweep":
      return JOB_HANDLERS["sla-sweep"];
    case "event-alerts":
      return JOB_HANDLERS["event-alerts"];
    case "duplicate-copy":
      return JOB_HANDLERS["duplicate-copy"];
    case "out-of-office":
      return JOB_HANDLERS["out-of-office"];
    case "auto-close":
      return JOB_HANDLERS["auto-close"];
    case "follow-up-nudges":
      return JOB_HANDLERS["follow-up-nudges"];
    case "digest":
      return JOB_HANDLERS["digest"];
    case "webhook-dispatch":
      return JOB_HANDLERS["webhook-dispatch"];
    case "notification-dispatch":
      return JOB_HANDLERS["notification-dispatch"];
    default: {
      const unknown: never = name;
      throw new AppError(
        "VALIDATION",
        `Unknown job name: ${JSON.stringify(unknown as string)}. Expected one of: ${JOB_NAMES.join(", ")}`,
        400,
      );
    }
  }
}

/**
 * Argv to job names. Refuses an empty list and refuses an unknown name outright rather than running the
 * ones it recognised: a scheduler sending `sla-sweeep` should fail loudly, not half-run.
 */
export function parseJobNames(argv: readonly string[]): JobName[] {
  const names = argv.map((a) => a.trim()).filter((a) => a !== "");
  if (names.length === 0) {
    throw new AppError("VALIDATION", `No job name given. Expected one of: ${JOB_NAMES.join(", ")}`, 400);
  }
  const unknown = names.filter((n) => !isJobName(n));
  if (unknown.length > 0) {
    throw new AppError("VALIDATION", `Unknown job name(s): ${unknown.join(", ")}. Expected: ${JOB_NAMES.join(", ")}`, 400);
  }
  return names.filter(isJobName);
}

/**
 * The address of the jobs identity: the configured override when there is one, the seeded
 * `jobs@wm-helpdesk.local` otherwise. A blank or whitespace-only override counts as unset, which is the
 * convention `src/lib/env.ts` applies to every optional string.
 *
 * Re-exported from `@/lib/audit`, which owns the single definition (integration round 3): the same
 * resolution decides who the jobs run AS here and which rows `src/server/users.ts` hides from
 * `/admin/users` and refuses in `deactivateUser`. `users.ts` cannot import this module — that would pull
 * the jobs runtime (Slack, the object store) into a page's server bundle — so the shared rule lives one
 * layer down, beside the two constants it chooses between, instead of being written out twice.
 */
export { resolveJobActorEmail };

/** {@link resolveJobActorEmail} against this process's environment. */
export function jobActorEmail(): string {
  return resolveJobActorEmail(env.JOB_ACTOR_EMAIL);
}

/**
 * The seeded jobs identity. `JOB_ACTOR_EMAIL` (env) overrides the seeded default so a deployment can point
 * the runtime at a differently named row without a code change; unset means the seeded
 * `jobs@wm-helpdesk.local`.
 *
 * Reads `isActive` and refuses an inactive row, exactly like `integrationActor` in
 * src/lib/integration-auth.ts. Disabling the `svc_jobs` row is the ONLY lever an operator has for closing
 * this surface — `prisma/machine-users.ts` deliberately does not re-enable it on deploy and the seed
 * prints that the surface "stays closed" — and that sentence is only true if the runtime honours it here.
 * Without this check the sweep, the alerts and the nightly copy would keep running, keep posting to Slack
 * and keep writing `SLA_ALERT` / `JOB_RUN` rows into the hash-chained ledger attributed to an identity an
 * administrator deliberately disabled.
 *
 * Failing closed is loud, not silent: `runJob` catches the throw, records `ok: false` with the failure
 * label on the `JOB_RUN` row, and the non-zero exit turns it into a failed Cloud Run Jobs execution.
 */
export async function jobActor(): Promise<AuditActor> {
  const email = jobActorEmail();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, isActive: true },
  });
  if (user === null) {
    throw new AppError("INTERNAL", `The jobs actor ${email} is not seeded; run prisma db seed before scheduling jobs`, 500);
  }
  if (!user.isActive) {
    throw new AppError(
      "INTERNAL",
      `The jobs actor ${email} is deactivated; re-enable it deliberately before the scheduled jobs can run`,
      500,
    );
  }
  return actorFromMachineUser({ id: user.id, email: user.email });
}

/**
 * Runs one job end to end and records it.
 *
 * The `JOB_RUN` row is written in a `finally`-shaped tail rather than inside the job, so a job that threw
 * still lands on the ledger. It is a single awaited insert outside any transaction — there is no business
 * write to attach it to, and the job's own state changes were already committed with their own audit rows.
 */
export async function runJob(name: JobName): Promise<JobResult> {
  const startedAt = Date.now();
  const ctx = systemRequestContext(`job-${name}`);
  const log = createJobLogger(name, ctx.requestId);

  let actor: AuditActor = SYSTEM_ACTOR;
  let ok = true;
  let processed = 0;
  let skipped = 0;
  let posted = 0;
  let metadata: Record<string, string | number | boolean | null> = {};
  let failure: string | null = null;

  log.info("start");

  try {
    actor = await jobActor();
    const job: JobContext = { name, actor, ctx, now: new Date(), log };
    // `handlerFor` is the declared-name gate; it delegates the lookup itself to the allowlisted
    // `jobHandlerFor` switch, so the argv-derived name never indexes the registry.
    const outcome = await handlerFor(name)(job);
    processed = outcome.processed;
    skipped = outcome.skipped;
    posted = outcome.posted;
    ok = outcome.ok ?? true;
    metadata = { ...(outcome.metadata ?? {}) };
  } catch (e) {
    ok = false;
    failure = errorLabel(e);
    log.error("failed", { error: failure });
  }

  const durationMs = Date.now() - startedAt;
  const result: JobResult = { name, ok, processed, skipped, posted, durationMs };

  try {
    await writeAudit(prisma, actor, ctx, {
      action: "JOB_RUN",
      entityType: "JOB",
      entityId: name,
      fieldChanged: "outcome",
      newValue: ok ? "ok" : "failed",
      metadata: {
        ...metadata,
        durationMs,
        processed,
        skipped,
        posted,
        via: AUDIT_VIA.job,
        jobName: name,
        ...(failure === null ? {} : { error: failure }),
        ...(actor.id === null
          ? { actorFallback: "SYSTEM_ACTOR: the jobs user was not found or is deactivated" }
          : {}),
      },
    });
  } catch (e) {
    // The ledger write is the one failure that must not be swallowed quietly: a job that ran without
    // leaving a JOB_RUN row is a run nobody can prove happened.
    log.error("audit-write-failed", { error: errorLabel(e) });
    return { ...result, ok: false };
  }

  log.info("finish", { ok, processed, skipped, posted, durationMs });
  return result;
}

/** Runs the requested jobs in order. Every job runs even if an earlier one failed; the worst result wins. */
export async function runJobs(names: readonly JobName[]): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const name of names) {
    results.push(await runJob(name));
  }
  return results;
}

/** 0 when every job reported ok, 1 otherwise. Cloud Run Jobs turns a non-zero exit into a failed execution. */
export function exitCodeFor(results: readonly JobResult[]): number {
  return results.every((r) => r.ok) ? 0 : 1;
}

/** The CLI. Exported so the tests can drive it with an injected argv and without touching `process.exit`. */
export async function main(argv: readonly string[]): Promise<number> {
  let names: JobName[];
  try {
    names = parseJobNames(argv);
  } catch (e) {
    process.stderr.write(`${errorLabel(e)}\n`);
    return 2;
  }
  const results = await runJobs(names);
  return exitCodeFor(results);
}

/** True only when this file is the process entry point — never under vitest, which runs its own binary. */
export function isEntryPoint(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined || entry === "") return false;
  try {
    return pathToFileURL(entry).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  void (async () => {
    let code = 1;
    try {
      code = await main(process.argv.slice(2));
    } catch (e) {
      process.stderr.write(`${errorLabel(e)}\n`);
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
    process.exitCode = code;
  })();
}
