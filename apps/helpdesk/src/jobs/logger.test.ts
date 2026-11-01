import { describe, expect, it } from "vitest";
import { JOB_ERROR_LABEL_MAX_CHARS, createJobLogger, errorLabel, jobLogRecord } from "@/jobs/logger";
import { AppError, ValidationError } from "@/lib/errors";

const AT = new Date("2026-09-19T04:05:06.007Z");

describe("jobLogRecord", () => {
  it("emits the Cloud Logging shape with the job's own identity", () => {
    expect(jobLogRecord("sla-sweep", "job-sla-sweep-abc", "INFO", "start", AT)).toEqual({
      severity: "INFO",
      time: "2026-09-19T04:05:06.007Z",
      message: "sla-sweep: start",
      job: "sla-sweep",
      event: "start",
      requestId: "job-sla-sweep-abc",
    });
  });

  it("merges structured fields and drops undefined ones", () => {
    const record = jobLogRecord("event-alerts", "req", "WARNING", "queue-digest", AT, {
      queueKey: "OPERATIONS",
      events: 3,
      slack: undefined,
      advanced: false,
    });
    expect(record.queueKey).toBe("OPERATIONS");
    expect(record.events).toBe(3);
    expect(record.advanced).toBe(false);
    expect("slack" in record).toBe(false);
  });

  it("never lets a field overwrite the reserved keys", () => {
    const record = jobLogRecord("sla-sweep", "req", "ERROR", "failed", AT, {
      job: "something-else",
      severity: "INFO",
      requestId: "spoofed",
    });
    expect(record.job).toBe("sla-sweep");
    expect(record.severity).toBe("ERROR");
    expect(record.requestId).toBe("req");
  });
});

describe("createJobLogger", () => {
  it("writes one JSON object per line to the injected sink", () => {
    const lines: string[] = [];
    const log = createJobLogger("duplicate-copy", "req-1", (line) => lines.push(line));
    log.info("start");
    log.warn("slow", { ms: 1200 });
    log.error("failed", { error: "boom" });

    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.endsWith("\n")).toBe(true);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.map((p) => p.severity)).toEqual(["INFO", "WARNING", "ERROR"]);
    expect(parsed[1].ms).toBe(1200);
    expect(parsed.every((p) => p.job === "duplicate-copy" && p.requestId === "req-1")).toBe(true);
  });
});

describe("errorLabel", () => {
  it("names the error and carries the AppError code", () => {
    expect(errorLabel(new ValidationError("Unknown job name"))).toBe("ValidationError: [VALIDATION] Unknown job name");
    expect(errorLabel(new AppError("INTERNAL", "jobs actor missing", 500))).toBe("AppError: [INTERNAL] jobs actor missing");
  });

  it("sanitizes PII out of an error message before it can reach a log sink", () => {
    const label = errorLabel(new Error("constraint failed on row ssn 123-45-6789"));
    expect(label).not.toContain("123-45-6789");
    expect(label).toContain("[REDACTED:SSN]");
  });

  it("truncates a very long message and handles a non-Error throw", () => {
    expect(errorLabel(new Error("x".repeat(5000))).length).toBeLessThanOrEqual(
      JOB_ERROR_LABEL_MAX_CHARS + "Error: ".length,
    );
    expect(errorLabel("plain string")).toBe("plain string");
    expect(errorLabel(undefined)).toBe("undefined");
  });
});
