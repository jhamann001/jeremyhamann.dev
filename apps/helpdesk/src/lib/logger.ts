/**
 * Structured JSON logging for the app runtime — route handlers, server actions, server components
 * and (guarded) the edge bundle.
 *
 * Why this module exists: security scanner SAST rule ("Caught Error Details Written to
 * Console", CWE-209) fires on every `console.error` / `console.warn` / `console.trace` that receives
 * a caught error or anything derived from it (`message`, `name`, `stack`, `cause`, `toString()`,
 * `JSON.stringify(error)`). The remediation security scanner itself prescribes is "log full details through a
 * centralized logger". This is that logger, and the rule it enforces is stricter than security scanner's: nothing
 * derived from a caught error ever reaches a sink at all.
 *
 * One JSON object per line, in the shape Cloud Logging parses natively (`severity` + `message`, every
 * other key kept as a structured field). Deliberately the same wire shape as the jobs runtime's
 * `src/jobs/logger.ts`, so a single Cloud Logging query reads both the web service and the Cloud Run
 * Jobs without a second parser.
 *
 * Two deliberate differences from `src/jobs/logger.ts`:
 *
 *  1. `errorLabel` here carries NO message text. The jobs logger logs a `sanitizePII`-scrubbed
 *     message because a job's only operator-visible trace is its log line. A request-scoped failure
 *     has the audit ledger and the action's own error envelope, so the log line only needs to say
 *     *which class of thing* broke. Dropping the message removes the entire CWE-209 surface rather
 *     than filtering it, and removes the `@/lib/pii` import that would otherwise make this module
 *     heavier than the edge bundle wants.
 *  2. The record is keyed by `logScope` (a route, action or component id) rather than `job`.
 *
 * WHY `logScope` AND NOT `scope`. The emitting surface's id is a reserved key — a caller field may
 * not overwrite it — and while it was called `scope`, any caller with a field of its own genuinely
 * named `scope` silently lost it. `src/lib/integration-scope.ts` was doing exactly that: it logs
 * which INTEGRATION scope had a misconfigured key, and that field never reached the line. The
 * reserved key carries the `log` prefix instead, so the two never collide again and a Cloud Logging
 * query stays one line and flat: `jsonPayload.logScope="integration-scope"` finds the surface,
 * `jsonPayload.scope="outbox"` finds the caller's own field. Nesting caller fields under a `fields`
 * object would have solved the same collision and made every query two levels deep; the jobs logger
 * flattens too, and one query has to read both.
 *
 * `console.*` is never called, not even as a fallback. A runtime with no writable stdio drops the
 * line instead: `console` is the sink CWE-209 watches, and an operational line nobody reviews is a
 * poor trade for a lint-visible exception in every future scan.
 *
 * Pure apart from `process` and the injected writer, imports no node builtin, and imports only L1
 * (`@/lib/errors`) — so it is safe to import from any layer, including middleware.
 */
import { isAppError } from "@/lib/errors";

export type LogSeverity = "INFO" | "WARNING" | "ERROR";

/** Structured fields carried alongside the message. Values are logged as-is, so pass no free text. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** A writer per stream. Injected in tests; `defaultWriters()` binds the real process streams. */
export type LogWriters = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export type Logger = {
  info(logScope: string, event: string, fields?: LogFields): void;
  warn(logScope: string, event: string, fields?: LogFields): void;
  /** The only entry point that takes a thrown value — and it records `errorLabel(e)`, nothing else. */
  error(logScope: string, e: unknown, fields?: LogFields): void;
};

/** Longest label a log line may carry. A class name that exceeds this is a bug, not a message. */
export const ERROR_LABEL_MAX_CHARS = 80;

/** The label a non-Error throw gets. `String(e)` is NOT used: a thrown string is attacker-shaped. */
export const UNKNOWN_ERROR_LABEL = "NonError" as const;

/**
 * A loggable label for a thrown value, and the only thing about a caught error that ever reaches a
 * sink: the constructor name, plus the `AppError` code when there is one (`ValidationError[INVALID]`).
 *
 * Never the message, never the stack, never `cause`, never `String(e)`. A Prisma error message quotes
 * the row that violated the constraint; a stack quotes source lines; a thrown string is whatever the
 * thrower chose. The class name is the one part of a caught error that is written by this codebase.
 */
