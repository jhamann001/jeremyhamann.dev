/**
 * `src/lib/logger.ts` — the app-runtime structured logger that replaces every `console.error(…, e)`
 * flagged by security scanner (CWE-209).
 *
 * The claims worth a test are the ones a future edit could quietly break:
 *  1. No caught-error text — message, stack or cause — can reach a writer, whatever is thrown.
 *  2. The wire shape matches `src/jobs/logger.ts`, so one Cloud Logging parser reads both runtimes.
 *  3. Severity picks the stream (INFO → stdout, WARNING/ERROR → stderr).
 *  4. The module never calls `console.*`, including as a fallback (asserted over the source text).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ERROR_LABEL_MAX_CHARS,
  RESERVED_KEYS,
  UNKNOWN_ERROR_LABEL,
  createLogger,
  defaultWriters,
  errorLabel,
  logRecord,
  type LogWriters,
} from "@/lib/logger";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

/** A writer pair that records what each stream received, so a test asserts the routing too. */
function capture(): { writers: LogWriters; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { writers: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function parse(line: string): Record<string, unknown> {
  expect(line.endsWith("\n")).toBe(true);
  return JSON.parse(line) as Record<string, unknown>;
}

describe("errorLabel", () => {
  it("is the class name for a plain Error, and never its message", () => {
    expect(errorLabel(new Error("requester bob@example.com not found"))).toBe("Error");
  });

  it("carries the AppError code alongside the class name", () => {
    expect(errorLabel(new AppError("INTERNAL", "connection to db-prod refused", 500))).toBe("AppError[INTERNAL]");
    expect(errorLabel(new NotFoundError("ticket 42 is gone"))).toBe("NotFoundError[NOT_FOUND]");
    expect(errorLabel(new ForbiddenError("agent may not read this"))).toBe("ForbiddenError[FORBIDDEN]");
    expect(errorLabel(new ValidationError("subject is required"))).toBe("ValidationError[VALIDATION]");
  });

  it("never returns the text of a thrown non-Error", () => {
    expect(errorLabel("bearer ya29.a0AfH6 rejected for bob@example.com")).toBe(UNKNOWN_ERROR_LABEL);
    expect(errorLabel({ message: "requester bob@example.com" })).toBe(UNKNOWN_ERROR_LABEL);
    expect(errorLabel(null)).toBe(UNKNOWN_ERROR_LABEL);
    expect(errorLabel(undefined)).toBe(UNKNOWN_ERROR_LABEL);
    expect(errorLabel(42)).toBe(UNKNOWN_ERROR_LABEL);
  });

  it("falls back to the constructor name when name was blanked", () => {
    class Weird extends Error {}
    const e = new Weird("boom");
    e.name = "";
    expect(errorLabel(e)).toBe("Weird");
  });

  it("truncates an absurd class name rather than letting it become a payload", () => {
    const e = new Error("x");
    e.name = "N".repeat(ERROR_LABEL_MAX_CHARS + 50);
    expect(errorLabel(e)).toHaveLength(ERROR_LABEL_MAX_CHARS);
  });

  it("never carries the stack", () => {
    const e = new Error("inner");
    expect(errorLabel(e).includes("logger.test")).toBe(false);
    expect(errorLabel(e).includes("at ")).toBe(false);
  });
});

describe("logRecord", () => {
  const at = new Date("2026-09-20T12:34:56.000Z");

  it("emits the Cloud Logging shape the jobs runtime emits", () => {
    expect(logRecord("route:/api/health", "INFO", "probe ok", at)).toEqual({
      severity: "INFO",
      time: "2026-09-20T12:34:56.000Z",
      message: "route:/api/health: probe ok",
      logScope: "route:/api/health",
      event: "probe ok",
    });
  });

  it("keeps caller fields as structured keys and drops undefined ones", () => {
    const record = logRecord("action:assignTicket", "WARNING", "retried", at, {
      requestId: "req_1",
      attempt: 2,
      recovered: true,
      assigneeId: null,
      omitted: undefined,
    });
    expect(record).toMatchObject({ requestId: "req_1", attempt: 2, recovered: true, assigneeId: null });
    expect("omitted" in record).toBe(false);
  });

  it("refuses to let a field overwrite the record's own identity", () => {
    const record = logRecord("scope-a", "ERROR", "failed", at, {
      severity: "INFO",
      logScope: "scope-b",
      event: "something-else",
      message: "forged",
      time: "1999-01-01T00:00:00.000Z",
    });
    expect(record).toEqual({
      severity: "ERROR",
      time: "2026-09-20T12:34:56.000Z",
      message: "scope-a: failed",
      logScope: "scope-a",
      event: "failed",
    });
  });

  it("keeps a caller field named `scope`, which the reserved key used to swallow", () => {
    // The reason the identity key is `logScope`: `src/lib/integration-scope.ts` logs WHICH integration
    // scope had a misconfigured key, and while the reserved key was called `scope` that field was
    // dropped on the floor. Both now land on the same flat line, one Cloud Logging query away.
    const record = logRecord("integration-scope", "WARNING", "scoped_token_too_short", at, {
      scope: "outbox",
      key: "OUTBOX_API_TOKEN",
    });
    expect(record).toMatchObject({
      logScope: "integration-scope",
      scope: "outbox",
      key: "OUTBOX_API_TOKEN",
    });
  });

  it("the reserved list is exactly the five keys the record writes itself", () => {
    // Pinned so a sixth key cannot be added quietly: every addition here silently drops a caller
    // field of the same name, which is the defect `logScope` exists to have fixed once.
    expect([...RESERVED_KEYS].sort()).toEqual(["event", "logScope", "message", "severity", "time"]);
    const record = logRecord("s", "INFO", "e", at);
    expect(Object.keys(record).sort()).toEqual([...RESERVED_KEYS].sort());
  });
});

describe("createLogger", () => {
  it("routes INFO to stdout and WARNING/ERROR to stderr", () => {
    const { writers, out, err } = capture();
    const log = createLogger(writers);
    log.info("scope", "started");
    log.warn("scope", "degraded");
    log.error("scope", new Error("boom"));
    expect(out).toHaveLength(1);
    expect(err).toHaveLength(2);
    expect(parse(out[0]).severity).toBe("INFO");
    expect(parse(err[0]).severity).toBe("WARNING");
    expect(parse(err[1]).severity).toBe("ERROR");
  });

  it("logs an error as the label plus the caller's fields, and nothing from the message", () => {
    const { writers, err } = capture();
    createLogger(writers).error("route:/api/ingest/tickets", new NotFoundError("ticket bob@example.com missing"), {
      requestId: "req_9",
      ticketId: "t_1",
    });
    const record = parse(err[0]);
    expect(record).toMatchObject({
      severity: "ERROR",
      logScope: "route:/api/ingest/tickets",
      event: "failed",
      message: "route:/api/ingest/tickets: failed",
      error: "NotFoundError[NOT_FOUND]",
      requestId: "req_9",
      ticketId: "t_1",
    });
    expect(err[0].includes("bob@example.com")).toBe(false);
    expect(err[0].includes("missing")).toBe(false);
  });

  it("a caller field named error cannot smuggle the message back in", () => {
    const { writers, err } = capture();
    createLogger(writers).error("scope", new Error("real detail"), { error: "attacker supplied" });
    expect(parse(err[0]).error).toBe("Error");
  });

  it("writes exactly one newline-terminated JSON line per call", () => {
    const { writers, out } = capture();
    createLogger(writers).info("scope", "event", { a: "b" });
    expect(out).toHaveLength(1);
    expect(out[0].split("\n")).toHaveLength(2);
    expect(() => JSON.parse(out[0])).not.toThrow();
  });
});

describe("defaultWriters", () => {
  it("writes to the real process streams when they exist", () => {
    const seen: string[] = [];
    const stdout = process.stdout;
    const original = stdout.write.bind(stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow, restored in the same test
    (stdout as any).write = (chunk: string) => {
      seen.push(chunk);
      return true;
    };
    try {
      defaultWriters().out("line\n");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restoring the real stream
      (stdout as any).write = original;
    }
    expect(seen).toEqual(["line\n"]);
  });

  it("drops the line instead of throwing when the stream is unavailable", () => {
    const stdout = process.stdout;
    const original = stdout.write.bind(stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- simulating the edge runtime
    (stdout as any).write = undefined;
    try {
      expect(() => defaultWriters().out("line\n")).not.toThrow();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restoring the real stream
      (stdout as any).write = original;
    }
  });
});

describe("source-level guarantees", () => {
  const source = readFileSync(new URL("./logger.ts", import.meta.url), "utf8");

  it("never calls console.* — not even as a fallback (CWE-209)", () => {
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code.includes("console.")).toBe(false);
  });

  it("imports no node builtin, so the edge and middleware bundles can carry it", () => {
    expect(source.includes('from "node:')).toBe(false);
    expect(source.includes('require("node:')).toBe(false);
  });
});
