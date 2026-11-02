import path from "node:path";
import { pathToFileURL } from "node:url";
import { executeLegacyImportJob, LegacyImportJobRuntimeError, safeLegacyImportJobRuntimeError } from "../lib/operations/legacy-import-job-runtime";
import { LegacyImportJobPolicyError } from "../lib/operations/legacy-import-job-policy";
import { safeLegacyImportError } from "./import-legacy-operations";

export async function legacyOperationsJobMain(): Promise<void> {
  try {
    const result = await executeLegacyImportJob(process.env, process.argv.slice(2));
    // Only coarse status and artifact hashes/generation, never the report,
    // request identifiers, source narratives, paths, tokens or URL credentials.
    console.log(JSON.stringify({
      status: result.blocking ? "dry_run_blocked" : result.mode === "apply" ? "apply_complete" : "dry_run_complete",
      reportGeneration: result.report.generation, reportSha256: result.report.sha256,
      notificationsCreated: 0,
    }));
    if (result.blocking) process.exitCode = 1;
  } catch (error: unknown) {
    const code = error instanceof LegacyImportJobRuntimeError ? safeLegacyImportJobRuntimeError(error)
      : error instanceof LegacyImportJobPolicyError ? "import_job_policy_rejected" : safeLegacyImportError(error);
    console.error("ERROR: " + code);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void legacyOperationsJobMain();
}
