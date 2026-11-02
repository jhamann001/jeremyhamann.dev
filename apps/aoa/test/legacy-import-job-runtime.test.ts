import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  boundedLegacyJobRequest, executeLegacyImportJob, LegacyImportJobGoogleApi,
  LegacyImportJobRuntimeError, safeLegacyImportJobRuntimeError,
} from "@/lib/operations/legacy-import-job-runtime";
import { getLegacyImportJobConfig, isLegacyImportJobExecutionId, type LegacyImportJobManifest } from "@/lib/operations/legacy-import-job-policy";
import type { LegacyOperationsImportInvocation, LegacyOperationsImportResult } from "../scripts/import-legacy-operations";

const filesystemFault = vi.hoisted(() => ({ cleanupFails: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, rmSync: (...args: Parameters<typeof actual.rmSync>) => {
    if (filesystemFault.cleanupFails) throw new Error("synthetic_private_cleanup_failure");
    return actual.rmSync(...args);
  } };
});

// No cloud access, credentials, production metadata, or real exports. The signed
// JWT is produced by a synthetic RSA key and verified through the same crypto
// path as a metadata identity token. Every HTTP call goes to the fake below.
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = key.publicKey.export({ format: "pem", type: "spki" }).toString();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const config = getLegacyImportJobConfig("dev");
const jobResource = `projects/${config.project}/locations/${config.region}/jobs/${config.jobName}`;
const audience = `https://run.googleapis.com/v2/${jobResource}`;
const PRIVATE = "Private Synthetic Contact,PRIVATE-ACCOUNT,Private synthetic narrative";

function token(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "synthetic" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com", aud: audience, sub: "12345678901234567890",
    email: config.serviceAccount, email_verified: true, iat: now - 1, exp: now + 3600, ...overrides,
  })).toString("base64url");
  const message = header + "." + claims;
  return message + "." + sign("RSA-SHA256", Buffer.from(message), key.privateKey).toString("base64url");
}

