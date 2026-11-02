import { describe, expect, it } from "vitest";
import { parseLegacyImportOptions } from "@/lib/operations/legacy-import-target";
import {
  getLegacyImportJobConfig, legacyImportJobExecutionDigest,
  parseLegacyImportJobLaunch, parseLegacyImportJobManifest,
  verifyLegacyImportJobObject, verifyLegacyImportJobRuntime,
  type LegacyImportJobManifest, type LegacyImportJobObservation,
} from "@/lib/operations/legacy-import-job-policy";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import {
  boundedLegacyJobRequest, LegacyImportJobGoogleApi, safeLegacyImportJobRuntimeError,
} from "@/lib/operations/legacy-import-job-runtime";

describe("private import security: reviewed container inputs", () => {
  const recipe = readFileSync(resolve(process.cwd(), "Dockerfile.operations-import"), "utf8");
  const instructions = recipe.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

  const stages = instructions.split(/^FROM /m).slice(1);
  const runtime = stages[1];

  it("pins same-family Node/Alpine build and minimal Alpine runtime to verified official digests", () => {
    expect(instructions.match(/^FROM .+$/gm)).toEqual([
      "FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS dependencies",
      "FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS operations-import",
    ]);
    expect(instructions).not.toMatch(/^ARG\s/m);
  });

  it("pins native TLS/CA/zlib dependencies without glibc compatibility or floating upgrades", () => {
    const installs = stages.map((stage) => stage.replace(/\\\n/g, " ")
      .match(/RUN apk add --no-cache\s+([^\n]+?)(?:\s+&&|\n)/)?.[1].trim().split(/\s+/));
    const shared = ["ca-certificates=20261020-r0", "libcrypto3=3.5.9-r0", "libssl3=3.5.9-r0", "openssl=3.5.9-r0"];
    expect(installs).toEqual([
      [...shared, "zlib=1.3.2-r1"],
      [...shared, "libgcc=15.2.0-r5", "libstdc++=15.2.0-r5", "zlib=1.3.2-r1"],
    ]);
    expect(instructions).not.toMatch(/apt-get|apk upgrade|--allow-untrusted|--no-check-certificate|libc6-compat|gcompat/);
    expect(instructions).not.toContain("ca-certificates=20260611-r0");
    expect(instructions).not.toContain("ca-certificates=20260909-r0");
    expect(instructions).not.toContain("zlib=1.3.2-r0");
  });

  it("copies only Node and installed app artifacts from builder, never global package managers or toolchains", () => {
    expect(stages[0]).toContain("RUN npm ci");
    expect(stages[0]).toContain("COPY prisma/schema.prisma ./prisma/schema.prisma");
    expect(stages[0]).toContain("COPY prisma/migrations ./prisma/migrations");
    expect(instructions).not.toMatch(/--omit=dev|npm prune|--ignore-scripts/);
    expect(runtime.match(/^COPY --from=dependencies .+$/gm)).toEqual([
      "COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node",
      "COPY --from=dependencies /app/node_modules ./node_modules",
      "COPY --from=dependencies /app/package.json /app/package-lock.json /app/tsconfig.json ./",
      "COPY --from=dependencies /app/prisma ./prisma",
    ]);
    expect(runtime).toContain("apk del --no-network apk-tools");
    expect(runtime).toContain("test -s /lib/apk/db/installed");
    expect(runtime).not.toMatch(/^COPY (?:\.\s|\/|--from=dependencies \/(?:usr\/local|opt)\s)/m);
    expect(runtime).not.toMatch(/rm\s.*(?:\/lib\/apk|\/var\/lib\/dpkg|package-lock)/);
    expect(runtime).toContain("COPY Dockerfile.operations-import Dockerfile.operations-import.dockerignore ./");
  });

  it("preserves the non-root exit-based batch contract without a dummy health server", () => {
    expect(instructions).toMatch(/^USER node$/m);
    expect(instructions).not.toMatch(/^(?:HEALTHCHECK|EXPOSE)\s/m);
    expect(instructions).toContain('ENTRYPOINT ["node", "--import", "tsx", "scripts/import-legacy-operations-job.ts"]');
    expect(runtime.match(/^CMD .+$/gm)).toEqual(["CMD []"]);
  });

  // Execute the actual embedded build-check JavaScript with synthetic OS/native
  // module stubs. This validates fail-closed logic, not a real image/native load.
  const check = runtime.match(/RUN --network=none node --input-type=commonjs -e '([\s\S]*?)'\n/)?.[1].replace(/\\\n/g, " ");
  function runBuildCheck(change: {
    platform?: string; arch?: string; uid?: number; forbiddenPath?: string;
    certificate?: string; inventorySize?: number; missingTsx?: boolean; missingEngine?: boolean; badEngine?: boolean;
  } = {}) {
    expect(check).toBeTruthy();
    expect(runtime.indexOf("USER node")).toBeLessThan(runtime.indexOf("RUN --network=none"));
    const requested: string[] = [];
    const requireModule = Object.assign((name: string) => {
      requested.push(name);
      if (name === "node:fs") return {
        lstatSync: (file: string, options: unknown) => {
          expect(options).toEqual({ throwIfNoEntry: false });
          return file === change.forbiddenPath ? {} : undefined;
        },
        readFileSync: (file: string) => {
          expect(file).toBe("/etc/ssl/certs/ca-certificates.crt");
          return change.certificate ?? "-----BEGIN CERTIFICATE----- synthetic fixture";
        },
        statSync: (file: string) => {
          expect(file).toBe("/lib/apk/db/installed");
          return { size: change.inventorySize ?? 100 };
        },
      };
      expect(name).toBe("./node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node");
      if (change.missingEngine) throw new Error("synthetic_native_load_failure");
      return change.badEngine ? {} : { QueryEngine: function SyntheticEngine() {} };
    }, { resolve: (name: string) => {
      expect(name).toBe("tsx");
      if (change.missingTsx) throw new Error("synthetic_tsx_missing");
      return "/app/node_modules/tsx/dist/loader.mjs";
    } });
    new Script(check!).runInNewContext({ require: requireModule, process: {
      platform: change.platform ?? "linux", arch: change.arch ?? "x64", getuid: () => change.uid ?? 1000,
    } }, { timeout: 1_000 });
    return requested;
  }
  it("build-check loads the musl/OpenSSL3 native engine with no database/network API", () => {
    expect(runBuildCheck()).toEqual(["node:fs", "./node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node"]);
  });
  it.each([
    { platform: "darwin" }, { arch: "arm64" }, { uid: 0 }, { certificate: "" },
    { inventorySize: 0 }, { missingTsx: true }, { missingEngine: true }, { badEngine: true },
  ])("build-check rejects wrong identity/missing runtime components %#", (change) => {
    expect(() => runBuildCheck(change)).toThrow();
  });
  it.each(["/usr/local/lib/node_modules/npm", "/usr/local/bin/npm", "/usr/local/bin/npx",
    "/opt/yarn-v1.22.22", "/usr/local/bin/yarn", "/usr/local/bin/yarnpkg", "/usr/local/include/node",
    "/usr/bin/gcc", "/usr/bin/g++", "/usr/bin/make", "/usr/bin/python3", "/sbin/apk",
  ])("build-check rejects leftover package-manager/toolchain path %s", (forbiddenPath) => {
    expect(() => runBuildCheck({ forbiddenPath })).toThrow("build_tool_in_runtime");
  });
});

