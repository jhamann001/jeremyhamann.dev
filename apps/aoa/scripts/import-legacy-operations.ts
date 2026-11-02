/**
 * Operator-only, report-bound Fee Store import. Inputs/outputs stay outside git.
 * Dry run requires --target dev|prod. --report-out writes a private approval
 * report. Apply also needs target-specific confirmation/environment gates,
 * --approval-report and --approve-digest. Never invokes Slack or enables tools.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient, type Prisma } from "@prisma/client";
import {
  parseLegacyFeeCreditsCsv, parseLegacyBillingExceptionsCsv,
  parseLegacyTradeReconciliationCsv, parseReviewedMappingsCsv, mappingReviewCsv,
} from "../lib/operations/legacy-import";
import { applyLegacyImport, previewLegacyImport, type LegacyImportInput } from "../lib/operations/legacy-import-engine";
import { createLegacyImportApproval, verifyLegacyImportApproval, type LegacyImportApproval, type LegacyImportApprovalContext } from "../lib/operations/legacy-import-approval";
import { getLegacyImportTarget, parseLegacyImportOptions, validateLegacyImportCloudMetadata, type LegacyImportOptions, type VerifiedLegacyImportCloudMetadata } from "../lib/operations/legacy-import-target";
import { verifyLegacyImportDatabase } from "../lib/operations/legacy-import-preflight";

const repositoryRoot = realpathSync(path.resolve(import.meta.dirname, ".."));
const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

function insideRepository(candidate: string): boolean {
  const relative = path.relative(repositoryRoot, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
function operatorFile(file: string, privateOnly = false): { text: string; digest: string } {
  const resolved = realpathSync(path.resolve(file));
  if (insideRepository(resolved)) throw new Error("input_must_be_outside_repository");
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const limit = privateOnly ? 1024 * 1024 : MAX_INPUT_BYTES;
    if (!stat.isFile() || stat.size > limit) throw new Error("input_file_invalid");
    if (privateOnly && (stat.mode & 0o077) !== 0) throw new Error("approval_file_permissions_unsafe");
    const data = readFileSync(fd);
    if (data.length > limit) throw new Error("input_file_invalid");
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), digest: sha256(data) };
  } finally { closeSync(fd); }
}
function writePrivateReport(file: string, text: string): void {
  const requested = path.resolve(file);
  const resolved = path.join(realpathSync(path.dirname(requested)), path.basename(requested));
  if (insideRepository(resolved)) throw new Error("output_must_be_outside_repository");
  // Exclusive creation refuses existing files/symlinks; never overwrite exports.
  writeFileSync(resolved, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
export function legacyImportImplementationDigest(): string {
  const files = [
    "scripts/import-legacy-operations.ts", "lib/operations/legacy-import.ts",
    "lib/operations/legacy-import-engine.ts", "lib/operations/legacy-import-target.ts",
    "lib/operations/legacy-import-preflight.ts", "lib/operations/legacy-import-approval.ts",
    "scripts/import-legacy-operations-job.ts", "lib/operations/legacy-import-job-runtime.ts",
    "lib/operations/legacy-import-job-policy.ts", "Dockerfile.operations-import", "Dockerfile.operations-import.dockerignore",
    "lib/deals/import-csv.ts", "prisma/schema.prisma", "package-lock.json",
  ];
  return sha256(JSON.stringify(files.map((file) => [file, sha256(readFileSync(path.join(repositoryRoot, file)))])));
}
export type LegacyOperationsImportInvocation = Readonly<{
  /** Workstation options must come from parseLegacyImportOptions. The job entry
   * supplies these only after its separate authenticated runtime policy passes. */
  options: LegacyImportOptions;
  directUrl: string | undefined;
  fetchCloudIdentity?: () => Promise<VerifiedLegacyImportCloudMetadata>;
  executionDigest?: string;
  verifyExecutionBeforeMutation?: () => Promise<void>;
}>;
export type LegacyOperationsImportResult = Readonly<{
  approval: LegacyImportApproval;
  blocking: boolean;
  applied: Awaited<ReturnType<typeof applyLegacyImport>> | null;
  reviewRows?: number;
}>;

/** Shared operator engine, not a web API. It never changes process.env, logs
 * payloads or weakens the workstation parser to impersonate a job. */
