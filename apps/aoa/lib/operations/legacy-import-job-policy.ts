import { createHash } from "node:crypto";
import { getLegacyImportTarget, type LegacyImportTarget } from "./legacy-import-target";

/** Pure policy. Observations must come from authenticated fixed Google APIs. */
export type ImportObjectRef = Readonly<{ object: string; generation: string; sha256: string }>;
export type LegacyImportJobLaunch = Readonly<{
  target: LegacyImportTarget; mode: "dry-run" | "apply"; manifest: ImportObjectRef;
}>;
export type LegacyImportJobManifest = Readonly<{
  version: 1; target: LegacyImportTarget; mode: "dry-run" | "apply";
  batchId: string; image: string; secretVersion: string; expiresAt: string;
  sources: Readonly<Record<"feeCredits" | "billingExceptions" | "tradeReconciliation" | "mapping", ImportObjectRef>>;
  approval: (ImportObjectRef & Readonly<{ digest: string }>) | null;
}>;
export type LegacyImportJobObservation = Readonly<{
  projectId: string; serviceAccountEmail: string;
  env: Readonly<Record<string, string | undefined>>;
  job: unknown; execution: unknown; executionV1: unknown;
}>;
export class LegacyImportJobPolicyError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LegacyImportJobPolicyError"; }
}
function fail(code = "import_job_policy_invalid"): never { throw new LegacyImportJobPolicyError(code); }
const HEX = /^[a-f0-9]{64}$/;
const BATCH = /^[a-f0-9]{32}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const SOURCE_NAMES = ["feeCredits", "billingExceptions", "tradeReconciliation", "mapping"] as const;
const SOURCE_FILES = { feeCredits: "fee-credits.csv", billingExceptions: "billing-exceptions.csv", tradeReconciliation: "trade-reconciliation.csv", mapping: "mapping.csv" } as const;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function getLegacyImportJobConfig(target: LegacyImportTarget) {
  const base = getLegacyImportTarget(target);
  return Object.freeze({
    ...base, jobName: target === "prod" ? "aoa-operations-import" : "aoa-operations-import-dev",
    projectNumber: target === "prod" ? "1000000000001" : "100000000004",
    serviceAccount: `aoa-ops-import@${base.project}.iam.gserviceaccount.com`,
    bucket: `${base.project}-ops-import`, network: target === "prod" ? "aoa-vpc" : "aoa-dev-vpc",
    subnet: target === "prod" ? "aoa-subnet" : "aoa-dev-subnet",
    secret: "operations-import-database-url",
    imagePrefix: `us-central1-docker.pkg.dev/${base.project}/${target === "prod" ? "aoa" : "aoa-dev"}/aoa-operations-import@sha256:`,
  });
}

/** Validate untrusted execution IDs without constructing a regular expression.
 * Only the fixed target job prefix and a bounded lowercase ASCII suffix fit. */
export function isLegacyImportJobExecutionId(target: LegacyImportTarget, value: unknown): value is string {
  const prefix = getLegacyImportJobConfig(target).jobName + "-";
  if (typeof value !== "string" || value.length < prefix.length + 3 || value.length > prefix.length + 32
    || !value.startsWith(prefix)) return false;
  return !/[^a-z0-9]/.test(value.slice(prefix.length));
}

export function parseLegacyImportJobLaunch(env: Readonly<Record<string, string | undefined>>): LegacyImportJobLaunch {
  const target = env.AOA_IMPORT_TARGET;
  const mode = env.AOA_IMPORT_MODE;
  if (target !== "dev" && target !== "prod") fail("import_job_target_invalid");
  if (mode !== "dry-run" && mode !== "apply") fail("import_job_disabled");
  const objectName = env.AOA_IMPORT_MANIFEST_OBJECT ?? "";
  const generation = env.AOA_IMPORT_MANIFEST_GENERATION ?? "";
  const sha256 = env.AOA_IMPORT_MANIFEST_SHA256 ?? "";
  if (!/^approved\/[a-f0-9]{32}\/[a-f0-9]{64}\.json$/.test(objectName)
    || !GENERATION.test(generation) || !HEX.test(sha256)
    || !objectName.endsWith(`/${sha256}.json`)) fail("import_job_manifest_pin_invalid");
  return Object.freeze({ target, mode, manifest: Object.freeze({ object: objectName, generation, sha256 }) });
}