const workstationApply = [
  "--target", "prod", "--fee-credits", "/private/synthetic.csv",
  "--apply", "--confirm", "APPLY_FEE_STORE_LEGACY_TO_PROD",
  "--approval-report", "/private/synthetic.approval.json",
  "--approve-digest", "a".repeat(64),
];

describe("private import security: workstation boundary stays closed", () => {
  it.each([
    { CLOUD_RUN_JOB: "synthetic-import" },
    { CLOUD_RUN_EXECUTION: "synthetic-import-123" },
    { CLOUD_RUN_TASK_INDEX: "0" },
    { CLOUD_RUN_TASK_COUNT: "1" },
    { CLOUD_RUN_TASK_ATTEMPT: "0" },
  ])("rejects Cloud Run Job context even if NODE_ENV is not production (%j)", (jobEnvironment) => {
    expect(() => parseLegacyImportOptions(workstationApply, {
      NODE_ENV: "test",
      AOA_ALLOW_LEGACY_OPERATIONS_PROD_APPLY: "1",
      ...jobEnvironment,
    })).toThrow("apply_must_run_from_an_operator_workstation");
  });

  it("does not turn the workstation entrypoint into job mode using approval-looking env", () => {
    expect(() => parseLegacyImportOptions(workstationApply, {
      NODE_ENV: "test",
      CLOUD_RUN_JOB: "synthetic-import",
      AOA_ALLOW_LEGACY_OPERATIONS_PROD_APPLY: "1",
      AOA_APPROVED_IMPORT_JOB: "1",
      AOA_PRIVATE_IMPORT_JOB: "1",
      AOA_PRIVATE_IMPORT_APPROVED: "1",
    })).toThrow("apply_must_run_from_an_operator_workstation");
  });

  it("preserves the existing genuine-workstation path after separate approval gates", () => {
    expect(parseLegacyImportOptions(workstationApply, {
      NODE_ENV: "test",
      AOA_ALLOW_LEGACY_OPERATIONS_PROD_APPLY: "1",
    })).toMatchObject({ target: "prod", apply: true });
  });
});

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const H = "a".repeat(64);
const B = "b".repeat(32);

