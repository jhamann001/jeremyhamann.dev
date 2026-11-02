import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OAuth2Client } from "google-auth-library";
import {
  getLegacyImportJobConfig, isLegacyImportJobExecutionId, parseLegacyImportJobLaunch, parseLegacyImportJobManifest,
  verifyLegacyImportJobRuntime, verifyLegacyImportJobObject,
} from "./legacy-import-job-policy";
import { validateLegacyImportCloudMetadata } from "./legacy-import-target";
import {
  runLegacyOperationsImport, type LegacyOperationsImportInvocation, type LegacyOperationsImportResult,
} from "../../scripts/import-legacy-operations";

const MAX_JSON_BYTES = 1_048_576;
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const METADATA_ORIGIN = "http://metadata.google.internal";
const GOOGLE_ORIGINS = new Set([
  "https://run.googleapis.com", "https://sqladmin.googleapis.com",
  "https://us-central1-run.googleapis.com",
  "https://storage.googleapis.com", "https://www.googleapis.com",
]);
const SAFE_CODES = new Set([
  "job_http_target_invalid", "job_http_failed", "job_http_response_invalid", "job_http_response_too_large",
  "job_identity_invalid", "job_access_token_invalid", "job_object_metadata_invalid", "job_object_digest_mismatch",
  "job_bucket_not_private", "job_output_invalid", "job_arguments_invalid", "job_runtime_required",
  "job_manifest_invalid", "job_temp_file_failure", "job_execution_failed", "job_apply_confirmation_missing",
  "job_apply_committed_report_failed", "job_apply_committed_cleanup_failed",
]);

export class LegacyImportJobRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LegacyImportJobRuntimeError"; }
}
function fail(code: string): never { throw new LegacyImportJobRuntimeError(code); }
export function safeLegacyImportJobRuntimeError(error: unknown): string {
  return error instanceof LegacyImportJobRuntimeError && SAFE_CODES.has(error.code) ? error.code : "job_execution_failed";
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail("job_http_response_invalid"); }
}

/** All HTTP is bounded, fixed-origin, no redirects and no implicit retries.
 * Tests inject fetch, never production credentials or network access. */
export async function boundedLegacyJobRequest(
  fetcher: typeof fetch, url: URL, options: RequestInit, maximumBytes: number,
): Promise<Uint8Array> {
  if ((url.origin !== METADATA_ORIGIN && !GOOGLE_ORIGINS.has(url.origin))
    || url.username || url.password || url.hash || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_OBJECT_BYTES) {
    fail("job_http_target_invalid");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(url, { ...options, redirect: "error", signal: controller.signal });
    if (!response.ok || response.redirected || !response.body) fail("job_http_failed");
    if (url.origin === METADATA_ORIGIN && response.headers.get("metadata-flavor") !== "Google") fail("job_identity_invalid");
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maximumBytes)) {
      fail("job_http_response_too_large");
    }
    reader = response.body.getReader();
    let length = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) fail("job_http_response_too_large");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (error instanceof LegacyImportJobRuntimeError) throw error;
    return fail("job_http_failed");
  } finally {
    controller.abort();
    if (reader) {
      try { await reader.cancel(); } catch { /* Never emit response details. */ }
      reader.releaseLock();
    }
    clearTimeout(timer);
  }
}

export type LegacyJobObjectPin = Readonly<{ bucket: string; name: string; generation: string; sha256: string }>;

/** Privileged transport is available only to the dedicated entry point, not
 * imported by web code. Every URL is constructed from fixed API endpoints. */
