/**
 * Captures the structured lines `@/lib/logger` writes, for tests that used to spy on `console.*`.
 *
 * `src/lib/logger.ts` never calls `console` — that is the whole point of it, because `console` is the
 * sink security scanner's CWE-209 rule watches — so `vi.spyOn(console, "warn")` now observes nothing at all. The
 * sink is `process.stdout.write` (INFO) and `process.stderr.write` (WARNING, ERROR), one JSON object
 * per line, and this captures that instead. Asserting on the parsed record is stricter than the old
 * `console` spy was: the severity, the emitting surface (`logScope`), the event and every field are
 * checkable, rather than whatever `args.map(String).join(" ")` happened to produce.
 *
 * Only lines that parse as one of the logger's records are captured. Anything else a test or a
 * library writes to the stream is passed straight through to the real writer, so this never
 * swallows a reporter's output or a stack trace.
 *
 * Restore it in an `afterEach` (or a `finally`). `vi.restoreAllMocks()` also restores it, since the
 * hooks are `vi.spyOn` mocks.
 */
import { vi, type MockInstance } from "vitest";

/** One parsed log line. `severity`, `time`, `message`, `logScope` and `event` are always present. */
export type LogRecord = Record<string, unknown>;

export type LogCapture = {
  /** INFO records, in write order. */
  readonly out: LogRecord[];
  /** WARNING and ERROR records, in write order. */
  readonly err: LogRecord[];
  /** Every captured record across both streams, in per-stream order (`out` then `err`). */
  all(): LogRecord[];
  /** The captured records whose `severity` matches, across both streams. */
  at(severity: "INFO" | "WARNING" | "ERROR"): LogRecord[];
  /** Drops what has been captured so far, without unhooking. */
  clear(): void;
  /** Unhooks both streams. */
  restore(): void;
};

/** A written chunk is one of our records only if it is a single JSON object carrying the fixed keys. */
function parseRecord(chunk: unknown): LogRecord | null {
  if (typeof chunk !== "string") return null;
  const text = chunk.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as LogRecord;
  const severity = record.severity;
  if (severity !== "INFO" && severity !== "WARNING" && severity !== "ERROR") return null;
  if (typeof record.logScope !== "string" || typeof record.event !== "string") return null;
  return record;
}

export function captureLogs(): LogCapture {
  const out: LogRecord[] = [];
  const err: LogRecord[] = [];

  const spies: MockInstance[] = [];
  const hook = (stream: NodeJS.WriteStream, sink: LogRecord[]): void => {
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    const spy = vi.spyOn(stream, "write").mockImplementation(((...args: unknown[]) => {
      const record = parseRecord(args[0]);
      if (record === null) return original(...args);
      sink.push(record);
      return true;
    }) as typeof stream.write);
    spies.push(spy);
  };

  hook(process.stdout, out);
  hook(process.stderr, err);

  return {
    out,
    err,
    all: () => [...out, ...err],
    at: (severity) => [...out, ...err].filter((r) => r.severity === severity),
    clear: () => {
      out.length = 0;
      err.length = 0;
    },
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