function manifestFixture(target: "dev" | "prod" = "prod"): LegacyImportJobManifest {
  const c = getLegacyImportJobConfig(target);
  const source = (name: string) => ({ object: `inputs/${B}/${name}.csv`, generation: "123456789", sha256: H });
  return {
    version: 1, target, mode: "dry-run", batchId: B,
    image: `${c.imagePrefix}${H}`, secretVersion: "4", expiresAt: "2026-09-15T13:00:00.000Z",
    sources: {
      feeCredits: source("fee-credits"), billingExceptions: source("billing-exceptions"),
      tradeReconciliation: source("trade-reconciliation"), mapping: source("mapping"),
    }, approval: null,
  };
}

function runtimeFixture(manifest: LegacyImportJobManifest): LegacyImportJobObservation {
  const c = getLegacyImportJobConfig(manifest.target);
  const manifestHash = hash(JSON.stringify(manifest));
  const env = {
    NODE_ENV: "production", AOA_IMPORT_TARGET: manifest.target, AOA_IMPORT_MODE: manifest.mode,
    AOA_IMPORT_MANIFEST_OBJECT: `approved/${B}/${manifestHash}.json`,
    AOA_IMPORT_MANIFEST_GENERATION: "123456789", AOA_IMPORT_MANIFEST_SHA256: manifestHash,
    CLOUD_RUN_JOB: c.jobName, CLOUD_RUN_EXECUTION: `${c.jobName}-12345`,
    CLOUD_RUN_TASK_INDEX: "0", CLOUD_RUN_TASK_COUNT: "1", CLOUD_RUN_TASK_ATTEMPT: "0",
  };
  const name = `projects/${c.project}/locations/${c.region}/jobs/${c.jobName}`;
  const template = {
    serviceAccount: c.serviceAccount, maxRetries: 0, timeout: "600s",
    vpcAccess: { egress: "PRIVATE_RANGES_ONLY", networkInterfaces: [{ network: c.network, subnetwork: c.subnet }] },
    containers: [{
      image: manifest.image,
      env: [
        ...Object.entries(env).filter(([key]) => !key.startsWith("CLOUD_RUN_")).map(([key, value]) => ({ name: key, value })),
        { name: "DIRECT_DATABASE_URL", valueSource: { secretKeyRef: { secret: c.secret, version: manifest.secretVersion } } },
      ],
    }],
  };
  return {
    projectId: c.project, serviceAccountEmail: c.serviceAccount, env,
    job: { name, uid: "synthetic-job-uid", generation: "2", template: { taskCount: 1, parallelism: 1, template: clone(template) } },
    execution: { name: `${name}/executions/${env.CLOUD_RUN_EXECUTION}`, uid: "synthetic-execution-uid", job: name, taskCount: 1, parallelism: 1, retriedCount: 0, template: clone(template) },
    executionV1: { apiVersion: "run.googleapis.com/v1", kind: "Execution", metadata: {
      name: env.CLOUD_RUN_EXECUTION, namespace: c.projectNumber, uid: "synthetic-execution-uid",
      labels: { "cloud.googleapis.com/location": c.region, "run.googleapis.com/job": c.jobName,
        "run.googleapis.com/jobUid": "synthetic-job-uid", "run.googleapis.com/jobGeneration": "2" },
      annotations: { "run.googleapis.com/network-interfaces": JSON.stringify([{ network: c.network, subnetwork: c.subnet }]),
        "run.googleapis.com/vpc-access-egress": "private-ranges-only" },
    } },
  };
}

type Json = Record<string, any>; // Raw authenticated Google response test mutations.