function setup(mode: "dry-run" | "apply" = "dry-run") {
  const batchId = "b".repeat(32);
  const files = { feeCredits: "fee-credits.csv", billingExceptions: "billing-exceptions.csv", tradeReconciliation: "trade-reconciliation.csv", mapping: "mapping.csv" };
  const objects = new Map<string, string>();
  const sources = Object.fromEntries(Object.entries(files).map(([name, file]) => {
    const object = `inputs/${batchId}/${file}`;
    objects.set(object, PRIVATE + ":" + name);
    return [name, { object, generation: "1234567890", sha256: hash(objects.get(object)!) }];
  })) as LegacyImportJobManifest["sources"];
  const approvalObject = `approved/${batchId}/approval.json`;
  objects.set(approvalObject, JSON.stringify({ digest: "a".repeat(64), synthetic: true }));
  const manifest: LegacyImportJobManifest = {
    version: 1, target: "dev", mode, batchId, image: config.imagePrefix + "c".repeat(64),
    secretVersion: "7", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sources,
    approval: mode === "apply" ? { object: approvalObject, generation: "1234567890", sha256: hash(objects.get(approvalObject)!), digest: "a".repeat(64) } : null,
  };
  const manifestText = JSON.stringify(manifest);
  const manifestSha = hash(manifestText);
  const manifestObject = `approved/${batchId}/${manifestSha}.json`;
  objects.set(manifestObject, manifestText);
  // Ephemeral, synthetic-only credential: fake HTTP/importer below never open a DB connection.
  const directUrl = new URL("postgresql://10.22.33.44:5432/aoa?schema=app&sslmode=require");
  directUrl.username = "aoa_admin";
  directUrl.password = randomUUID();
  const env = {
    NODE_ENV: "production", AOA_IMPORT_TARGET: "dev", AOA_IMPORT_MODE: mode,
    AOA_IMPORT_MANIFEST_OBJECT: manifestObject, AOA_IMPORT_MANIFEST_GENERATION: "1234567890", AOA_IMPORT_MANIFEST_SHA256: manifestSha,
    CLOUD_RUN_JOB: config.jobName, CLOUD_RUN_EXECUTION: config.jobName + "-abc123", CLOUD_RUN_TASK_INDEX: "0", CLOUD_RUN_TASK_COUNT: "1", CLOUD_RUN_TASK_ATTEMPT: "0",
    DIRECT_DATABASE_URL: directUrl.href,
  };
  const template = {
    serviceAccount: config.serviceAccount, maxRetries: 0, timeout: "600s",
    vpcAccess: { egress: "PRIVATE_RANGES_ONLY", networkInterfaces: [{ network: config.network, subnetwork: config.subnet }] },
    containers: [{ image: manifest.image, env: [
      ...Object.entries(env).filter(([name]) => name === "NODE_ENV" || name.startsWith("AOA_IMPORT_")).map(([name, value]) => ({ name, value })),
      { name: "DIRECT_DATABASE_URL", valueSource: { secretKeyRef: { secret: config.secret, version: manifest.secretVersion } } },
    ] }],
  };
  const job = { name: jobResource, uid: "synthetic-job-uid", generation: "2", template: { taskCount: 1, parallelism: 1, template } };
  // The actual v2 response uses a short parent and omits execution VPC settings.
  const execution = { name: `${jobResource}/executions/${env.CLOUD_RUN_EXECUTION}`, uid: "synthetic-execution-uid",
    job: config.jobName, taskCount: 1, parallelism: 1,
    template: { serviceAccount: template.serviceAccount, maxRetries: template.maxRetries, timeout: template.timeout, containers: structuredClone(template.containers) } };
  const executionV1 = { apiVersion: "run.googleapis.com/v1", kind: "Execution", metadata: {
    name: env.CLOUD_RUN_EXECUTION, namespace: config.projectNumber, uid: execution.uid,
    labels: { "cloud.googleapis.com/location": config.region, "run.googleapis.com/job": config.jobName,
      "run.googleapis.com/jobUid": job.uid, "run.googleapis.com/jobGeneration": job.generation },
    annotations: { "run.googleapis.com/network-interfaces": JSON.stringify([{ network: config.network, subnetwork: config.subnet }]),
      "run.googleapis.com/vpc-access-egress": "private-ranges-only" },
  } };
  const calls: { url: URL; options: RequestInit }[] = [];
  const uploads: string[] = [];
  let jwt = token();
  let reportFails = false;
  const fetcher = vi.fn(async (input: string | URL | Request, options: RequestInit = {}) => {
    const url = new URL(input.toString());
    calls.push({ url, options });
    const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers });
    if (url.hostname === "metadata.google.internal") {
      const headers = { "Metadata-Flavor": "Google" };
      const values: Record<string, string> = {
        "/computeMetadata/v1/project/project-id": config.project,
        "/computeMetadata/v1/instance/service-accounts/default/email": config.serviceAccount,
        "/computeMetadata/v1/instance/service-accounts/default/identity": jwt,
      };
      if (url.pathname.endsWith("/token")) return json({ access_token: "SYNTHETIC_TOKEN_DO_NOT_PRINT", expires_in: 3600, token_type: "Bearer" }, headers);
      if (url.pathname in values) return new Response(values[url.pathname], { headers });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname === "/oauth2/v1/certs") return json({ synthetic: publicKey });
    if (url.hostname === "run.googleapis.com") return json(url.pathname.includes("/executions/") ? execution : job);
    if (url.hostname === "us-central1-run.googleapis.com") {
      expect(url.pathname).toBe(`/apis/run.googleapis.com/v1/namespaces/${config.project}/executions/${env.CLOUD_RUN_EXECUTION}`);
      expect(url.search).toBe("");
      expect(options.method ?? "GET").toBe("GET");
      return json(executionV1);
    }
    if (url.hostname === "sqladmin.googleapis.com") return json({
      name: config.instance, region: config.region, project: config.project, connectionName: config.connectionName,
      ipAddresses: [{ type: "PRIVATE", ipAddress: "10.22.33.44" }],
    });
    if (url.hostname === "storage.googleapis.com") {
      if (options.method === "POST") {
        if (reportFails) return new Response("private failure", { status: 503 });
        expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
        uploads.push(Buffer.from(options.body as Buffer).toString("utf8"));
        return json({ bucket: config.bucket, name: url.searchParams.get("name"), generation: "9876543210", size: String(Buffer.byteLength(uploads.at(-1)!)) });
      }
      const object = url.pathname.split("/o/")[1];
      if (!object) return json({ name: config.bucket, iamConfiguration: { publicAccessPrevention: "enforced", uniformBucketLevelAccess: { enabled: true } } });
      const name = decodeURIComponent(object);
      const text = objects.get(name);
      if (text === undefined) return new Response("unknown object", { status: 404 });
      if (url.searchParams.get("alt") === "media") return new Response(text);
      return json({ bucket: config.bucket, name, generation: "1234567890", size: String(Buffer.byteLength(text)) });
    }
    throw new Error("Unexpected synthetic HTTP route");
  }) as unknown as typeof fetch;
  const approval = { digest: "a".repeat(64), plan: { synthetic: true } } as unknown as LegacyOperationsImportResult["approval"];
  const importer = vi.fn(async (invocation: LegacyOperationsImportInvocation): Promise<LegacyOperationsImportResult> => {
    await invocation.fetchCloudIdentity!();
    return { approval, blocking: false, applied: mode === "apply" ? { inserted: { FEE_CREDIT: 1 }, existing: { FEE_CREDIT: 0 } } as unknown as NonNullable<LegacyOperationsImportResult["applied"]> : null };
  });
  return { env, manifest, objects, job, execution, executionV1, calls, uploads, fetcher, importer,
    setJwt: (value: string) => { jwt = value; }, failReport: () => { reportFails = true; } };
}

