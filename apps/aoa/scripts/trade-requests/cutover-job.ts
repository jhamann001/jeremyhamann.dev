import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sourceDatabaseUrl, singleConnectionUrl } from "../../lib/trade-requests/cutover-connection";

// Entry point of the manually executed Cloud Run job aoa-trade-request-cutover (ticket), never scheduled.
// The operator passes exactly one allowlisted command (`gcloud run jobs execute … --args=<command>`); the job runs
// the matching CLI with every database client capped at one connection.

const CUTOVER = "scripts/trade-requests/cutover.ts";

export const JOB_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "copy-report": ["scripts/trade-requests/copy.ts", "--mode=report"],
  "copy-full": ["scripts/trade-requests/copy.ts", "--mode=full"],
  "copy-change": ["scripts/trade-requests/copy.ts", "--mode=change"],
  reconcile: ["scripts/trade-requests/reconcile-access.ts"],
  readiness: ["scripts/trade-requests/drift-readiness.ts"],
  preflight: [CUTOVER, "preflight"],
  cutover: [CUTOVER, "cutover"],
  retire: [CUTOVER, "retire"],
  rollback: [CUTOVER, "rollback"],
  recover: [CUTOVER, "recover"],
  "handoff-digest-to-aoa": [CUTOVER, "handoff", "--kind=digest", "--to=aoa"],
  "handoff-digest-to-standalone": [CUTOVER, "handoff", "--kind=digest", "--to=standalone"],
  "handoff-drift-to-aoa": [CUTOVER, "handoff", "--kind=drift", "--to=aoa"],
  "handoff-drift-to-standalone": [CUTOVER, "handoff", "--kind=drift", "--to=standalone"],
};

export type JobEnv = Record<string, string | undefined>;
export type JobInvocation = { script: string; args: string[]; env: JobEnv };

export function jobInvocation(argv: string[], env: JobEnv): JobInvocation | { error: string } {
  const entry = argv.length === 1 ? JOB_COMMANDS[argv[0]] : undefined;
  if (!entry || !Object.hasOwn(JOB_COMMANDS, argv[0])) return { error: `usage: one of ${Object.keys(JOB_COMMANDS).join(", ")}` };
  if (!env.DIRECT_DATABASE_URL) return { error: "DIRECT_DATABASE_URL is required" };
  const childEnv: JobEnv = { ...env, DIRECT_DATABASE_URL: singleConnectionUrl(env.DIRECT_DATABASE_URL) };
  delete childEnv.TRADE_REQUEST_SOURCE_DB_PASSWORD;
  if (env.TRADE_REQUEST_SOURCE_DB_PASSWORD && env.TRADE_REQUEST_SOURCE_DB_SOCKET) {
    childEnv.TRADE_REQUEST_SOURCE_DATABASE_URL = sourceDatabaseUrl(env.TRADE_REQUEST_SOURCE_DB_PASSWORD, env.TRADE_REQUEST_SOURCE_DB_SOCKET);
  }
  const [script, ...args] = entry;
  return { script, args, env: childEnv };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const invocation = jobInvocation(process.argv.slice(2), process.env);
  if ("error" in invocation) {
    console.error(invocation.error);
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify({ event: "cutover_job_command", command: process.argv[2] }));
    const child = spawnSync(process.execPath, ["--import", "tsx", invocation.script, ...invocation.args], {
      stdio: "inherit",
      env: invocation.env as NodeJS.ProcessEnv,
    });
    process.exitCode = child.status ?? 1;
  }
}