describe("private import security: strict immutable manifest", () => {
  it.each(["dev", "prod"] as const)("accepts the exact %s target and freezes nested source references", (target) => {
    const input = manifestFixture(target);
    const result = parseLegacyImportJobManifest(JSON.stringify(input), target, NOW);
    expect(result).toEqual(input);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sources)).toBe(true);
    expect(Object.isFrozen(result.sources.feeCredits)).toBe(true);
  });

  it.each([
    ["duplicate root key", (m: Json) => JSON.stringify(m).replace('"version":1', '"version":1,"version":1')],
    ["escaped duplicate key", (m: Json) => JSON.stringify(m).replace('"version":1', '"version":1,"\\u0076ersion":1')],
    ["duplicate source generation", (m: Json) => JSON.stringify(m).replace('"generation":"123456789"', '"generation":"123456789","generation":"123456789"')],
    ["pretty JSON ambiguity", (m: Json) => JSON.stringify(m, null, 2)],
  ] as const)("rejects %s", (_label, serialize) => {
    expect(() => parseLegacyImportJobManifest(serialize(manifestFixture()), "prod", NOW)).toThrow();
  });

  it.each([
    ["other target", (m: Json) => { m.target = "dev"; }],
    ["array-valued mode", (m: Json) => { m.mode = ["apply"]; m.approval = { object: `approved/${B}/approval.json`, generation: "1", sha256: H, digest: H }; }],
    ["other project image", (m: Json) => { m.image = m.image.replace("ops-portal/", "ops-portal-dev/"); }],
    ["mutable image tag", (m: Json) => { m.image = m.image.replace(`@sha256:${H}`, ":latest"); }],
    ["mutable secret", (m: Json) => { m.secretVersion = "latest"; }],
    ["extra source", (m: Json) => { m.sources.extra = m.sources.mapping; }],
    ["missing mapping", (m: Json) => { delete m.sources.mapping; }],
    ["cross-batch source", (m: Json) => { m.sources.mapping.object = `inputs/${"c".repeat(32)}/mapping.csv`; }],
    ["path traversal", (m: Json) => { m.sources.mapping.object = `inputs/${B}/../mapping.csv`; }],
    ["external URL", (m: Json) => { m.sources.mapping.object = "https://example.invalid/source.csv"; }],
    ["unversioned source", (m: Json) => { delete m.sources.mapping.generation; }],
    ["numeric generation", (m: Json) => { m.sources.mapping.generation = 123456789; }],
    ["zero generation", (m: Json) => { m.sources.mapping.generation = "0"; }],
    ["uppercase SHA", (m: Json) => { m.sources.mapping.sha256 = H.toUpperCase(); }],
    ["invented authorization", (m: Json) => { m.approved = true; }],
    ["approval on dry run", (m: Json) => { m.approval = { object: `approved/${B}/approval.json`, generation: "1", sha256: H, digest: H }; }],
    ["apply without report", (m: Json) => { m.mode = "apply"; }],
    ["expired approval", (m: Json) => { m.expiresAt = "2026-09-15T11:59:59.000Z"; }],
    ["exact expiration", (m: Json) => { m.expiresAt = "2026-09-15T12:00:00.000Z"; }],
    ["more than 24 hours", (m: Json) => { m.expiresAt = "2026-09-16T12:00:00.001Z"; }],
    ["noncanonical expiration", (m: Json) => { m.expiresAt = "2026-09-15T13:00:00Z"; }],
  ] as const)("rejects %s", (_label, mutate) => {
    const input = clone(manifestFixture()) as Json;
    mutate(input);
    expect(() => parseLegacyImportJobManifest(JSON.stringify(input), "prod", NOW)).toThrow();
  });

  it("rejects oversized manifests and unsafe JSON without echoing source values", () => {
    for (const raw of ["PRIVATE-ACCOUNT", "x".repeat(16_385), "null", "[]", "{}"] ) {
      try { parseLegacyImportJobManifest(raw, "prod", NOW); expect.fail("must reject"); }
      catch (error) { expect(String(error)).not.toContain("PRIVATE-ACCOUNT"); }
    }
  });

  it.each([
    { AOA_IMPORT_MODE: "disabled" }, { AOA_IMPORT_TARGET: "production" },
    { AOA_IMPORT_MANIFEST_OBJECT: "https://example.invalid/private.json" },
    { AOA_IMPORT_MANIFEST_GENERATION: "1\n" }, { AOA_IMPORT_MANIFEST_GENERATION: "01" },
    { AOA_IMPORT_MANIFEST_SHA256: "f".repeat(64) },
  ])("rejects malformed manifest launch pins (%j)", (overrides) => {
    expect(() => parseLegacyImportJobLaunch({ ...runtimeFixture(manifestFixture()).env, ...overrides })).toThrow();
  });
});