export class LegacyImportJobGoogleApi {
  private accessToken: { value: string; expiresAt: number } | undefined;
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  private async metadata(pathname: string, search = ""): Promise<Uint8Array> {
    const url = new URL("/computeMetadata/v1/" + pathname, METADATA_ORIGIN);
    url.search = search;
    return boundedLegacyJobRequest(this.fetcher, url, { headers: { "Metadata-Flavor": "Google" } }, 32_768);
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > this.now()) return this.accessToken.value;
    const token = parseJson(await this.metadata("instance/service-accounts/default/token"));
    if (!record(token) || typeof token.access_token !== "string" || token.access_token.length < 20
      || token.access_token.length > 16_384 || /[\s\u0000-\u001f\u007f]/.test(token.access_token)
      || token.token_type !== "Bearer" || typeof token.expires_in !== "number"
      || !Number.isSafeInteger(token.expires_in) || token.expires_in < 120 || token.expires_in > 3_600) fail("job_access_token_invalid");
    this.accessToken = { value: token.access_token, expiresAt: this.now() + token.expires_in * 1_000 };
    return token.access_token;
  }

  async json(url: URL): Promise<unknown> {
    if (!GOOGLE_ORIGINS.has(url.origin)) fail("job_http_target_invalid");
    return parseJson(await boundedLegacyJobRequest(this.fetcher, url, { headers: { Authorization: "Bearer " + await this.token() } }, MAX_JSON_BYTES));
  }

  async identity(audience: string): Promise<Readonly<{ projectId: string; serviceAccount: string; claims: Record<string, unknown> }>> {
    const projectId = new TextDecoder().decode(await this.metadata("project/project-id"));
    const serviceAccount = new TextDecoder().decode(await this.metadata("instance/service-accounts/default/email"));
    const jwt = new TextDecoder().decode(await this.metadata("instance/service-accounts/default/identity", new URLSearchParams({ audience, format: "full" }).toString()));
    const certs = parseJson(await boundedLegacyJobRequest(this.fetcher, new URL("https://www.googleapis.com/oauth2/v1/certs"), {}, 131_072));
    if (!record(certs) || Object.keys(certs).length < 1 || Object.keys(certs).length > 32
      || Object.values(certs).some((cert) => typeof cert !== "string" || cert.length > 8_192)) fail("job_identity_invalid");
    try {
      // Certificates were fetched by our bounded transport, not an unbounded
      // auth-library HTTP call. This validates the signature, issuer/audience
      // and timestamps; mere decoded JWT claims never establish identity.
      const ticket = await new OAuth2Client().verifySignedJwtWithCertsAsync(
        jwt, certs as Record<string, string>, audience, ["accounts.google.com", "https://accounts.google.com"],
      );
      const claims = ticket.getPayload();
      if (!claims || claims.email_verified !== true || claims.email !== serviceAccount) fail("job_identity_invalid");
      return { projectId, serviceAccount, claims: { ...claims } };
    } catch { fail("job_identity_invalid"); }
  }

  async verifyPrivateBucket(bucket: string): Promise<void> {
    const url = new URL("https://storage.googleapis.com/storage/v1/b/" + encodeURIComponent(bucket));
    url.searchParams.set("fields", "name,iamConfiguration");
    const metadata = await this.json(url);
    if (!record(metadata) || metadata.name !== bucket || !record(metadata.iamConfiguration)
      || metadata.iamConfiguration.publicAccessPrevention !== "enforced"
      || !record(metadata.iamConfiguration.uniformBucketLevelAccess)
      || metadata.iamConfiguration.uniformBucketLevelAccess.enabled !== true) fail("job_bucket_not_private");
  }

  async readObject(pin: LegacyJobObjectPin, maximumBytes = MAX_OBJECT_BYTES): Promise<Uint8Array> {
    if (!/^[0-9]{1,20}$/.test(pin.generation) || !/^[0-9a-f]{64}$/.test(pin.sha256)) fail("job_object_metadata_invalid");
    const url = new URL("https://storage.googleapis.com/storage/v1/b/" + encodeURIComponent(pin.bucket) + "/o/" + encodeURIComponent(pin.name));
    url.searchParams.set("generation", pin.generation);
    url.searchParams.set("fields", "bucket,name,generation,size,contentEncoding");
    const metadata = await this.json(url);
    if (!record(metadata) || metadata.bucket !== pin.bucket || metadata.name !== pin.name || metadata.generation !== pin.generation
      || typeof metadata.size !== "string" || !/^[0-9]+$/.test(metadata.size) || Number(metadata.size) > maximumBytes
      || (metadata.contentEncoding !== undefined && metadata.contentEncoding !== "identity")) fail("job_object_metadata_invalid");
    url.searchParams.delete("fields");
    url.searchParams.set("alt", "media");
    const bytes = await boundedLegacyJobRequest(this.fetcher, url, { headers: { Authorization: "Bearer " + await this.token() } }, maximumBytes);
    if (bytes.byteLength !== Number(metadata.size) || digest(bytes) !== pin.sha256) fail("job_object_digest_mismatch");
    return bytes;
  }

  async createReport(bucket: string, name: string, report: Uint8Array): Promise<Readonly<{ generation: string; sha256: string }>> {
    if (report.byteLength < 1 || report.byteLength > MAX_JSON_BYTES) fail("job_output_invalid");
    const url = new URL("https://storage.googleapis.com/upload/storage/v1/b/" + encodeURIComponent(bucket) + "/o");
    url.search = new URLSearchParams({ uploadType: "media", name, ifGenerationMatch: "0", fields: "bucket,name,generation,size" }).toString();
    const metadata = parseJson(await boundedLegacyJobRequest(this.fetcher, url, {
      method: "POST", headers: { Authorization: "Bearer " + await this.token(), "Content-Type": "application/json; charset=utf-8" },
      body: Buffer.from(report),
    }, MAX_JSON_BYTES));
    if (!record(metadata) || metadata.bucket !== bucket || metadata.name !== name
      || typeof metadata.generation !== "string" || !/^[0-9]{1,20}$/.test(metadata.generation)
      || metadata.size !== String(report.byteLength)) fail("job_output_invalid");
    return { generation: metadata.generation, sha256: digest(report) };
  }
}

