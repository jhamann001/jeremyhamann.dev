/** Pure, fail-closed target policy. No network, file access, or environment mutation. */
export type LegacyImportTarget = "dev" | "prod";
export type LegacyImportTargetConfig = Readonly<{
  target: LegacyImportTarget;
  project: "ops-portal-dev" | "ops-portal";
  instance: "aoa-dev-postgres" | "aoa-postgres";
  database: "aoa";
  owner: "aoa_admin";
  region: "us-central1";
  connectionName: string;
}>;
export type VerifiedLegacyImportCloudMetadata = LegacyImportTargetConfig & Readonly<{ privateAddress: string }>;
export type LegacyImportOptions = Readonly<{
  target: LegacyImportTarget;
  apply: boolean;
  feeCredits: string | null;
  billingExceptions: string | null;
  tradeReconciliation: string | null;
  mapping: string | null;
  reportOut: string | null;
  reviewOut: string | null;
  approvalReport: string | null;
  approveDigest: string | null;
}>;

const TARGETS: Readonly<Record<LegacyImportTarget, LegacyImportTargetConfig>> = Object.freeze({
  dev: Object.freeze({
    target: "dev", project: "ops-portal-dev", instance: "aoa-dev-postgres",
    database: "aoa", owner: "aoa_admin", region: "us-central1",
    connectionName: "ops-portal-dev:us-central1:aoa-dev-postgres",
  }),
  prod: Object.freeze({
    target: "prod", project: "ops-portal", instance: "aoa-postgres",
    database: "aoa", owner: "aoa_admin", region: "us-central1",
    connectionName: "ops-portal:us-central1:aoa-postgres",
  }),
});

export class LegacyImportTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LegacyImportTargetError";
  }
}

function fail(code: string): never {
  throw new LegacyImportTargetError(code);
}

export function getLegacyImportTarget(target: LegacyImportTarget): LegacyImportTargetConfig {
  if (target !== "dev" && target !== "prod") fail("target_must_be_dev_or_prod");
  return TARGETS[target];
}

const BOOLEAN_FLAGS = new Set(["--apply", "--dry-run"]);
const VALUE_FLAGS = new Set([
  "--target", "--fee-credits", "--billing-exceptions", "--trade-reconciliation",
  "--mapping", "--report-out", "--review-out", "--approval-report", "--approve-digest", "--confirm",
]);

/** argv is process.argv.slice(2). Paths remain untouched for the CLI's private-file checks. */
export function parseLegacyImportOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): LegacyImportOptions {
  if (!Array.isArray(argv) || argv.length > 64) fail("invalid_arguments");
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!BOOLEAN_FLAGS.has(flag) && !VALUE_FLAGS.has(flag)) fail("unknown_argument");
    if (seen.has(flag)) fail("duplicate_argument");
    seen.add(flag);
    if (BOOLEAN_FLAGS.has(flag)) continue;
    const value = argv[++index];
    if (typeof value !== "string" || !value.trim() || value.startsWith("-")) fail("argument_value_missing");
    if (value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) fail("argument_value_invalid");
    values.set(flag, value);
  }
  const target = values.get("--target");
  if (target !== "dev" && target !== "prod") fail("target_must_be_dev_or_prod");
  const apply = seen.has("--apply");
  if (apply && seen.has("--dry-run")) fail("dry_run_and_apply_are_mutually_exclusive");
  const feeCredits = values.get("--fee-credits") ?? null;
  const billingExceptions = values.get("--billing-exceptions") ?? null;
  const tradeReconciliation = values.get("--trade-reconciliation") ?? null;
  if (!feeCredits && !billingExceptions && !tradeReconciliation) fail("at_least_one_source_file_is_required");
  const approvalReport = values.get("--approval-report") ?? null;
  const approveDigest = values.get("--approve-digest") ?? null;
  if (!apply && (seen.has("--confirm") || approvalReport !== null || approveDigest !== null)) {
    fail("apply_approval_arguments_require_apply");
  }
  if (apply && (seen.has("--report-out") || seen.has("--review-out"))) fail("report_outputs_require_dry_run");
  if (apply) {
    const suffix = target === "prod" ? "PROD" : "DEV";
    if (values.get("--confirm") !== `APPLY_FEE_STORE_LEGACY_TO_${suffix}`) fail("apply_confirmation_missing");
    if (env[`AOA_ALLOW_LEGACY_OPERATIONS_${suffix}_APPLY`] !== "1") fail("apply_environment_gate_missing");
    if (env.NODE_ENV === "production" || env.K_SERVICE || env.CLOUD_RUN_SERVICE
      || env.CLOUD_RUN_JOB || env.CLOUD_RUN_EXECUTION || env.CLOUD_RUN_TASK_INDEX
      || env.CLOUD_RUN_TASK_COUNT || env.CLOUD_RUN_TASK_ATTEMPT) fail("apply_must_run_from_an_operator_workstation");
    if (!approvalReport) fail("apply_approval_report_required");
    if (!approveDigest || approveDigest.length !== 64 || /[^0-9a-fA-F]/.test(approveDigest)) fail("apply_approval_digest_invalid");
  }
  return Object.freeze({
    target, apply, feeCredits, billingExceptions, tradeReconciliation,
    mapping: values.get("--mapping") ?? null,
    reportOut: values.get("--report-out") ?? null,
    reviewOut: values.get("--review-out") ?? null,
    approvalReport,
    approveDigest: approveDigest?.toLowerCase() ?? null,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function privateIpv4(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 7 || value.length > 15 || /[^0-9.]/.test(value)) return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !part || (part.length > 1 && part.startsWith("0")) || Number(part) > 255)) return false;
  const [first, second] = parts.map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** Only the selected fixed instance's unambiguous PRIVATE IPv4 may be trusted. */