describe("private import security: authenticated effective execution", () => {
  it.each(["dev", "prod"] as const)("accepts the exact independently observed %s job", (target) => {
    const manifest = manifestFixture(target);
    expect(verifyLegacyImportJobRuntime(target, manifest, runtimeFixture(manifest))).toEqual({
      executionDigest: legacyImportJobExecutionDigest(manifest),
    });
  });

  it.each([
    ["wrong metadata project", (o: Json) => { o.projectId = "other-project"; }],
    ["shared runtime service account", (o: Json) => { o.serviceAccountEmail = "Gtyiwf9bRptzzwuy-account@example-project.iam.gserviceaccount.com"; }],
    ["service instead of job", (o: Json) => { o.env.K_SERVICE = "aoa"; }],
    ["extra task", (o: Json) => { o.env.CLOUD_RUN_TASK_COUNT = "2"; }],
    ["second task index", (o: Json) => { o.env.CLOUD_RUN_TASK_INDEX = "1"; }],
    ["retried process", (o: Json) => { o.env.CLOUD_RUN_TASK_ATTEMPT = "1"; }],
    ["other job", (o: Json) => { o.env.CLOUD_RUN_JOB = "aoa-migrate"; }],
    ["execution path injection", (o: Json) => { o.env.CLOUD_RUN_EXECUTION += "/../other"; }],
    ["launch mode differs", (o: Json) => { o.env.AOA_IMPORT_MODE = "apply"; }],
    ["launch batch differs", (o: Json) => { o.env.AOA_IMPORT_MANIFEST_OBJECT = o.env.AOA_IMPORT_MANIFEST_OBJECT.replace(B, "c".repeat(32)); }],
    ["missing independent job", (o: Json) => { o.job = null; }],
    ["missing independent execution", (o: Json) => { o.execution = null; }],
    ["different effective job reference", (o: Json) => { o.execution.job += "-other"; }],
    ["completed execution replay", (o: Json) => { o.execution.completionTime = "2026-09-15T12:00:00.000Z"; }],
    ["deleted job", (o: Json) => { o.job.deleteTime = "2026-09-15T12:00:00.000Z"; }],
    ["reconciling job", (o: Json) => { o.job.reconciling = true; }],
    ["retried execution", (o: Json) => { o.execution.retriedCount = 1; }],
    ["parallel execution", (o: Json) => { o.execution.parallelism = 2; }],
  ] as const)("rejects %s", (_label, mutate) => {
    const manifest = manifestFixture();
    const observed = clone(runtimeFixture(manifest)) as Json;
    mutate(observed);
    expect(() => verifyLegacyImportJobRuntime("prod", manifest, observed as LegacyImportJobObservation)).toThrow();
  });

  for (const surface of ["job", "execution"] as const) {
    it.each([
      ["arbitrary command", (t: Json) => { t.containers[0].command = ["bash", "-c"]; }],
      ["arbitrary args", (t: Json) => { t.containers[0].args = ["--skip-checks"]; }],
      ["different image", (t: Json) => { t.containers[0].image = "example.invalid/unsafe:latest"; }],
      ["extra sidecar", (t: Json) => { t.containers.push(clone(t.containers[0])); }],
      ["extra environment", (t: Json) => { t.containers[0].env.push({ name: "NODE_OPTIONS", value: "--import=/tmp/unsafe.js" }); }],
      ["duplicate environment", (t: Json) => { t.containers[0].env.push(clone(t.containers[0].env[0])); }],
      ["plaintext DB secret", (t: Json) => { t.containers[0].env[6] = { name: "DIRECT_DATABASE_URL", value: "PRIVATE-DB-SECRET" }; }],
      ["different secret", (t: Json) => { t.containers[0].env[6].valueSource.secretKeyRef.secret = "direct-database-url"; }],
      ["unversioned secret", (t: Json) => { t.containers[0].env[6].valueSource.secretKeyRef.version = "latest"; }],
      ["mode override", (t: Json) => { t.containers[0].env.find((e: Json) => e.name === "AOA_IMPORT_MODE").value = "apply"; }],
      ["source override", (t: Json) => { t.containers[0].env.find((e: Json) => e.name === "AOA_IMPORT_MANIFEST_GENERATION").value = "2"; }],
      ["shared SA", (t: Json) => { t.serviceAccount = "Gtyiwf9bRptzzwuy-account@example-project.iam.gserviceaccount.com"; }],
      ["automatic retries", (t: Json) => { t.maxRetries = 1; }],
      ["excess timeout", (t: Json) => { t.timeout = "3600s"; }],
      ["secret volume", (t: Json) => { t.volumes = [{ name: "unapproved" }]; }],
      ["volume mount", (t: Json) => { t.containers[0].volumeMounts = [{ name: "unapproved", mountPath: "/data" }]; }],
      ["other VPC", (t: Json) => { t.vpcAccess.networkInterfaces[0].network = "other-vpc"; }],
      ["other subnet", (t: Json) => { t.vpcAccess.networkInterfaces[0].subnetwork = "other-subnet"; }],
      ["second NIC", (t: Json) => { t.vpcAccess.networkInterfaces.push(clone(t.vpcAccess.networkInterfaces[0])); }],
      ["unapproved network tags", (t: Json) => { t.vpcAccess.networkInterfaces[0].tags = ["unsafe"]; }],
      ["connector alternative", (t: Json) => { t.vpcAccess.connector = "unapproved-connector"; }],
      ["different egress", (t: Json) => { t.vpcAccess.egress = "ALL_TRAFFIC"; }],
    ] as const)(`rejects ${surface} %s independently`, (_label, mutate) => {
      const manifest = manifestFixture();
      const observed = clone(runtimeFixture(manifest)) as Json;
      const template = surface === "job" ? observed.job.template.template : observed.execution.template;
      mutate(template);
      expect(() => verifyLegacyImportJobRuntime("prod", manifest, observed as LegacyImportJobObservation)).toThrow();
    });
  }
});

