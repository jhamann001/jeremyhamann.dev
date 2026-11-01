import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import {
  JOB_HANDLERS,
  REGISTERED_JOB_NAMES,
  UNREGISTERED_JOB_NAMES,
  exitCodeFor,
  handlerFor,
  isEntryPoint,
  isJobName,
  isRegisteredJobName,
  jobHandlerFor,
  parseJobNames,
} from "@/jobs/run";
import { JOB_NAMES } from "@/jobs/types";
import type { JobResult } from "@/jobs/types";
import { AppError } from "@/lib/errors";

function result(overrides: Partial<JobResult> = {}): JobResult {
  return { name: "sla-sweep", ok: true, processed: 0, skipped: 0, posted: 0, durationMs: 1, ...overrides };
}

describe("the job registry", () => {
  it("has exactly one handler per registered job name", () => {
    expect(Object.keys(JOB_HANDLERS).sort()).toEqual([...REGISTERED_JOB_NAMES].sort());
  });

  it("carries all nine Wave A + Wave B job names", () => {
    // Cloud Scheduler, the Terraform job definitions and the build record all key off this list, so a
    // name added to one and not the others is a scheduled execution that fails at argument parsing.
    // `notification-dispatch` was added in integration round 1 (B1's note §1.2): the fan-out had no
    // job, so only `digest` ever drained the queue — once a day, over a one-hour window.
    expect([...JOB_NAMES].sort()).toEqual([
      "auto-close",
      "digest",
      "duplicate-copy",
      "event-alerts",
      "follow-up-nudges",
      "notification-dispatch",
      "out-of-office",
      "sla-sweep",
      "webhook-dispatch",
    ]);
  });

  it("registers every declared name — nothing is scheduled that this build cannot run", () => {
    expect(UNREGISTERED_JOB_NAMES).toEqual([]);
    for (const name of JOB_NAMES) {
      expect(isRegisteredJobName(name), name).toBe(true);
      expect(typeof handlerFor(name), name).toBe("function");
    }
  });

  it("fails loudly, naming the file to fix, for a declared name with no handler", () => {
    // The shape this registry is built to survive: a future wave declaring a job before its body
    // lands. `runJob` catches this, records a failed JOB_RUN row with the reason, and exits non-zero —
    // never a scheduled execution that reports success for a job that does not exist.
    expect(() => handlerFor("not-a-job" as (typeof JOB_NAMES)[number])).toThrow(AppError);
    expect(() => handlerFor("not-a-job" as (typeof JOB_NAMES)[number])).toThrow(/no handler is registered/);
  });

  it("recognises only the declared names", () => {
    for (const name of JOB_NAMES) expect(isJobName(name)).toBe(true);
    expect(isJobName("sla-sweeep")).toBe(false);
    expect(isJobName("")).toBe(false);
    expect(isJobName("SLA-SWEEP")).toBe(false);
  });
});

describe("jobHandlerFor", () => {
  it("has a literal `case` for every registered name — all nine, not just Wave A's three", () => {
    // The allowlisted switch is the security scanner fix (CWE-94), and it is the one
    // structure a new job has to be added to. A Wave B job registered in JOB_HANDLERS but missing its
    // `case` falls into the default branch, so this loop is what catches the half-wired job — `tsc`
    // catches it too, via the `never` narrowing, but only while the registered union is exhaustive.
    for (const name of REGISTERED_JOB_NAMES) {
      expect(jobHandlerFor(name), name).toBe(JOB_HANDLERS[name]);
    }
    expect(REGISTERED_JOB_NAMES).toHaveLength(9);
  });

  it("routes every declared name through the allowlist, not through a property lookup", () => {
    // `handlerFor` is the declared-name gate and `jobHandlerFor` is the dispatch; `runJob` calls the
    // former, so this is the assertion that the former did not go back to `JOB_HANDLERS[name]`.
    for (const name of JOB_NAMES) {
      expect(isRegisteredJobName(name), name).toBe(true);
      if (!isRegisteredJobName(name)) continue;
      expect(handlerFor(name), name).toBe(jobHandlerFor(name));
    }
  });

  it("refuses a name that is not a job instead of returning something callable", () => {
    // The dispatch is a switch over literal keys, so an argv-derived string selects nothing: these
    // all land in the default branch. `constructor`, `toString` and `__proto__` are the reason the
    // rule (CWE-94) exists — an object lookup returns a real function
    // for each of them, and `JOB_HANDLERS[name](job)` would have called it.
    for (const name of ["sla-sweeep", "", "SLA-SWEEP", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(() => jobHandlerFor(name as never)).toThrow(AppError);
      expect(() => jobHandlerFor(name as never)).toThrow(/Unknown job name/);
    }
  });

  it("reads the registry at call time, so a handler can be replaced in a test", () => {
    // `runJob` goes through `handlerFor`, which delegates here; `run-actor.test.ts` spies on
    // JOB_HANDLERS. A dispatch that closed over the handler at module load would make that spy
    // silently ineffective, so both entry points are asserted. A Wave B name is covered as well as a
    // Wave A one: the new `case` arms have to read the registry, not capture it.
    for (const name of ["event-alerts", "webhook-dispatch"] as const) {
      const original = JOB_HANDLERS[name];
      const replacement = vi.fn(async () => ({ processed: 0, skipped: 0, posted: 0 }));
      const registry = JOB_HANDLERS as Record<string, typeof original>;
      registry[name] = replacement;
      try {
        expect(jobHandlerFor(name), name).toBe(replacement);
        expect(handlerFor(name), name).toBe(replacement);
      } finally {
        registry[name] = original;
      }
      expect(jobHandlerFor(name), name).toBe(original);
    }
  });
});

describe("parseJobNames", () => {
  it("accepts one name", () => {
    expect(parseJobNames(["duplicate-copy"])).toEqual(["duplicate-copy"]);
  });

  it("accepts several, preserving the order the scheduler asked for", () => {
    expect(parseJobNames(["sla-sweep", "event-alerts"])).toEqual(["sla-sweep", "event-alerts"]);
  });

  it("trims and drops blank arguments", () => {
    expect(parseJobNames(["  sla-sweep  ", "", "   "])).toEqual(["sla-sweep"]);
  });

  it("refuses an empty list rather than defaulting to something", () => {
    expect(() => parseJobNames([])).toThrow(AppError);
    expect(() => parseJobNames(["  "])).toThrow(/No job name given/);
  });

  it("refuses the whole list when one name is unknown, instead of half-running it", () => {
    expect(() => parseJobNames(["sla-sweep", "sla-sweeep"])).toThrow(/Unknown job name\(s\): sla-sweeep/);
  });
});

describe("exitCodeFor", () => {
  it("is 0 only when every job reported ok", () => {
    expect(exitCodeFor([result(), result({ name: "event-alerts" })])).toBe(0);
    expect(exitCodeFor([result(), result({ name: "event-alerts", ok: false })])).toBe(1);
    expect(exitCodeFor([])).toBe(0);
  });
});

describe("isEntryPoint", () => {
  it("is true only for the file that is actually being executed", () => {
    const url = pathToFileURL("/app/src/jobs/run.ts").href;
    expect(isEntryPoint("/app/src/jobs/run.ts", url)).toBe(true);
    expect(isEntryPoint("/app/node_modules/.bin/vitest", url)).toBe(false);
    expect(isEntryPoint(undefined, url)).toBe(false);
    expect(isEntryPoint("", url)).toBe(false);
  });

  it("is false in this very test file, which is why importing run.ts runs nothing", () => {
    expect(isEntryPoint(process.argv[1], import.meta.url)).toBe(false);
  });
});