export async function runLegacyOperationsImport(invocation: LegacyOperationsImportInvocation): Promise<LegacyOperationsImportResult> {
  const { options, directUrl } = invocation;
  if (invocation.executionDigest !== undefined && (!/^[0-9a-f]{64}$/.test(invocation.executionDigest)
    || !invocation.fetchCloudIdentity || !invocation.verifyExecutionBeforeMutation)) throw new Error("execution_verification_required");
  if (!directUrl) throw new Error("direct_database_url_required");
  const parsedUrl = new URL(directUrl);
  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)
    || decodeURIComponent(parsedUrl.username) !== "aoa_admin"
    || decodeURIComponent(parsedUrl.pathname) !== "/aoa") throw new Error("connection_identity_mismatch");
  // No host/socket overrides or plaintext fallback; verify the destination
  // against Cloud SQL metadata before handing credentials to the driver.
  const connectionOptions = new Set(["schema", "sslmode", "sslaccept", "sslcert", "sslidentity", "sslpassword", "connection_limit", "connect_timeout", "pool_timeout"]);
  const seenOptions = new Set<string>();
  for (const key of parsedUrl.searchParams.keys()) {
    if (!connectionOptions.has(key) || seenOptions.has(key)) throw new Error("connection_options_unsafe");
    seenOptions.add(key);
  }
  if (parsedUrl.searchParams.get("schema") !== "app"
    || parsedUrl.searchParams.get("sslmode") !== "require"
    || parsedUrl.hash || (parsedUrl.port && parsedUrl.port !== "5432")) throw new Error("connection_options_unsafe");
  const target = getLegacyImportTarget(options.target);
  const sources = {
    feeCredits: options.feeCredits ? operatorFile(options.feeCredits) : null,
    billingExceptions: options.billingExceptions ? operatorFile(options.billingExceptions) : null,
    tradeReconciliation: options.tradeReconciliation ? operatorFile(options.tradeReconciliation) : null,
    mapping: options.mapping ? operatorFile(options.mapping) : null,
  };
  const approvalText = options.approvalReport ? operatorFile(options.approvalReport, true).text : null;
  const fee = sources.feeCredits ? parseLegacyFeeCreditsCsv(sources.feeCredits.text) : { rows: [], issues: [] };
  const billing = sources.billingExceptions ? parseLegacyBillingExceptionsCsv(sources.billingExceptions.text) : { rows: [], issues: [] };
  const recon = sources.tradeReconciliation ? parseLegacyTradeReconciliationCsv(sources.tradeReconciliation.text) : { rows: [], issues: [] };
  const mappings = sources.mapping ? parseReviewedMappingsCsv(sources.mapping.text) : { rows: [], issues: [] };
  const input: LegacyImportInput = {
    requests: [...fee.rows, ...billing.rows], reviewedMappings: mappings.rows,
    reconciliations: recon.rows, issues: [...fee.issues, ...billing.issues, ...recon.issues, ...mappings.issues],
  };
  const codeDigest = legacyImportImplementationDigest();
  const migrationRoot = path.join(repositoryRoot, "prisma/migrations");
  const expectedMigrations = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => ({
      name: entry.name,
      checksum: sha256(readFileSync(path.join(migrationRoot, entry.name, "migration.sql"))),
    })).sort((a, b) => a.name.localeCompare(b.name));
  const fetchCloudIdentity = invocation.fetchCloudIdentity ?? (async () => {
    try {
      const raw = execFileSync("gcloud", [
        "sql", "instances", "describe", target.instance, "--project=" + target.project,
        "--format=json(name,connectionName,region,ipAddresses)",
      ], { encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      return validateLegacyImportCloudMetadata(options.target, JSON.parse(raw));
    } catch { throw new Error("cloud_target_verification_failed"); }
  });
  let cloud = await fetchCloudIdentity();
  if (parsedUrl.hostname !== cloud.privateAddress) throw new Error("connection_server_mismatch");
  let schemaDigest = "";
  const verifyTarget = async (tx: Prisma.TransactionClient) => {
    schemaDigest = await verifyLegacyImportDatabase(tx, options.target, cloud, expectedMigrations);
  };
  const context = (): LegacyImportApprovalContext => ({
    target: options.target, project: target.project, instance: target.instance,
    database: target.database, owner: target.owner, serverAddress: cloud.privateAddress,
    codeDigest, schemaDigest,
    ...(invocation.executionDigest ? { executionDigest: invocation.executionDigest } : {}),
    inputDigests: {
      feeCredits: sources.feeCredits?.digest ?? null,
      billingExceptions: sources.billingExceptions?.digest ?? null,
      tradeReconciliation: sources.tradeReconciliation?.digest ?? null,
      mapping: sources.mapping?.digest ?? null,
    },
  });
  // Never print SQL bindings or request payloads, including driver failures.
  const owner = new PrismaClient({ datasourceUrl: directUrl, log: [] });
  let applyCommitted = false;
  try {
    const preview = await previewLegacyImport(owner, input, verifyTarget);
    const approval = createLegacyImportApproval(context(), preview);
    if (!options.apply) {
      if (options.reportOut) writePrivateReport(options.reportOut, JSON.stringify(approval, null, 2) + "\n");
      if (options.reviewOut) {
        writePrivateReport(options.reviewOut, mappingReviewCsv(preview.unresolved));
      }
      return { approval, blocking: preview.issues.length > 0, applied: null,
        ...(options.reviewOut ? { reviewRows: preview.unresolved.length } : {}) };
    }
    if (preview.issues.length) throw new Error("blocking_issues_present");
    verifyLegacyImportApproval(approvalText!, options.approveDigest!, approval);
    // Refresh independent metadata; re-check SQL identity inside the apply
    // transaction. Use the exact immutable input snapshots already hashed.
    cloud = await fetchCloudIdentity();
    if (parsedUrl.hostname !== cloud.privateAddress) throw new Error("connection_server_mismatch");
    if (legacyImportImplementationDigest() !== codeDigest) throw new Error("implementation_changed");
    const result = await applyLegacyImport(owner, input, verifyTarget, async (current) => {
      verifyLegacyImportApproval(approvalText!, options.approveDigest!, createLegacyImportApproval(context(), current));
    }, invocation.verifyExecutionBeforeMutation);
    applyCommitted = true;
    return { approval, blocking: false, applied: result };
  } finally {
    try { await owner.$disconnect(); }
    catch { throw new Error(applyCommitted ? "apply_committed_disconnect_failed" : "database_disconnect_failed"); }
  }
}
// Only our literal operational codes may leave the process. A driver or
// filesystem message may contain paths, connection strings or row contents.
const SAFE_ERROR_CODES = new Set([
  "direct_database_url_required", "connection_identity_mismatch", "connection_options_unsafe", "connection_server_mismatch",
  "input_must_be_outside_repository", "input_file_invalid", "approval_file_permissions_unsafe", "output_must_be_outside_repository",
  "cloud_target_verification_failed", "implementation_changed", "blocking_issues_present",
  "import_notification_invariant_failed", "import_reconciliation_failed", "apply_revalidation_failed", "apply_resolution_changed",
  "existing_record_drift", "existing_mapping_drift", "database_identity_invalid", "schema_not_ready", "schema_migration_mismatch", "schema_security_mismatch",
  "target_must_be_dev_or_prod", "invalid_arguments", "unknown_argument", "duplicate_argument", "argument_value_missing", "argument_value_invalid",
  "dry_run_and_apply_are_mutually_exclusive", "at_least_one_source_file_is_required", "apply_approval_arguments_require_apply",
  "apply_confirmation_missing", "apply_environment_gate_missing", "apply_must_run_from_an_operator_workstation", "apply_approval_report_required", "apply_approval_digest_invalid",
  "report_outputs_require_dry_run", "cloud_target_mismatch", "database_name_mismatch", "database_server_mismatch", "database_owner_mismatch", "database_owner_privileges_unsafe",
  "approval_context_invalid", "approval_preview_invalid", "approval_report_too_large", "approval_report_invalid", "approval_digest_invalid",
  "approval_report_digest_mismatch", "approval_current_invalid", "approval_plan_changed", "approval_blockers_present",
  "database_disconnect_failed", "apply_committed_disconnect_failed", "execution_verification_required",
]);
export function safeLegacyImportError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_ERROR_CODES.has(message) ? message : "unexpected_import_failure";
}

async function workstationMain(): Promise<void> {
  const options = parseLegacyImportOptions(process.argv.slice(2), process.env);
  const result = await runLegacyOperationsImport({ options, directUrl: process.env.DIRECT_DATABASE_URL });
  console.log(JSON.stringify(result.approval, null, 2));
  if (result.reviewRows !== undefined) console.log("review_mapping_written rows=" + result.reviewRows);
  if (result.applied) {
    console.log(JSON.stringify({ appliedAtomically: true, ...result.applied, notificationsCreated: 0 }));
  } else if (result.blocking) {
    console.error("blocking_issues_present; no writes performed");
    process.exitCode = 1;
  } else {
    console.log("dry_run_complete; no writes performed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  workstationMain().catch((error: unknown) => {
    console.error("ERROR: " + safeLegacyImportError(error));
    process.exitCode = 1;
  });
}