describe.each(["dev", "prod"] as const)("immutable execution network snapshot: %s", (target) => {
  const fixture = () => {
    const manifest = manifestFixture(target);
    const observed = clone(runtimeFixture(manifest)) as Json;
    observed.execution.job = getLegacyImportJobConfig(target).jobName;
    delete observed.execution.template.vpcAccess;
    return { manifest, observed };
  };
  const verify = (manifest: LegacyImportJobManifest, observed: Json) =>
    verifyLegacyImportJobRuntime(target, manifest, observed as LegacyImportJobObservation);

  it("accepts the live short-parent/omitted-v2-network response with exact immutable v1 proof", () => {
    const { manifest, observed } = fixture();
    expect(verify(manifest, observed).executionDigest).toBe(legacyImportJobExecutionDigest(manifest));
    observed.job.generation = 2;
    expect(verify(manifest, observed).executionDigest).toBe(legacyImportJobExecutionDigest(manifest));
  });

  it.each([
    ["wrong short parent", (o: Json) => { o.execution.job += "-other"; }],
    ["other-project full parent", (o: Json) => { o.execution.job = o.job.name.replace("projects/", "projects/other-"); }],
    ["other-region full execution", (o: Json) => { o.execution.name = o.execution.name.replace("us-central1", "us-east1"); }],
    ["other execution", (o: Json) => { o.execution.name += "other"; }],
    ["missing v1 proof", (o: Json) => { delete o.executionV1; }],
    ["wrong API", (o: Json) => { o.executionV1.apiVersion = "run.googleapis.com/v2"; }],
    ["job substituted for execution", (o: Json) => { o.executionV1.kind = "Job"; }],
    ["wrong v1 name", (o: Json) => { o.executionV1.metadata.name += "other"; }],
    ["wrong namespace", (o: Json) => { o.executionV1.metadata.namespace = "123"; }],
    ["missing v2 UID", (o: Json) => { delete o.execution.uid; }],
    ["wrong v1 UID", (o: Json) => { o.executionV1.metadata.uid = "other"; }],
    ["deleted snapshot", (o: Json) => { o.executionV1.metadata.deletionTimestamp = "2026-09-16T12:00:00Z"; }],
    ["wrong location", (o: Json) => { o.executionV1.metadata.labels["cloud.googleapis.com/location"] = "us-east1"; }],
    ["wrong job label", (o: Json) => { o.executionV1.metadata.labels["run.googleapis.com/job"] = "other"; }],
    ["recreated job UID", (o: Json) => { o.job.uid = "new-job-uid"; }],
    ["changed job generation", (o: Json) => { o.job.generation = "3"; }],
    ["noncanonical generation", (o: Json) => { o.job.generation = "02"; }],
    ["missing annotations", (o: Json) => { delete o.executionV1.metadata.annotations; }],
    ["wrong egress", (o: Json) => { o.executionV1.metadata.annotations["run.googleapis.com/vpc-access-egress"] = "all-traffic"; }],
    ["connector alternative", (o: Json) => { o.executionV1.metadata.annotations["run.googleapis.com/vpc-access-connector"] = "other"; }],
    ["missing interfaces", (o: Json) => { delete o.executionV1.metadata.annotations["run.googleapis.com/network-interfaces"]; }],
    ["malformed interfaces", (o: Json) => { o.executionV1.metadata.annotations["run.googleapis.com/network-interfaces"] = "{"; }],
    ["empty interfaces", (o: Json) => { o.executionV1.metadata.annotations["run.googleapis.com/network-interfaces"] = "[]"; }],
    ["wrong VPC", (o: Json) => { const key = "run.googleapis.com/network-interfaces"; const n = JSON.parse(o.executionV1.metadata.annotations[key]); n[0].network = "other"; o.executionV1.metadata.annotations[key] = JSON.stringify(n); }],
    ["wrong subnet", (o: Json) => { const key = "run.googleapis.com/network-interfaces"; const n = JSON.parse(o.executionV1.metadata.annotations[key]); n[0].subnetwork = "other"; o.executionV1.metadata.annotations[key] = JSON.stringify(n); }],
    ["extra NIC", (o: Json) => { const key = "run.googleapis.com/network-interfaces"; const n = JSON.parse(o.executionV1.metadata.annotations[key]); n.push(n[0]); o.executionV1.metadata.annotations[key] = JSON.stringify(n); }],
    ["tag string", (o: Json) => { const key = "run.googleapis.com/network-interfaces"; const n = JSON.parse(o.executionV1.metadata.annotations[key]); n[0].tags = "unapproved"; o.executionV1.metadata.annotations[key] = JSON.stringify(n); }],
    ["tag array", (o: Json) => { const key = "run.googleapis.com/network-interfaces"; const n = JSON.parse(o.executionV1.metadata.annotations[key]); n[0].tags = ["unapproved"]; o.executionV1.metadata.annotations[key] = JSON.stringify(n); }],
    ["missing current job VPC", (o: Json) => { delete o.job.template.template.vpcAccess; }],
    ["null execution VPC", (o: Json) => { o.execution.template.vpcAccess = null; }],
    ["present conflicting execution VPC", (o: Json) => { o.execution.template.vpcAccess = clone(o.job.template.template.vpcAccess); o.execution.template.vpcAccess.egress = "ALL_TRAFFIC"; }],
  ] as const)("rejects %s without treating absent v2 networking as permission", (_label, mutate) => {
    const { manifest, observed } = fixture();
    mutate(observed);
    expect(() => verify(manifest, observed)).toThrow();
  });
});

