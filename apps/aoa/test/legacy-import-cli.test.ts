import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Exercise the executable CLI, not a source-text assertion. Each child gets a
// synthetic environment and a preload that refuses both gcloud subprocess
// calls and construction of a Prisma client. A guard regression cannot reach
// live credentials, a real gcloud process, or any database.
const repository = process.cwd();
const cli = path.join(repository, "scripts/import-legacy-operations.ts");
const PASSWORD = "SyntheticPassword_DO_NOT_PRINT_123";
const PAYLOAD = "Private Synthetic Contact,PRIVATE-ACCOUNT,Private free-text reason";
const DATABASE_URL = `postgresql://aoa_admin:${PASSWORD}@10.42.0.7:5432/aoa?schema=app&sslmode=require`;
let directory: string;
let sourceFile: string;
let approvalFile: string;
let guardFile: string;
let markerFile: string;

beforeAll(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "aoa-cli-negative-test-"));
  chmodSync(directory, 0o700);
  sourceFile = path.join(directory, "private-source-payload.csv");
  approvalFile = path.join(directory, "private-approval-report.json");
  guardFile = path.join(directory, "external-access-guard.cjs");
  markerFile = path.join(directory, "unexpected-external-attempt.txt");
  writeFileSync(sourceFile, PAYLOAD, { mode: 0o600 });
  writeFileSync(approvalFile, "{}", { mode: 0o600 });
  writeFileSync(guardFile, `
const fs = require("node:fs");
const childProcess = require("node:child_process");
const blocked = (kind) => {
  fs.writeFileSync(${JSON.stringify(markerFile)}, kind, { mode: 0o600 });
  throw new Error("test_external_access_blocked");
};
for (const method of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
  const original = childProcess[method];
  childProcess[method] = (...args) => {
    if (typeof args[0] === "string" && /(?:^|[/\\\\])gcloud(?:\\s|$)/.test(args[0])) blocked("cloud_or_subprocess");
    return original.apply(childProcess, args);
  };
}
const net = require("node:net");
const localTsxPipe = require("node:path").join(require("node:os").tmpdir(), "tsx-" + process.geteuid(), process.ppid + ".pipe");
for (const method of ["connect", "createConnection"]) {
  const original = net[method];
  net[method] = (...args) => {
    // tsx probes its parent IPC socket during module initialization. The child
    // has a private TMPDIR; permit only that exact Unix socket, never TCP.
    if (args[0] !== localTsxPipe) blocked("network");
    return original.apply(net, args);
  };
}
require("node:tls").connect = () => blocked("network");
require("node:module").syncBuiltinESMExports();
const prisma = require(${JSON.stringify(path.join(repository, "node_modules/@prisma/client/default.js"))});
prisma.PrismaClient = class { constructor() { blocked("database"); } };
`, { mode: 0o600 });
});

beforeEach(() => {
  if (existsSync(markerFile)) rmSync(markerFile);
  chmodSync(approvalFile, 0o600);
});

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function run(args: string[], overrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = {
    PATH: directory,
    NODE_ENV: "test",
    TZ: "UTC",
    NO_COLOR: "1",
    TSX_DISABLE_CACHE: "1",
    TMPDIR: directory,
    DIRECT_DATABASE_URL: DATABASE_URL,
    ...overrides,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return spawnSync(process.execPath, ["--require", guardFile, "--import", "tsx", cli, ...args], {
    cwd: repository, env, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024,
  });
}

function rejected(args: string[], code: string, overrides: Record<string, string | undefined> = {}) {
  const result = run(args, overrides);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`ERROR: ${code}`);
  for (const secret of [PASSWORD, PAYLOAD, DATABASE_URL, directory, sourceFile, approvalFile, repository, "PRIVATE-ACCOUNT"]) {
    expect(result.stdout + result.stderr).not.toContain(secret);
  }
  expect(existsSync(markerFile) ? readFileSync(markerFile, "utf8") : null).toBeNull();
}

const base = () => ["--target", "prod", "--fee-credits", sourceFile];
const apply = () => [...base(), "--apply", "--confirm", "APPLY_FEE_STORE_LEGACY_TO_PROD"];

