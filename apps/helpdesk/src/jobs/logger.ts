/**
 * Structured JSON logging for the jobs runtime — node only.
 *
 * One JSON object per line on stdout, in the shape Cloud Logging parses natively (`severity` +
 * `message`, every other key kept as a structured field). Nothing here ever writes a ticket subject,
 * a requester address or a body: a log line is an operational record, not a copy of the ledger, and
 * the same PII-light rule that binds the Slack lines binds these (§10 "PII-light rule").
 *
 * Error text is passed through `sanitizePII` before it is logged. A Prisma error message can quote the
 * row that violated a constraint, so an unsanitized `e.message` is a plausible route for client data to
 * reach a log sink that is not the append-only ledger.
 */
import { sanitizePII } from "@/lib/pii";
import { isAppError } from "@/lib/errors";

export type JobLogSeverity = "INFO" | "WARNING" | "ERROR";

/** Structured fields carried alongside the message. Values are logged as-is, so pass no free text. */
export type JobLogFields = Record<string, string | number | boolean | null | undefined>;

export type JobLogger = {
  info(event: string, fields?: JobLogFields): void;
  warn(event: string, fields?: JobLogFields): void;
  error(event: string, fields?: JobLogFields): void;
};

/** Longest error text a log line may carry after sanitization. */
export const JOB_ERROR_LABEL_MAX_CHARS = 300;

/**
 * A loggable, sanitized label for a thrown value: the error name, the AppError code when there is one,
 * and the PII-sanitized message truncated to {@link JOB_ERROR_LABEL_MAX_CHARS}. Never a stack trace —
 * stacks quote source lines and, through Prisma, occasionally the offending row.
 */
export function errorLabel(e: unknown): string {
  if (e instanceof Error) {
    const code = isAppError(e) ? `[${e.code}] ` : "";
    const message = sanitizePII(e.message).text.slice(0, JOB_ERROR_LABEL_MAX_CHARS);
    return `${e.name}: ${code}${message}`;
  }
  return sanitizePII(String(e)).text.slice(0, JOB_ERROR_LABEL_MAX_CHARS);
}

/** The exact JSON object a log call emits. Exported so the tests assert the wire shape, not the writer. */
export function jobLogRecord(
  job: string,
  requestId: string,
  severity: JobLogSeverity,
  event: string,
  at: Date,
  fields: JobLogFields = {},
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    severity,
    time: at.toISOString(),
    message: `${job}: ${event}`,
    job,
    event,
    requestId,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    // Reserved keys are never overwritten: a job may not disguise its own identity in the log stream.
    if (key in record) continue;
    record[key] = value;
  }
  return record;
}

/**
 * A logger bound to one job run. Writes to stdout synchronously — a Cloud Run Job container can exit
 * before an async sink flushes, and a lost line about a failed alert is exactly the line that matters.
 */
export function createJobLogger(job: string, requestId: string, write: (line: string) => void = defaultWrite): JobLogger {
  const emit = (severity: JobLogSeverity, event: string, fields?: JobLogFields): void => {
    write(`${JSON.stringify(jobLogRecord(job, requestId, severity, event, new Date(), fields))}\n`);
  };
  return {
    info: (event, fields) => emit("INFO", event, fields),
    warn: (event, fields) => emit("WARNING", event, fields),
    error: (event, fields) => emit("ERROR", event, fields),
  };
}

function defaultWrite(line: string): void {
  process.stdout.write(line);
}
