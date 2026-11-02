import * as Sentry from "@sentry/node";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const runId = process.env.TEST_RUN_ID ?? randomUUID();
let inited = false;

/** Call after a case's assertions so `pass: true` is only written for a passing case. */
export function markCase(suite: string, name: string, type: "unit" | "integration" = "unit"): void {
  const gitSha = process.env.GITHUB_SHA ?? "local";
  if (!inited) {
    if (process.env.SENTRY_DSN) Sentry.init({ dsn: process.env.SENTRY_DSN });
    inited = true;
  }
  Sentry.setTag("test.type", type);
  Sentry.setTag("test.suite", suite);
  Sentry.setTag("test.name", name);
  Sentry.setTag("test.run_id", runId);
  Sentry.setTag("test.git_sha", gitSha);
  mkdirSync("test-results/flywheel", { recursive: true });
  appendFileSync(
    "test-results/flywheel/cases.jsonl",
    JSON.stringify({ case_id: name, suite, run_id: runId, git_sha: gitSha, pass: true, ...(type === "unit" ? {} : { test_type: type }) }) + "\n",
  );
}