export function validateLegacyImportCloudMetadata(
  target: LegacyImportTarget,
  metadata: unknown,
): VerifiedLegacyImportCloudMetadata {
  const expected = getLegacyImportTarget(target);
  if (!record(metadata)) fail("cloud_metadata_invalid");
  if (metadata.name !== expected.instance || metadata.region !== expected.region) fail("cloud_target_mismatch");
  const hasProject = metadata.project !== undefined;
  const hasConnection = metadata.connectionName !== undefined;
  if (!hasProject && !hasConnection) fail("cloud_project_unverified");
  if ((hasProject && metadata.project !== expected.project)
    || (hasConnection && metadata.connectionName !== expected.connectionName)) fail("cloud_target_mismatch");
  if (!Array.isArray(metadata.ipAddresses) || metadata.ipAddresses.length > 16) fail("cloud_addresses_invalid");
  const addresses: string[] = [];
  for (const entry of metadata.ipAddresses) {
    if (!record(entry) || typeof entry.type !== "string" || typeof entry.ipAddress !== "string") fail("cloud_addresses_invalid");
    if (entry.type === "PRIMARY") fail("cloud_public_endpoint_forbidden");
    if (entry.type !== "PRIVATE" && entry.type !== "OUTGOING") fail("cloud_addresses_invalid");
    if (entry.type === "PRIVATE") {
      if (!privateIpv4(entry.ipAddress)) fail("cloud_private_address_invalid");
      addresses.push(entry.ipAddress);
    }
  }
  // Multiple PRIVATE entries (including duplicate entries) are unexpected and
  // require review. PRIMARY/public endpoints are prohibited; OUTGOING metadata
  // is permitted but never becomes an accepted database endpoint.
  if (addresses.length !== 1) fail("cloud_private_address_ambiguous");
  return Object.freeze({ ...expected, privateAddress: addresses[0] });
}

/** Bind live SQL identity to the independently fetched Cloud SQL metadata. */
export function validateLegacyImportDatabaseIdentity(
  target: LegacyImportTarget,
  cloud: VerifiedLegacyImportCloudMetadata,
  identity: unknown,
): void {
  const expected = getLegacyImportTarget(target);
  if (!record(cloud) || cloud.target !== expected.target || cloud.project !== expected.project
    || cloud.instance !== expected.instance || cloud.region !== expected.region
    || cloud.connectionName !== expected.connectionName || cloud.database !== expected.database
    || cloud.owner !== expected.owner || !privateIpv4(cloud.privateAddress)) fail("cloud_target_mismatch");
  if (!record(identity)) fail("database_identity_invalid");
  if (identity.name !== expected.database) fail("database_name_mismatch");
  if (identity.server_address !== cloud.privateAddress) fail("database_server_mismatch");
  if (identity.current_user !== expected.owner || identity.session_user !== expected.owner) fail("database_owner_mismatch");
  if (identity.rolsuper !== false || identity.rolbypassrls !== false) fail("database_owner_privileges_unsafe");
}