function ref(value: unknown, name: string, approval = false): value is ImportObjectRef {
  return exact(value, approval ? ["object", "generation", "sha256", "digest"] : ["object", "generation", "sha256"])
    && value.object === name && typeof value.generation === "string" && GENERATION.test(value.generation)
    && typeof value.sha256 === "string" && HEX.test(value.sha256)
    && (!approval || (typeof value.digest === "string" && HEX.test(value.digest)));
}

/** Canonical JSON only: rejects duplicate keys, exotic syntax and ambiguous bytes. */
export function parseLegacyImportJobManifest(raw: string, target: LegacyImportTarget, now = Date.now()): LegacyImportJobManifest {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 16_384) fail("import_job_manifest_invalid");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("import_job_manifest_invalid"); }
  if (JSON.stringify(value) !== raw.trim()) fail("import_job_manifest_not_canonical");
  if (!exact(value, ["version", "target", "mode", "batchId", "image", "secretVersion", "expiresAt", "sources", "approval"])
    || value.version !== 1 || value.target !== target || (value.mode !== "dry-run" && value.mode !== "apply")
    || typeof value.batchId !== "string" || !BATCH.test(value.batchId)
    || typeof value.secretVersion !== "string" || !GENERATION.test(value.secretVersion)
    || typeof value.image !== "string" || typeof value.expiresAt !== "string"
    || !exact(value.sources, SOURCE_NAMES)) fail("import_job_manifest_invalid");
  const config = getLegacyImportJobConfig(target);
  if (!value.image.startsWith(config.imagePrefix) || !HEX.test(value.image.slice(config.imagePrefix.length))) fail("import_job_image_invalid");
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expires) || new Date(expires).toISOString() !== value.expiresAt
    || expires <= now || expires > now + 24 * 60 * 60 * 1000) fail("import_job_approval_expired");
  for (const key of SOURCE_NAMES) {
    if (!ref(value.sources[key], `inputs/${value.batchId}/${SOURCE_FILES[key]}`)) fail("import_job_source_invalid");
    Object.freeze(value.sources[key]);
  }
  if (value.mode === "dry-run" ? value.approval !== null
    : !ref(value.approval, `approved/${value.batchId}/approval.json`, true)) fail("import_job_approval_invalid");
  Object.freeze(value.sources);
  if (value.approval) Object.freeze(value.approval);
  return Object.freeze(value) as LegacyImportJobManifest;
}

/** Same binding for dry run/apply; mode, expiry and approval file change separately. */
export function legacyImportJobExecutionDigest(manifest: LegacyImportJobManifest): string {
  const config = getLegacyImportJobConfig(manifest.target);
  return hash(JSON.stringify({ version: 1, target: manifest.target, batchId: manifest.batchId,
    image: manifest.image, secretVersion: manifest.secretVersion,
    job: config.jobName, serviceAccount: config.serviceAccount, bucket: config.bucket,
    network: config.network, subnet: config.subnet,
    sources: SOURCE_NAMES.map((name) => [name, manifest.sources[name].object, manifest.sources[name].generation, manifest.sources[name].sha256]),
  }));
}

export function verifyLegacyImportJobObject(bytes: Uint8Array, reference: ImportObjectRef, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 25 * 1024 * 1024
    || !(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes
    || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) fail("import_job_object_mismatch");
}

function sameResource(actual: unknown, project: string, kind: string, name: string): boolean {
  return actual === name || actual === `projects/${project}/${kind}/${name}`;
}