describe("private import security: approval and object integrity", () => {
  it("keeps execution binding stable between reviewed dry run and apply", () => {
    const dryRun = manifestFixture();
    const apply = { ...clone(dryRun), mode: "apply" as const, expiresAt: "2026-09-15T14:00:00.000Z", approval: {
      object: `approved/${B}/approval.json`, generation: "761704106", sha256: "c".repeat(64), digest: "d".repeat(64),
    } };
    expect(parseLegacyImportJobManifest(JSON.stringify(apply), "prod", NOW)).toEqual(apply);
    expect(legacyImportJobExecutionDigest(apply)).toBe(legacyImportJobExecutionDigest(dryRun));
    expect(verifyLegacyImportJobRuntime("prod", apply, runtimeFixture(apply)).executionDigest).toBe(legacyImportJobExecutionDigest(dryRun));
  });

  it.each([
    ["image", (m: Json) => { m.image = m.image.replace(H, "c".repeat(64)); }],
    ["secret version", (m: Json) => { m.secretVersion = "5"; }],
    ["source generation", (m: Json) => { m.sources.mapping.generation = "761704106"; }],
    ["source bytes", (m: Json) => { m.sources.feeCredits.sha256 = "c".repeat(64); }],
    ["batch", (m: Json) => { m.batchId = "c".repeat(32); }],
  ] as const)("binds %s into the approval execution digest", (_label, mutate) => {
    const base = manifestFixture();
    const altered = clone(base) as Json;
    mutate(altered);
    expect(legacyImportJobExecutionDigest(altered as LegacyImportJobManifest)).not.toBe(legacyImportJobExecutionDigest(base));
  });

  it("checks downloaded raw bytes and the size limit before use", () => {
    const bytes = Buffer.from("synthetic-data");
    const reference = { object: `inputs/${B}/mapping.csv`, generation: "1", sha256: hash(bytes.toString()) };
    expect(verifyLegacyImportJobObject(bytes, reference, bytes.length)).toBeUndefined();
    expect(() => verifyLegacyImportJobObject(bytes, reference, bytes.length - 1)).toThrow();
    expect(() => verifyLegacyImportJobObject(Buffer.from("synthetic-datb"), reference, bytes.length)).toThrow();
    expect(() => verifyLegacyImportJobObject(bytes, { ...reference, sha256: "c".repeat(64) }, bytes.length)).toThrow();
  });
});