describe("Executable legacy import CLI guard ordering and private errors", () => {
  it("does not inherit production credentials and demonstrably blocks the cloud and database seams", () => {
    for (const [code, expected] of [
      ['import { execFileSync } from "node:child_process"; execFileSync("gcloud", ["version"]);', "cloud_or_subprocess"],
      ['import { createConnection } from "node:net"; createConnection(5432, "10.42.0.7");', "network"],
      [`import { PrismaClient } from ${JSON.stringify(path.join(repository, "node_modules/@prisma/client/default.js"))}; new PrismaClient();`, "database"],
    ]) {
      if (existsSync(markerFile)) rmSync(markerFile);
      const child = spawnSync(process.execPath, ["--require", guardFile, "--input-type=module", "--eval", code], {
        cwd: repository, env: { PATH: directory, NODE_ENV: "test" }, encoding: "utf8", timeout: 10_000,
      });
      expect(child.status).toBe(1);
      expect(existsSync(markerFile)).toBe(true);
      expect(readFileSync(markerFile, "utf8")).toBe(expected);
    }
  }, 15_000);

  it("requires an explicit target before consulting any connection", () => {
    rejected(["--fee-credits", sourceFile], "target_must_be_dev_or_prod");
  }, 15_000);

  it("rejects unknown arguments without echoing their values", () => {
    rejected([...base(), "--unknown-private-flag", PAYLOAD], "unknown_argument");
  }, 15_000);

  it("requires a target-specific confirmation before apply", () => {
    rejected([...base(), "--apply"], "apply_confirmation_missing");
  }, 15_000);

  it("requires the separate apply environment gate", () => {
    rejected(apply(), "apply_environment_gate_missing");
  }, 15_000);

  it("requires the saved approval report", () => {
    rejected(apply(), "apply_approval_report_required", { AOA_ALLOW_LEGACY_OPERATIONS_PROD_APPLY: "1" });
  }, 15_000);

  it("requires the exact approved digest", () => {
    rejected([...apply(), "--approval-report", approvalFile], "apply_approval_digest_invalid", { AOA_ALLOW_LEGACY_OPERATIONS_PROD_APPLY: "1" });
  }, 15_000);

  it("rejects a missing database connection before file reads or external calls", () => {
    rejected(base(), "direct_database_url_required", { DIRECT_DATABASE_URL: undefined });
  }, 15_000);

  it("rejects a non-owner database URL without exposing its password", () => {
    rejected(base(), "connection_identity_mismatch", { DIRECT_DATABASE_URL: DATABASE_URL.replace("aoa_admin:", "app_rw:") });
  }, 15_000);

  it("rejects the wrong database before opening any file", () => {
    rejected(base(), "connection_identity_mismatch", { DIRECT_DATABASE_URL: DATABASE_URL.replace("/aoa?", "/wrong_database?") });
  }, 15_000);

  it("rejects plaintext database transport before any external access", () => {
    rejected(base(), "connection_options_unsafe", { DIRECT_DATABASE_URL: DATABASE_URL.replace("sslmode=require", "sslmode=disable") });
  }, 15_000);

  it("rejects a query-string host override before any external access", () => {
    rejected(base(), "connection_options_unsafe", { DIRECT_DATABASE_URL: `${DATABASE_URL}&host=10.42.0.8` });
  }, 15_000);

  it("refuses input within the repository", () => {
    rejected(["--target", "prod", "--fee-credits", path.join(repository, "package.json")], "input_must_be_outside_repository");
  }, 15_000);

  it("treats a dot-dot-prefixed child directory as inside the repository", () => {
    const prefix = "..private-legacy-cli-fixture-";
    const fixtureDirectory = mkdtempSync(path.join(repository, prefix));
    try {
      chmodSync(fixtureDirectory, 0o700);
      const fixtureFile = path.join(fixtureDirectory, "synthetic.csv");
      writeFileSync(fixtureFile, PAYLOAD, { mode: 0o600 });
      rejected(["--target", "prod", "--fee-credits", fixtureFile], "input_must_be_outside_repository");
    } finally {
      // Only remove the exact unique directory created by this test, never a
      // pre-existing directory or a path inferred from an external input.
      if (path.dirname(fixtureDirectory) === repository && path.basename(fixtureDirectory).startsWith(prefix)) {
        rmSync(fixtureDirectory, { recursive: true, force: true });
      }
    }
  }, 15_000);

  it("refuses a broadly readable approval report before any cloud or database operation", () => {
    chmodSync(approvalFile, 0o644);
    rejected([...apply(), "--approval-report", approvalFile, "--approve-digest", "a".repeat(64)],
      "approval_file_permissions_unsafe", { AOA_ALLOW_LEGACY_OPERATIONS_PROD_APPLY: "1" });
  }, 15_000);

  it("does not echo private missing-file paths in system errors", () => {
    rejected(["--target", "prod", "--fee-credits", path.join(directory, "private-missing-export.csv")], "unexpected_import_failure");
  }, 15_000);

  it("rejects directory inputs with a fixed safe code", () => {
    rejected(["--target", "prod", "--fee-credits", directory], "input_file_invalid");
  }, 15_000);
});