export type LegacyImportJobOutcome = Readonly<{
  mode: "dry-run" | "apply";
  blocking: boolean;
  report: Readonly<{ generation: string; sha256: string }>;
}>;
type RuntimeDependencies = Readonly<{
  fetcher?: typeof fetch;
  now?: () => number;
  /** Synthetic test seam; production entry always uses the real guarded core. */
  importer?: (invocation: LegacyOperationsImportInvocation) => Promise<LegacyOperationsImportResult>;
}>;

/** Cloud Run JOB entry, deliberately separate from workstation arguments. It
 * proves the effective job, execution, SA, image and network before handing
 * files or a URL to the unchanged atomic importer. Never unsets runtime env. */
export async function executeLegacyImportJob(
  env: Readonly<Record<string, string | undefined>>, argv: readonly string[], dependencies: RuntimeDependencies = {},
): Promise<LegacyImportJobOutcome> {
  if (argv.length !== 0) fail("job_arguments_invalid");
  const launch = parseLegacyImportJobLaunch(env);
  const config = getLegacyImportJobConfig(launch.target);
  if (env.K_SERVICE || env.CLOUD_RUN_SERVICE || env.CLOUD_RUN_JOB !== config.jobName
    || env.CLOUD_RUN_TASK_INDEX !== "0" || env.CLOUD_RUN_TASK_COUNT !== "1" || env.CLOUD_RUN_TASK_ATTEMPT !== "0") fail("job_runtime_required");
  const executionId = env.CLOUD_RUN_EXECUTION;
  if (!isLegacyImportJobExecutionId(launch.target, executionId)) fail("job_runtime_required");
  if (!env.DIRECT_DATABASE_URL) fail("job_runtime_required");
  // Only allowlisted launch/runtime keys enter the pure policy observation.
  // The credential remains separate and can never enter a report or JSON log.
  const launchEnv = Object.freeze(Object.fromEntries([
    "AOA_IMPORT_TARGET", "AOA_IMPORT_MODE", "AOA_IMPORT_MANIFEST_OBJECT", "AOA_IMPORT_MANIFEST_GENERATION",
    "AOA_IMPORT_MANIFEST_SHA256", "CLOUD_RUN_JOB", "CLOUD_RUN_EXECUTION", "CLOUD_RUN_TASK_INDEX",
    "CLOUD_RUN_TASK_COUNT", "CLOUD_RUN_TASK_ATTEMPT", "K_SERVICE", "CLOUD_RUN_SERVICE",
  ].map((key) => [key, env[key]])));
  const api = new LegacyImportJobGoogleApi(dependencies.fetcher, dependencies.now);
  const jobResource = `projects/${config.project}/locations/${config.region}/jobs/${config.jobName}`;
  const audience = `https://run.googleapis.com/v2/${jobResource}`;
  const identity = await api.identity(audience);
  if (identity.projectId !== config.project || identity.serviceAccount !== config.serviceAccount) fail("job_identity_invalid");
  await api.verifyPrivateBucket(config.bucket);
  const manifestBytes = await api.readObject({ bucket: config.bucket, name: launch.manifest.object, ...launch.manifest }, 16_384);
  verifyLegacyImportJobObject(manifestBytes, launch.manifest, 16_384);
  let manifestText: string;
  try { manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes); }
  catch { fail("job_manifest_invalid"); }
  const now = dependencies.now ?? Date.now;
  const manifest = parseLegacyImportJobManifest(manifestText, launch.target, now());
  const observe = async () => {
    // Revalidate expiry + effective execution config at dry-run/apply boundaries.
    parseLegacyImportJobManifest(manifestText, launch.target, now());
    const job = await api.json(new URL("https://run.googleapis.com/v2/" + jobResource));
    const execution = await api.json(new URL("https://run.googleapis.com/v2/" + jobResource + "/executions/" + executionId));
    // The regional v1 view preserves immutable execution network annotations
    // omitted by v2. Same run.executions.get permission, no additional grant.
    const executionV1 = await api.json(new URL(`https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${config.project}/executions/${executionId}`));
    return verifyLegacyImportJobRuntime(launch.target, manifest, {
      projectId: identity.projectId, serviceAccountEmail: identity.serviceAccount, env: launchEnv, job, execution, executionV1,
    });
  };
  const verified = await observe();
  const fetchCloudIdentity = async () => {
    const current = await observe();
    if (current.executionDigest !== verified.executionDigest) fail("job_identity_invalid");
    const metadata = await api.json(new URL(`https://sqladmin.googleapis.com/sql/v1beta4/projects/${config.project}/instances/${config.instance}`));
    parseLegacyImportJobManifest(manifestText, launch.target, now());
    return validateLegacyImportCloudMetadata(launch.target, metadata);
  };
  // Do not download client data until the private database instance metadata is
  // independently validated (no DB connection is opened by this check).
  const initialCloudIdentity = await fetchCloudIdentity();
  const verifyExecutionBeforeMutation = async () => {
    const current = await fetchCloudIdentity();
    if (current.privateAddress !== initialCloudIdentity.privateAddress) fail("job_identity_invalid");
  };
  let directory: string | undefined;
  let applyCommitted = false;
  try {
    directory = mkdtempSync("/tmp/aoa-operations-import-");
    chmodSync(directory, 0o700);
    const fileNames = {
      feeCredits: "fee-credits.csv", billingExceptions: "billing-exceptions.csv",
      tradeReconciliation: "trade-reconciliation.csv", mapping: "mapping.csv",
    } as const;
    const files = {} as Record<keyof typeof fileNames, string>;
    for (const key of Object.keys(fileNames) as (keyof typeof fileNames)[]) {
      const reference = manifest.sources[key];
      const bytes = await api.readObject({ bucket: config.bucket, name: reference.object, ...reference });
      verifyLegacyImportJobObject(bytes, reference, MAX_OBJECT_BYTES);
      const file = path.join(directory, fileNames[key]);
      writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
      files[key] = file;
    }
    let approvalReport: string | null = null;
    if (manifest.approval) {
      const reference = manifest.approval;
      const bytes = await api.readObject({ bucket: config.bucket, name: reference.object, ...reference }, MAX_JSON_BYTES);
      verifyLegacyImportJobObject(bytes, reference, MAX_JSON_BYTES);
      approvalReport = path.join(directory, "approval.json");
      writeFileSync(approvalReport, bytes, { mode: 0o600, flag: "wx" });
    }
    const result = await (dependencies.importer ?? runLegacyOperationsImport)({
      options: Object.freeze({
        target: launch.target, apply: manifest.mode === "apply", ...files,
        reportOut: null, reviewOut: null, approvalReport, approveDigest: manifest.approval?.digest ?? null,
      }),
      directUrl: env.DIRECT_DATABASE_URL, fetchCloudIdentity, executionDigest: verified.executionDigest,
      verifyExecutionBeforeMutation,
    });
    applyCommitted = result.applied !== null;
    if ((manifest.mode === "apply") !== (result.applied !== null)) fail("job_output_invalid");
    // Approval report deliberately excludes human narratives and raw identity
    // values, and is still kept private. An apply result must be recoverable as
    // one object; a failed upload never triggers an automatic rerun/import.
    const output = result.applied
      ? { appliedAtomically: true, inserted: result.applied.inserted, existing: result.applied.existing,
        notificationsCreated: 0, approvalDigest: result.approval.digest, executionDigest: verified.executionDigest }
      : result.approval;
    const suffix = manifest.mode === "apply" ? "result" : "approval";
    const name = `reports/${manifest.batchId}/${launch.manifest.sha256}.${suffix}.json`;
    let report: Readonly<{ generation: string; sha256: string }>;
    try {
      report = await api.createReport(config.bucket, name, new TextEncoder().encode(JSON.stringify(output) + "\n"));
    } catch (error) {
      if (applyCommitted) fail("job_apply_committed_report_failed");
      throw error;
    }
    return { mode: manifest.mode, blocking: result.blocking, report };
  } catch (error) {
    // The core can commit and then fail to disconnect before returning its
    // result. Preserve that state if temporary-file cleanup also fails; the
    // operator must reconcile the committed import instead of retrying it.
    if (manifest.mode === "apply" && error instanceof Error
      && error.message === "apply_committed_disconnect_failed") applyCommitted = true;
    throw error;
  } finally {
    if (directory) {
      // This exact directory was exclusively created above; never accept a
      // caller-supplied cleanup path or recursively remove a workspace root.
      try { rmSync(directory, { recursive: true, force: true }); }
      catch { fail(applyCommitted ? "job_apply_committed_cleanup_failed" : "job_temp_file_failure"); }
    }
  }
}