function verifyNetwork(nic: unknown, target: LegacyImportTarget): void {
  const c = getLegacyImportJobConfig(target);
  if (!object(nic) || !sameResource(nic.network, c.project, "global/networks", c.network)
    || !sameResource(nic.subnetwork, c.project, `regions/${c.region}/subnetworks`, c.subnet)
    || (nic.tags !== undefined && (!Array.isArray(nic.tags) || nic.tags.length))) fail("import_job_network_invalid");
}

/** v1 retains the immutable execution's Direct VPC annotations when v2 omits
 * template.vpcAccess. Never substitute the mutable job's network as proof. */
function verifyExecutionNetwork(
  target: LegacyImportTarget, snapshot: unknown, executionId: string,
  job: Record<string, unknown>, execution: Record<string, unknown>,
): void {
  const c = getLegacyImportJobConfig(target);
  if (!object(snapshot) || snapshot.apiVersion !== "run.googleapis.com/v1" || snapshot.kind !== "Execution"
    || !object(snapshot.metadata)) fail("import_job_execution_invalid");
  const metadata = snapshot.metadata;
  const labels = metadata.labels;
  const generation = typeof job.generation === "number" && Number.isSafeInteger(job.generation) && job.generation > 0
    ? String(job.generation) : job.generation;
  if (metadata.name !== executionId || metadata.namespace !== c.projectNumber || metadata.deletionTimestamp
    || typeof execution.uid !== "string" || !execution.uid || metadata.uid !== execution.uid
    || typeof job.uid !== "string" || !job.uid || typeof generation !== "string" || !GENERATION.test(generation)
    || !object(labels) || labels["cloud.googleapis.com/location"] !== c.region
    || labels["run.googleapis.com/job"] !== c.jobName || labels["run.googleapis.com/jobUid"] !== job.uid
    || labels["run.googleapis.com/jobGeneration"] !== generation) fail("import_job_execution_invalid");
  const annotations = metadata.annotations;
  if (!object(annotations) || annotations["run.googleapis.com/vpc-access-egress"] !== "private-ranges-only"
    || Object.hasOwn(annotations, "run.googleapis.com/vpc-access-connector")
    || typeof annotations["run.googleapis.com/network-interfaces"] !== "string"
    || annotations["run.googleapis.com/network-interfaces"].length > 4_096) fail("import_job_network_invalid");
  let interfaces: unknown;
  try { interfaces = JSON.parse(annotations["run.googleapis.com/network-interfaces"]); }
  catch { fail("import_job_network_invalid"); }
  if (!Array.isArray(interfaces) || interfaces.length !== 1) fail("import_job_network_invalid");
  verifyNetwork(interfaces[0], target);
}