describe("bounded private-job HTTP", () => {
  it.each(["https://attacker.invalid/private", "http://run.googleapis.com/private", "https://metadata.google.internal/private", "https://user:pass@storage.googleapis.com/private"])("rejects nonallowlisted/credential URL %s before fetch", async (value) => {
    const fetcher = vi.fn();
    await expect(boundedLegacyJobRequest(fetcher, new URL(value), {}, 32)).rejects.toThrow("job_http_target_invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("enforces a streaming byte bound even without content-length", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("x".repeat(100)));
    await expect(boundedLegacyJobRequest(fetcher, new URL("https://storage.googleapis.com/allowed"), {}, 20)).rejects.toThrow("job_http_response_too_large");
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("requires the metadata server response flavor", async () => {
    await expect(boundedLegacyJobRequest(vi.fn().mockResolvedValue(new Response("fake")), new URL("http://metadata.google.internal/computeMetadata/v1/project/project-id"), {}, 32)).rejects.toThrow("job_identity_invalid");
  });
  it("redacts network exceptions, response bodies and arbitrary policy-like errors", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(PRIVATE));
    await expect(boundedLegacyJobRequest(fetcher, new URL("https://storage.googleapis.com/allowed"), {}, 32)).rejects.toThrow("job_http_failed");
    expect(safeLegacyImportJobRuntimeError(new Error(PRIVATE))).toBe("job_execution_failed");
    expect(safeLegacyImportJobRuntimeError(new LegacyImportJobRuntimeError(PRIVATE))).toBe("job_execution_failed");
  });
});

describe.each(["dev", "prod"] as const)("fixed-prefix execution IDs: %s", (target) => {
  const prefix = getLegacyImportJobConfig(target).jobName + "-";
  it.each(["a0z", "a".repeat(32)])("accepts the bounded ASCII suffix %s", (suffix) => {
    expect(isLegacyImportJobExecutionId(target, prefix + suffix)).toBe(true);
  });
  it.each([
    ["too short", "ab"], ["too long", "a".repeat(33)],
    ["oversized near-match", "a".repeat(1_000_000) + "!"],
    ["uppercase", "ABc"], ["Unicode", "aéz"], ["space", "a z"],
    ["trailing newline", "abc\n"], ["null byte", "abc\u0000"],
    ["path injection", "abc/../other"], ["regex syntax", "(a+)+$"],
    ["hyphen", "a-b"], ["underscore", "a_b"],
  ])("rejects %s", (_label, suffix) => {
    expect(isLegacyImportJobExecutionId(target, prefix + suffix)).toBe(false);
  });
  it("rejects a different target or arbitrary job name", () => {
    const other = getLegacyImportJobConfig(target === "dev" ? "prod" : "dev").jobName;
    expect(isLegacyImportJobExecutionId(target, other + "-abc")).toBe(false);
    expect(isLegacyImportJobExecutionId(target, "untrusted-job-abc")).toBe(false);
  });
  it.each([undefined, null, 123, {}, ["abc"], ""])("rejects non-string/empty input %#", (value) => {
    expect(isLegacyImportJobExecutionId(target, value)).toBe(false);
  });
});

describe("authenticated private-job execution", () => {
  it.each(["dry-run", "apply"] as const)("verifies identity and pinned source bytes before %s; cleans 0600 files", async (mode) => {
    const fixture = setup(mode);
    let directory: string | undefined;
    const importer = vi.fn(async (invocation: LegacyOperationsImportInvocation) => {
      directory = path.dirname(invocation.options.feeCredits!);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      for (const file of [invocation.options.feeCredits, invocation.options.billingExceptions, invocation.options.tradeReconciliation, invocation.options.mapping]) {
        expect(statSync(file!).mode & 0o777).toBe(0o600);
        expect(readFileSync(file!, "utf8")).toContain(PRIVATE);
      }
      expect(invocation.executionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(invocation.options.apply).toBe(mode === "apply");
      expect(invocation.options.approvalReport !== null).toBe(mode === "apply");
      return fixture.importer(invocation);
    });
    const result = await executeLegacyImportJob(fixture.env, [], { fetcher: fixture.fetcher, importer });
    expect(result.mode).toBe(mode);
    expect(result.blocking).toBe(false);
    expect(importer).toHaveBeenCalledOnce();
    expect(directory).toBeDefined();
    expect(existsSync(directory!)).toBe(false);
    expect(fixture.uploads).toHaveLength(1);
    expect(fixture.uploads[0]).not.toContain(PRIVATE);
    expect(fixture.uploads[0]).not.toContain(new URL(fixture.env.DIRECT_DATABASE_URL).password);
    expect(fixture.uploads[0]).not.toContain(fixture.env.DIRECT_DATABASE_URL);
    const getRun = fixture.calls.filter((call) => call.url.hostname === "run.googleapis.com");
    expect(getRun.length).toBeGreaterThanOrEqual(6);
    const getSnapshot = fixture.calls.filter((call) => call.url.hostname === "us-central1-run.googleapis.com");
    expect(getSnapshot).toHaveLength(getRun.length / 2);
    const firstClientData = fixture.calls.findIndex((call) => call.url.pathname.includes("inputs%2F"));
    expect(fixture.calls.findIndex((call) => call.url.hostname === "us-central1-run.googleapis.com")).toBeLessThan(firstClientData);
    expect(fixture.calls.findIndex((call) => call.url.hostname === "sqladmin.googleapis.com")).toBeLessThan(firstClientData);
    expect(fixture.calls.every((call) => call.options.redirect === "error")).toBe(true);
  });

  it.each(["missing", "wrong-uid", "wrong-network", "unavailable"] as const)("rejects %s immutable execution proof before SQL/source/importer", async (fault) => {
    const fixture = setup();
    const fetcher: typeof fetch = async (input, options) => {
      if (new URL(input.toString()).hostname === "us-central1-run.googleapis.com") {
        if (fault === "unavailable") return new Response("PRIVATE upstream failure", { status: 403 });
        const snapshot = structuredClone(fixture.executionV1);
        if (fault === "wrong-uid") snapshot.metadata.uid = "other-execution";
        if (fault === "wrong-network") snapshot.metadata.annotations["run.googleapis.com/network-interfaces"] = '[{"network":"other","subnetwork":"other"}]';
        return new Response(JSON.stringify(fault === "missing" ? {} : snapshot));
      }
      return fixture.fetcher(input, options);
    };
    await expect(executeLegacyImportJob(fixture.env, [], { fetcher, importer: fixture.importer })).rejects.toThrow(
      fault === "unavailable" ? "job_http_failed" : fault === "wrong-network" ? "import_job_network_invalid" : "import_job_execution_invalid",
    );
    expect(fixture.importer).not.toHaveBeenCalled();
    expect(fixture.uploads).toEqual([]);
    expect(fixture.calls.some((call) => call.url.hostname === "sqladmin.googleapis.com" || call.url.pathname.includes("inputs%2F"))).toBe(false);
  });

  it("rechecks immutable proof before mutation and rejects a substituted execution snapshot", async () => {
    const fixture = setup("apply");
    let attemptedWrites = 0;
    const importer = vi.fn(async (invocation: LegacyOperationsImportInvocation) => {
      fixture.executionV1.metadata.uid = "substituted-execution";
      await invocation.verifyExecutionBeforeMutation!();
      attemptedWrites++;
      return fixture.importer(invocation);
    });
    await expect(executeLegacyImportJob(fixture.env, [], { fetcher: fixture.fetcher, importer })).rejects.toThrow("import_job_execution_invalid");
    expect(importer).toHaveBeenCalledOnce();
    expect(attemptedWrites).toBe(0);
    expect(fixture.importer).not.toHaveBeenCalled();
    expect(fixture.uploads).toEqual([]);
  });

  it.each([
    { CLOUD_RUN_JOB: undefined }, { CLOUD_RUN_TASK_ATTEMPT: "1" }, { CLOUD_RUN_TASK_COUNT: "2" }, { K_SERVICE: "web" },
    { CLOUD_RUN_EXECUTION: config.jobName + "-abc/../other" },
    { CLOUD_RUN_EXECUTION: config.jobName + "-" + "a".repeat(33) },
    { CLOUD_RUN_EXECUTION: config.jobName + "-abc\n" },
  ])("cannot masquerade as a workstation or service (%j)", async (overrides) => {
    const fixture = setup();
    await expect(executeLegacyImportJob({ ...fixture.env, ...overrides }, [], { fetcher: fixture.fetcher, importer: fixture.importer })).rejects.toThrow("job_runtime_required");
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(fixture.importer).not.toHaveBeenCalled();
  });

  it.each([{ aud: "https://attacker.invalid" }, { email: "other@example.invalid" }, { email_verified: false }, { exp: Math.floor(Date.now() / 1000) - 3600 }])("rejects an invalid signed identity token before reading any object (%j)", async (claims) => {
    const fixture = setup();
    fixture.setJwt(token(claims));
    await expect(executeLegacyImportJob(fixture.env, [], { fetcher: fixture.fetcher, importer: fixture.importer })).rejects.toThrow("job_identity_invalid");
    expect(fixture.importer).not.toHaveBeenCalled();
    expect(fixture.calls.some((call) => call.url.hostname === "storage.googleapis.com")).toBe(false);
  });

  it("rejects an image override before reading any client source", async () => {
    const fixture = setup();
    fixture.execution.template = { ...fixture.execution.template, containers: [{ ...fixture.execution.template.containers[0], image: config.imagePrefix + "e".repeat(64) }] };
    await expect(executeLegacyImportJob(fixture.env, [], { fetcher: fixture.fetcher, importer: fixture.importer })).rejects.toThrow("import_job_container_invalid");
    expect(fixture.importer).not.toHaveBeenCalled();
    expect(fixture.calls.some((call) => call.url.pathname.includes("inputs%2F"))).toBe(false);
  });

  it("rejects corrupt pinned source bytes and removes temporary material", async () => {
    const fixture = setup();
    fixture.objects.set(fixture.manifest.sources.feeCredits.object, "changed bytes");
    await expect(executeLegacyImportJob(fixture.env, [], { fetcher: fixture.fetcher, importer: fixture.importer })).rejects.toThrow("job_object_digest_mismatch");
    expect(fixture.importer).not.toHaveBeenCalled();
    expect(fixture.uploads).toHaveLength(0);
  });

  it("cleans files on database/engine errors without retrying", async () => {
    const fixture = setup();
    let directory = "";
    const importer = vi.fn(async (invocation: LegacyOperationsImportInvocation): Promise<LegacyOperationsImportResult> => {
      directory = path.dirname(invocation.options.feeCredits!);
      throw new Error("synthetic_database_rejected");
    });
    await expect(executeLegacyImportJob(fixture.env, [], { fetcher: fixture.fetcher, importer })).rejects.toThrow("synthetic_database_rejected");
    expect(existsSync(directory)).toBe(false);
    expect(importer).toHaveBeenCalledOnce();
  });

  it("rejects expiry before mutation even when own-job metadata reads still succeed", async () => {
    const fixture = setup("apply");
    let clock = Date.now();
    let directory = "";
    let attemptedWrites = 0;
    const importer = vi.fn(async (invocation: LegacyOperationsImportInvocation): Promise<LegacyOperationsImportResult> => {
      directory = path.dirname(invocation.options.feeCredits!);
      // The ordinary metadata-only IAM binding can remain readable; it is not
      // authority to mutate after the separately pinned manifest expires.
      const api = new LegacyImportJobGoogleApi(fixture.fetcher, () => clock);
      clock = Date.parse(fixture.manifest.expiresAt);
      await expect(api.json(new URL(audience))).resolves.toEqual(fixture.job);
      await expect(api.json(new URL(audience + "/executions/" + fixture.env.CLOUD_RUN_EXECUTION)))
        .resolves.toEqual(fixture.execution);
      await invocation.verifyExecutionBeforeMutation!();
      attemptedWrites++;
      return fixture.importer(invocation);
    });
    await expect(executeLegacyImportJob(fixture.env, [], { fetcher: fixture.fetcher, now: () => clock, importer }))
      .rejects.toMatchObject({ message: "import_job_approval_expired" });
    expect(importer).toHaveBeenCalledOnce();
    expect(attemptedWrites).toBe(0);
    expect(fixture.importer).not.toHaveBeenCalled();
    expect(fixture.uploads).toEqual([]);
    expect(existsSync(directory)).toBe(false);
  });

  it("clearly reports a committed apply whose private result upload fails; never retries apply", async () => {
    const fixture = setup("apply");
    fixture.failReport();
    await expect(executeLegacyImportJob(fixture.env, [], { fetcher: fixture.fetcher, importer: fixture.importer })).rejects.toThrow("job_apply_committed_report_failed");
    expect(fixture.importer).toHaveBeenCalledOnce();
  });

  it.each([false, true])("retains known commit state after core disconnect failure when cleanup fails=%s", async (cleanupFails) => {
    const fixture = setup("apply");
    let directory = "";
    const importer = vi.fn(async (invocation: LegacyOperationsImportInvocation): Promise<LegacyOperationsImportResult> => {
      directory = path.dirname(invocation.options.feeCredits!);
      // This literal code is emitted by the core only after apply committed.
      throw new Error("apply_committed_disconnect_failed");
    });
    filesystemFault.cleanupFails = cleanupFails;
    try {
      await expect(executeLegacyImportJob(fixture.env, [], { fetcher: fixture.fetcher, importer })).rejects.toThrow(
        cleanupFails ? "job_apply_committed_cleanup_failed" : "apply_committed_disconnect_failed",
      );
      expect(importer).toHaveBeenCalledOnce();
      expect(fixture.uploads).toEqual([]);
      expect(existsSync(directory)).toBe(cleanupFails);
    } finally {
      filesystemFault.cleanupFails = false;
      if (directory && existsSync(directory)) rmSync(directory, { recursive: true });
    }
  });

  it("rejects argument overrides before any cloud access", async () => {
    const fixture = setup();
    await expect(executeLegacyImportJob(fixture.env, ["--skip-validation"], { fetcher: fixture.fetcher, importer: fixture.importer })).rejects.toThrow("job_arguments_invalid");
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });
});

describe("generation-pinned storage transport", () => {
  it("refuses a nonprivate bucket", async () => {
    const fixture = setup();
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      if (new URL(input.toString()).hostname === "storage.googleapis.com") return new Response(JSON.stringify({ name: config.bucket, iamConfiguration: { publicAccessPrevention: "inherited", uniformBucketLevelAccess: { enabled: true } } }));
      return fixture.fetcher(input, options);
    }) as unknown as typeof fetch;
    await expect(new LegacyImportJobGoogleApi(fetcher).verifyPrivateBucket(config.bucket)).rejects.toThrow("job_bucket_not_private");
  });
  it("retains an explicit generation on both metadata and media requests", async () => {
    const fixture = setup();
    const source = fixture.manifest.sources.feeCredits;
    await new LegacyImportJobGoogleApi(fixture.fetcher).readObject({ bucket: config.bucket, name: source.object, ...source });
    const calls = fixture.calls.filter((call) => call.url.hostname === "storage.googleapis.com");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url.searchParams.get("generation") === source.generation)).toBe(true);
    expect(calls[1].url.searchParams.get("alt")).toBe("media");
  });
});