export function errorLabel(e: unknown): string {
  if (!(e instanceof Error)) return UNKNOWN_ERROR_LABEL;
  const name = e.name === "" ? e.constructor.name : e.name;
  const label = isAppError(e) ? `${name}[${e.code}]` : name;
  return label.slice(0, ERROR_LABEL_MAX_CHARS);
}

/**
 * Keys the caller may not set: a surface cannot disguise its own identity in the log stream.
 *
 * `scope` is deliberately NOT on this list. It used to be the name of the identity key itself, which
 * meant a caller field genuinely named `scope` was dropped without a trace — see the module docstring.
 * The identity key is `logScope` now, and `scope` is an ordinary field like any other.
 */
export const RESERVED_KEYS: readonly string[] = ["severity", "time", "message", "logScope", "event"];

/** The exact JSON object a log call emits. Exported so tests assert the wire shape, not the writer. */
export function logRecord(
  logScope: string,
  severity: LogSeverity,
  event: string,
  at: Date,
  fields: LogFields = {},
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    severity,
    time: at.toISOString(),
    message: `${logScope}: ${event}`,
    logScope,
    event,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (RESERVED_KEYS.includes(key)) continue;
    record[key] = value;
  }
  return record;
}

/**
 * A logger over the given writers. INFO goes to stdout; WARNING and ERROR go to stderr, so a Cloud
 * Run revision's error stream stays the stream an operator tails.
 */
export function createLogger(writers: LogWriters): Logger {
  const emit = (severity: LogSeverity, logScope: string, event: string, fields?: LogFields): void => {
    const line = `${JSON.stringify(logRecord(logScope, severity, event, new Date(), fields))}\n`;
    if (severity === "INFO") writers.out(line);
    else writers.err(line);
  };
  return {
    info: (logScope, event, fields) => emit("INFO", logScope, event, fields),
    warn: (logScope, event, fields) => emit("WARNING", logScope, event, fields),
    error: (logScope, e, fields) => emit("ERROR", logScope, "failed", { ...fields, error: errorLabel(e) }),
  };
}

/**
 * Writers bound to the real process streams, resolved per call.
 *
 * `process.stdout` is absent in the edge runtime and in the browser bundle, and `process` itself can
 * be absent in a bare worker — hence the full guard rather than a `typeof window` check. When a
 * stream is missing the line is dropped: see the module docstring for why the fallback is not
 * `console.*`. Resolved per call, not once at module load, because a module-load read would capture
 * `undefined` in exactly the runtimes that acquire the stream later.
 */
export function defaultWriters(): LogWriters {
  const write = (stream: "stdout" | "stderr", line: string): void => {
    if (typeof process === "undefined") return;
    const target = process[stream];
    if (typeof target?.write !== "function") return;
    target.write(line);
  };
  return {
    out: (line) => write("stdout", line),
    err: (line) => write("stderr", line),
  };
}

const defaultLogger: Logger = createLogger({
  out: (line) => defaultWriters().out(line),
  err: (line) => defaultWriters().err(line),
});

/**
 * An operational event worth a line at INFO. Pass no free text — `fields` is structured only.
 *
 * `logScope` is the emitting surface (`route:/api/health`, `action:assignTicket`, `client-api`) and
 * lands on the line under that key. A field of your own named `scope` is kept as-is.
 */
export function logInfo(logScope: string, event: string, fields?: LogFields): void {
  defaultLogger.info(logScope, event, fields);
}

/** A degraded-but-handled condition. Same field rules as {@link logInfo}. */
export function logWarn(logScope: string, event: string, fields?: LogFields): void {
  defaultLogger.warn(logScope, event, fields);
}

/**
 * The replacement for `console.error("…", e)`: records `errorLabel(e)` and the caller's own fields.
 * There is no overload that accepts the error's message — that is the point of the module.
 *
 * ```ts
 * } catch (e) {
 *   logError("route:/api/tickets/export", e, { requestId: ctx.requestId, ticketId });
 * }
 * ```
 */
export function logError(logScope: string, e: unknown, fields?: LogFields): void {
  defaultLogger.error(logScope, e, fields);
}