/** Reject effective execution overrides, sidecars, arbitrary secrets and custom commands. */
function verifyTemplate(template: unknown, manifest: LegacyImportJobManifest, launch: LegacyImportJobLaunch, executionNetworkVerified = false): void {
  const c = getLegacyImportJobConfig(manifest.target);
  if (!object(template) || template.serviceAccount !== c.serviceAccount
    || (template.maxRetries ?? 0) !== 0 || template.timeout !== "600s"
    || !Array.isArray(template.containers) || template.containers.length !== 1
    || (Array.isArray(template.volumes) ? template.volumes.length !== 0 : template.volumes !== undefined)) fail("import_job_template_invalid");
  if (!executionNetworkVerified || Object.hasOwn(template, "vpcAccess")) {
    if (!object(template.vpcAccess) || template.vpcAccess.egress !== "PRIVATE_RANGES_ONLY"
      || template.vpcAccess.connector || !Array.isArray(template.vpcAccess.networkInterfaces)
      || template.vpcAccess.networkInterfaces.length !== 1) fail("import_job_template_invalid");
    verifyNetwork(template.vpcAccess.networkInterfaces[0], manifest.target);
  }
  const container = template.containers[0];
  if (!object(container) || container.image !== manifest.image
    || (container.command !== undefined && (!Array.isArray(container.command) || container.command.length))
    || (container.args !== undefined && (!Array.isArray(container.args) || container.args.length))
    || (container.volumeMounts !== undefined && (!Array.isArray(container.volumeMounts) || container.volumeMounts.length))
    || !Array.isArray(container.env)) fail("import_job_container_invalid");
  const env = new Map<string, unknown>();
  for (const entry of container.env) {
    if (!object(entry) || typeof entry.name !== "string" || env.has(entry.name)) fail("import_job_environment_invalid");
    env.set(entry.name, entry);
  }
  const expected = {
    NODE_ENV: "production", AOA_IMPORT_TARGET: launch.target, AOA_IMPORT_MODE: launch.mode,
    AOA_IMPORT_MANIFEST_OBJECT: launch.manifest.object,
    AOA_IMPORT_MANIFEST_GENERATION: launch.manifest.generation,
    AOA_IMPORT_MANIFEST_SHA256: launch.manifest.sha256,
  };
  if (env.size !== Object.keys(expected).length + 1) fail("import_job_environment_invalid");
  for (const [name, value] of Object.entries(expected)) {
    const entry = env.get(name);
    if (!exact(entry, ["name", "value"]) || entry.value !== value) fail("import_job_environment_invalid");
  }
  const secret = env.get("DIRECT_DATABASE_URL");
  if (!exact(secret, ["name", "valueSource"]) || !exact(secret.valueSource, ["secretKeyRef"])
    || !exact(secret.valueSource.secretKeyRef, ["secret", "version"])
    || !sameResource(secret.valueSource.secretKeyRef.secret, c.project, "secrets", c.secret)
    || secret.valueSource.secretKeyRef.version !== manifest.secretVersion) fail("import_job_secret_invalid");
}

export function verifyLegacyImportJobRuntime(
  target: LegacyImportTarget, manifest: LegacyImportJobManifest, observed: LegacyImportJobObservation,
): Readonly<{ executionDigest: string }> {
  const c = getLegacyImportJobConfig(target);
  const launch = parseLegacyImportJobLaunch(observed.env);
  if (launch.target !== target || manifest.target !== target || launch.mode !== manifest.mode
    || !launch.manifest.object.startsWith(`approved/${manifest.batchId}/`)) fail("import_job_launch_mismatch");
  if (observed.projectId !== c.project || observed.serviceAccountEmail !== c.serviceAccount
    || observed.env.K_SERVICE || observed.env.CLOUD_RUN_SERVICE
    || observed.env.CLOUD_RUN_JOB !== c.jobName || observed.env.CLOUD_RUN_TASK_INDEX !== "0"
    || observed.env.CLOUD_RUN_TASK_COUNT !== "1" || observed.env.CLOUD_RUN_TASK_ATTEMPT !== "0") fail("import_job_identity_invalid");
  const name = `projects/${c.project}/locations/${c.region}/jobs/${c.jobName}`;
  const executionId = observed.env.CLOUD_RUN_EXECUTION;
  if (!isLegacyImportJobExecutionId(target, executionId)) fail("import_job_execution_invalid");
  const job = observed.job;
  const execution = observed.execution;
  if (!object(job) || job.name !== name || job.deleteTime || job.reconciling === true
    || !object(job.template) || job.template.taskCount !== 1 || job.template.parallelism !== 1
    || !object(execution) || execution.name !== `${name}/executions/${executionId}`
    || (execution.job !== name && execution.job !== c.jobName)
    || execution.taskCount !== 1 || execution.parallelism !== 1 || execution.completionTime || execution.deleteTime
    || (execution.retriedCount ?? 0) !== 0) fail("import_job_execution_invalid");
  verifyTemplate(job.template.template, manifest, launch);
  verifyExecutionNetwork(target, observed.executionV1, executionId, job, execution);
  verifyTemplate(execution.template, manifest, launch, true);
  return Object.freeze({ executionDigest: legacyImportJobExecutionDigest(manifest) });
}