describe("private import security: real transport adapter with synthetic HTTP only", () => {
  const token = "synthetic-bearer-token-never-log-123456789";
  const metadataToken = () => new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 3600 }), {
    headers: { "Metadata-Flavor": "Google" },
  });

  it.each([
    "http://storage.googleapis.com/private", "https://example.invalid/private",
    "https://storage.googleapis.com.attacker.invalid/private", "http://169.254.169.254/private",
    "https://private:password@storage.googleapis.com/private", "https://storage.googleapis.com/private#fragment",
    "https://us-east1-run.googleapis.com/private", "https://us-central1-run.googleapis.com.attacker.invalid/private",
  ])("refuses nonallowlisted or ambiguous transport target %s before fetch", async (input) => {
    let called = false;
    const fetcher: typeof fetch = async () => { called = true; throw new Error("must not call"); };
    await expect(boundedLegacyJobRequest(fetcher, new URL(input), {}, 1024)).rejects.toThrow("job_http_target_invalid");
    expect(called).toBe(false);
  });

  it("never forwards redirects and never reveals a raw fetch error", async () => {
    const fetcher: typeof fetch = async (_input, options) => {
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      throw new Error(`PRIVATE-ACCOUNT ${token} https://private:password@example.invalid`);
    };
    try {
      await boundedLegacyJobRequest(fetcher, new URL("https://storage.googleapis.com/storage/v1/b/synthetic"), {}, 1024);
      expect.fail("must reject");
    } catch (error) {
      expect(safeLegacyImportJobRuntimeError(error)).toBe("job_http_failed");
      expect(String(error)).not.toMatch(/PRIVATE-ACCOUNT|password|synthetic-bearer/);
    }
  });

  it.each([
    ["non-200 response", () => new Response("PRIVATE-ACCOUNT", { status: 403 })],
    ["missing body", () => new Response(null)],
    ["lying oversized length", () => new Response("small", { headers: { "content-length": "99999" } })],
    ["malformed length", () => new Response("small", { headers: { "content-length": "1e6" } })],
    ["oversized streamed body", () => new Response("x".repeat(65))],
  ] as const)("rejects %s with no sensitive remote body in error", async (_label, response) => {
    const fetcher: typeof fetch = async () => response();
    await expect(boundedLegacyJobRequest(fetcher, new URL("https://storage.googleapis.com/storage/v1/b/synthetic"), {}, 64)).rejects.not.toThrow("PRIVATE-ACCOUNT");
  });

  it("requires Google's metadata response flavor instead of trusting any HTTP body", async () => {
    const fetcher: typeof fetch = async () => new Response("forged-identity");
    await expect(boundedLegacyJobRequest(fetcher, new URL("http://metadata.google.internal/computeMetadata/v1/project/project-id"), {}, 1024)).rejects.toThrow("job_identity_invalid");
  });

  it("puts the exact generation on both object metadata and media requests", async () => {
    const content = "synthetic,csv\n";
    const pin = { bucket: "ops-portal-ops-import", name: `inputs/${B}/mapping.csv`, generation: "1234567890123456789", sha256: hash(content) };
    const calls: URL[] = [];
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(String(input)); calls.push(url);
      if (url.hostname === "metadata.google.internal") return metadataToken();
      expect(options?.headers).toEqual({ Authorization: `Bearer ${token}` });
      expect(url.searchParams.get("generation")).toBe(pin.generation);
      expect(url.pathname).toBe(`/storage/v1/b/${pin.bucket}/o/${encodeURIComponent(pin.name)}`);
      if (url.searchParams.get("alt") === "media") return new Response(content);
      return new Response(JSON.stringify({ bucket: pin.bucket, name: pin.name, generation: pin.generation, size: String(Buffer.byteLength(content)) }));
    };
    expect(Buffer.from(await new LegacyImportJobGoogleApi(fetcher, () => NOW).readObject(pin)).toString()).toBe(content);
    expect(calls).toHaveLength(3);
  });

  it.each([
    { generation: "999" }, { size: "99999999999" }, { contentEncoding: "gzip" },
    { bucket: "other-bucket" }, { name: "other-name" },
  ])("refuses metadata drift before downloading client bytes (%j)", async (override) => {
    let mediaCalls = 0;
    const pin = { bucket: "ops-portal-ops-import", name: `inputs/${B}/mapping.csv`, generation: "123", sha256: H };
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "metadata.google.internal") return metadataToken();
      if (url.searchParams.get("alt") === "media") { mediaCalls++; return new Response("must not download"); }
      return new Response(JSON.stringify({ ...pin, size: "4", ...override }));
    };
    await expect(new LegacyImportJobGoogleApi(fetcher, () => NOW).readObject(pin)).rejects.toThrow("job_object_metadata_invalid");
    expect(mediaCalls).toBe(0);
  });

  it("uploads reports only with create-if-absent, never overwrite", async () => {
    const report = Buffer.from('{"safeCounts":0}');
    const bucket = "ops-portal-ops-import";
    const name = `reports/${B}/${H}.approval.json`;
    let uploads = 0;
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(String(input));
      if (url.hostname === "metadata.google.internal") return metadataToken();
      uploads++;
      expect(options?.method).toBe("POST");
      expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
      expect(url.searchParams.get("name")).toBe(name);
      expect(url.searchParams.get("uploadType")).toBe("media");
      return new Response(JSON.stringify({ bucket, name, generation: "123", size: String(report.length) }));
    };
    expect(await new LegacyImportJobGoogleApi(fetcher, () => NOW).createReport(bucket, name, report)).toEqual({ generation: "123", sha256: hash(report.toString()) });
    expect(uploads).toBe(1);
  });

  it("does not retry an existing report conflict or disclose the server body", async () => {
    let uploads = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "metadata.google.internal") return metadataToken();
      uploads++;
      return new Response("PRIVATE-ACCOUNT server body", { status: 412 });
    };
    await expect(new LegacyImportJobGoogleApi(fetcher, () => NOW).createReport("ops-portal-ops-import", `reports/${B}/${H}.approval.json`, Buffer.from("{}"))).rejects.toThrow("job_http_failed");
    expect(uploads).toBe(1);
  });
});
