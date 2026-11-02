import { describe, expect, it } from "vitest";
import {
  getLegacyImportTarget,
  LegacyImportTargetError,
  parseLegacyImportOptions,
  validateLegacyImportCloudMetadata,
  validateLegacyImportDatabaseIdentity,
  type LegacyImportTarget,
  type VerifiedLegacyImportCloudMetadata,
} from "@/lib/operations/legacy-import-target";

const hash = "a".repeat(64);
const source = ["--fee-credits", "/private/synthetic fee.csv"];
const dry = (target: LegacyImportTarget = "dev") => ["--target", target, ...source];
const applyArgs = (target: LegacyImportTarget = "prod") => [
  ...dry(target), "--apply", "--confirm", `APPLY_FEE_STORE_LEGACY_TO_${target.toUpperCase()}`,
  "--approval-report", "/private/synthetic-approval.json", "--approve-digest", hash,
];
const applyEnv = (target: LegacyImportTarget = "prod") => ({ [`AOA_ALLOW_LEGACY_OPERATIONS_${target.toUpperCase()}_APPLY`]: "1" });
const metadata = (target: LegacyImportTarget = "prod") => {
  const expected = getLegacyImportTarget(target);
  return { name: expected.instance, connectionName: expected.connectionName, region: expected.region, ipAddresses: [{ type: "PRIVATE", ipAddress: "10.22.33.44" }] };
};
const cloud = (target: LegacyImportTarget = "prod") => validateLegacyImportCloudMetadata(target, metadata(target));
const identity = () => ({ name: "aoa", server_address: "10.22.33.44", current_user: "aoa_admin", session_user: "aoa_admin", rolsuper: false, rolbypassrls: false });

function expectCode(fn: () => unknown, code: string) {
  expect(fn).toThrowError(expect.objectContaining({ name: "LegacyImportTargetError", message: code, code }));
}

describe("strict legacy import command line", () => {
  it.each(["dev", "prod"] as const)("defaults explicit %s target to dry run and preserves path spelling", (target) => {
    expect(parseLegacyImportOptions(dry(target), {})).toEqual({
      target, apply: false, feeCredits: "/private/synthetic fee.csv", billingExceptions: null,
      tradeReconciliation: null, mapping: null, reportOut: null, reviewOut: null,
      approvalReport: null, approveDigest: null,
    });
  });

  it("accepts every documented source/output flag without rewriting path values", () => {
    const options = parseLegacyImportOptions([
      "--dry-run", "--target", "prod", ...source,
      "--billing-exceptions", "relative billing.csv", "--trade-reconciliation", "../synthetic runs.csv",
      "--mapping", " mapping.csv ", "--report-out", "/private/report.json", "--review-out", "/private/review.csv",
    ], {});
    expect(options).toMatchObject({ apply: false, billingExceptions: "relative billing.csv", tradeReconciliation: "../synthetic runs.csv", mapping: " mapping.csv ", reportOut: "/private/report.json", reviewOut: "/private/review.csv" });
    expect(Object.isFrozen(options)).toBe(true);
  });

  it.each(["--fee-credits", "--billing-exceptions", "--trade-reconciliation"])("accepts %s as the only source", (flag) => {
    expect(parseLegacyImportOptions(["--target", "dev", flag, "/private/source.csv"], {}).apply).toBe(false);
  });

  it.each([
    [], source, ["--target", " dev", ...source], ["--target", "prod ", ...source],
    ["--target", "production", ...source], ["--target", "main", ...source], ["--target", "DEV", ...source],
  ].map((args) => [args]))("rejects missing, aliased, or whitespace targets (%j)", (args) => {
    expectCode(() => parseLegacyImportOptions(args, {}), "target_must_be_dev_or_prod");
  });

  it.each([["--target", "dev"], ["--target", "prod", "--mapping", "/private/map.csv"]].map((args) => [args]))("requires a real source rather than just a mapping (%j)", (args) => {
    expectCode(() => parseLegacyImportOptions(args, {}), "at_least_one_source_file_is_required");
  });

  it.each(["--unknown", "--help", "--target=prod", "orphan.csv", "--prod", "--skip-validation"])("rejects unknown argument %s", (flag) => {
    expectCode(() => parseLegacyImportOptions([...dry(), flag], {}), "unknown_argument");
  });

  it.each([
    ["--target", "dev"], ["--fee-credits", "/private/another.csv"], ["--dry-run", "--dry-run"],
    ["--apply", "--apply"], ["--mapping", "a.csv", "--mapping", "b.csv"],
    ["--confirm", "one", "--confirm", "two"], ["--approve-digest", hash, "--approve-digest", hash],
  ].map((args) => [args]))("rejects duplicate flags even when values agree (%j)", (args) => {
    expectCode(() => parseLegacyImportOptions([...dry(), ...args], {}), "duplicate_argument");
  });

  it.each([[], [""], ["   "], ["--apply"], ["-other"]].map((args) => [args]))("rejects a missing flag value (%j)", (value) => {
    expectCode(() => parseLegacyImportOptions([...dry(), "--mapping", ...value], {}), "argument_value_missing");
  });

  it.each(["a\n.csv", "a\r.csv", "a\0.csv", "a\t.csv", "a\x7f.csv", "x".repeat(4_097)])("rejects unsafe or excessive argument values (case %#)", (value) => {
    expectCode(() => parseLegacyImportOptions([...dry(), "--mapping", value], {}), "argument_value_invalid");
  });

  it("bounds the argv count", () => {
    expectCode(() => parseLegacyImportOptions(Array(65).fill("--dry-run"), {}), "invalid_arguments");
  });

  it("rejects --apply together with --dry-run", () => {
    expectCode(() => parseLegacyImportOptions([...applyArgs(), "--dry-run"], applyEnv()), "dry_run_and_apply_are_mutually_exclusive");
  });

  it.each(["--report-out", "--review-out"])("rejects dry-run output %s during apply", (flag) => {
    expectCode(() => parseLegacyImportOptions([...applyArgs(), flag, "/private/output.json"], applyEnv()), "report_outputs_require_dry_run");
  });

  it.each([
    ["--confirm", "APPLY_FEE_STORE_LEGACY_TO_DEV"], ["--approval-report", "/private/review.json"], ["--approve-digest", hash],
  ].map((args) => [args]))("never accepts apply approval arguments on a dry run (%j)", (extra) => {
    expectCode(() => parseLegacyImportOptions([...dry(), ...extra], applyEnv("dev")), "apply_approval_arguments_require_apply");
  });

  it.each(["dev", "prod"] as const)("requires all apply gates for %s and does not read process.env", (target) => {
    const options = parseLegacyImportOptions(applyArgs(target), applyEnv(target));
    expect(options).toMatchObject({ target, apply: true, approvalReport: "/private/synthetic-approval.json", approveDigest: hash });
    expectCode(() => parseLegacyImportOptions(applyArgs(target), {}), "apply_environment_gate_missing");
    const opposite = target === "prod" ? "dev" : "prod";
    expectCode(() => parseLegacyImportOptions(applyArgs(target), applyEnv(opposite)), "apply_environment_gate_missing");
  });

  it.each(["dev", "prod"] as const)("rejects the other target's confirmation for %s", (target) => {
    const args = applyArgs(target);
    args[args.indexOf("--confirm") + 1] = `APPLY_FEE_STORE_LEGACY_TO_${target === "prod" ? "DEV" : "PROD"}`;
    expectCode(() => parseLegacyImportOptions(args, applyEnv(target)), "apply_confirmation_missing");
  });

  it.each([undefined, "true", " 1", "1 ", "0"])("requires the exact environment opt-in value (%s)", (value) => {
    expectCode(() => parseLegacyImportOptions(applyArgs(), { AOA_ALLOW_LEGACY_OPERATIONS_PROD_APPLY: value }), "apply_environment_gate_missing");
  });

  it.each([
    { NODE_ENV: "production" }, { K_SERVICE: "synthetic-service" }, { CLOUD_RUN_SERVICE: "synthetic-service" },
  ])("forbids server-side apply even with every approval gate (%j)", (env) => {
    expectCode(() => parseLegacyImportOptions(applyArgs(), { ...applyEnv(), ...env }), "apply_must_run_from_an_operator_workstation");
    expect(parseLegacyImportOptions(dry("prod"), env).apply).toBe(false);
  });

  it("requires an approval report and digest on apply", () => {
    const args = applyArgs();
    args.splice(args.indexOf("--approval-report"), 2);
    expectCode(() => parseLegacyImportOptions(args, applyEnv()), "apply_approval_report_required");
    const noDigest = applyArgs();
    noDigest.splice(noDigest.indexOf("--approve-digest"), 2);
    expectCode(() => parseLegacyImportOptions(noDigest, applyEnv()), "apply_approval_digest_invalid");
  });

  it.each(["a".repeat(63), "a".repeat(65), "g".repeat(64), "z".repeat(64)])("rejects non-SHA256 approval digest (case %#)", (value) => {
    const args = applyArgs();
    args[args.indexOf("--approve-digest") + 1] = value;
    expectCode(() => parseLegacyImportOptions(args, applyEnv()), "apply_approval_digest_invalid");
  });

  it("normalizes an uppercase valid SHA256 digest only", () => {
    const args = applyArgs();
    args[args.indexOf("--approve-digest") + 1] = "AB".repeat(32);
    expect(parseLegacyImportOptions(args, applyEnv()).approveDigest).toBe("ab".repeat(32));
  });

  it("never embeds supplied argument values in errors", () => {
    let caught: unknown;
    try { parseLegacyImportOptions([...dry(), "--sensitive-client-name"], {}); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(LegacyImportTargetError);
    expect((caught as Error).message).toBe("unknown_argument");
    expect(JSON.stringify(caught)).not.toContain("sensitive-client-name");
  });
});

describe("fixed Cloud SQL target identity", () => {
  it.each(["dev", "prod"] as const)("returns an immutable exact %s target", (target) => {
    const value = getLegacyImportTarget(target);
    expect(value).toEqual({ target, project: target === "dev" ? "ops-portal-dev" : "ops-portal", instance: target === "dev" ? "aoa-dev-postgres" : "aoa-postgres", database: "aoa", owner: "aoa_admin", region: "us-central1", connectionName: `${target === "dev" ? "ops-portal-dev" : "ops-portal"}:us-central1:${target === "dev" ? "aoa-dev-postgres" : "aoa-postgres"}` });
    expect(Object.isFrozen(value)).toBe(true);
    expect(cloud(target)).toEqual({ ...value, privateAddress: "10.22.33.44" });
  });

  it.each(["production", "DEV", "__proto__", "toString"])("rejects unknown runtime target %s", (target) => {
    expectCode(() => getLegacyImportTarget(target as LegacyImportTarget), "target_must_be_dev_or_prod");
  });

  it("accepts independently matching project identity when connectionName is absent", () => {
    const data: Record<string, unknown> = { ...metadata(), project: "ops-portal" };
    delete data.connectionName;
    expect(validateLegacyImportCloudMetadata("prod", data)).toEqual(cloud());
  });

  it.each([null, undefined, [], "metadata"])("rejects a non-object or multi-instance metadata result (%j)", (value) => {
    expectCode(() => validateLegacyImportCloudMetadata("prod", value), "cloud_metadata_invalid");
  });

  it.each([
    { name: "aoa-dev-postgres" }, { region: "us-east1" }, { connectionName: "ops-portal-dev:us-central1:aoa-postgres" },
    { project: "ops-portal-dev" }, { project: null }, { connectionName: null }, { name: "aoa-postgres\n" },
  ])("rejects wrong or contradictory cloud identities (%j)", (override) => {
    expectCode(() => validateLegacyImportCloudMetadata("prod", { ...metadata(), ...override }), "cloud_target_mismatch");
  });

  it("requires an actual project identity, not only matching instance name", () => {
    const data: Record<string, unknown> = { ...metadata() };
    delete data.connectionName;
    expectCode(() => validateLegacyImportCloudMetadata("prod", data), "cloud_project_unverified");
  });

  it.each([undefined, null, {}, [null], [{ ipAddress: "10.22.33.44" }], [{ type: "PRIVATE" }], Array(17).fill({ type: "PRIVATE", ipAddress: "10.1.2.3" })])("rejects malformed/big address metadata (case %#)", (ipAddresses) => {
    expectCode(() => validateLegacyImportCloudMetadata("prod", { ...metadata(), ipAddresses }), "cloud_addresses_invalid");
  });

  it.each([[], [{ type: "PRIVATE", ipAddress: "10.22.33.44" }, { type: "PRIVATE", ipAddress: "10.22.33.45" }], [{ type: "PRIVATE", ipAddress: "10.22.33.44" }, { type: "PRIVATE", ipAddress: "10.22.33.44" }]].map((entries) => [entries]))("rejects missing or ambiguous PRIVATE addresses (%j)", (ipAddresses) => {
    expectCode(() => validateLegacyImportCloudMetadata("prod", { ...metadata(), ipAddresses }), "cloud_private_address_ambiguous");
  });

  it.each(["10.22.33.44", "172.16.0.1", "172.31.255.254", "192.168.1.2"])("accepts canonical RFC1918 IPv4 %s", (ipAddress) => {
    expect(validateLegacyImportCloudMetadata("prod", { ...metadata(), ipAddresses: [{ type: "PRIVATE", ipAddress }] }).privateAddress).toBe(ipAddress);
  });

  it.each(["127.0.0.1", "169.254.169.254", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "10.01.2.3", "10.2.3.256", "10.2.3", "10.2.3.4\n", "10.2.3.4/32", "::1", "::ffff:10.2.3.4", "2130706433"])("never accepts non-private/noncanonical endpoint %s", (ipAddress) => {
    expectCode(() => validateLegacyImportCloudMetadata("prod", { ...metadata(), ipAddresses: [{ type: "PRIVATE", ipAddress }] }), "cloud_private_address_invalid");
  });

  it.each([
    [{ type: "PRIMARY", ipAddress: "203.0.113.3" }],
    [{ type: "PRIMARY", ipAddress: "203.0.113.3" }, ...metadata().ipAddresses],
    [{ type: "PRIMARY", ipAddress: "10.22.33.44" }, ...metadata().ipAddresses],
  ].map((entries) => [entries]))("rejects a PRIMARY public endpoint even alongside PRIVATE (%j)", (ipAddresses) => {
    expectCode(() => validateLegacyImportCloudMetadata("prod", { ...metadata(), ipAddresses }), "cloud_public_endpoint_forbidden");
  });

  it("permits OUTGOING metadata but never selects it as the database endpoint", () => {
    const value = validateLegacyImportCloudMetadata("prod", { ...metadata(), ipAddresses: [{ type: "OUTGOING", ipAddress: "203.0.113.3" }, ...metadata().ipAddresses] });
    expect(value.privateAddress).toBe("10.22.33.44");
    expect(Object.isFrozen(value)).toBe(true);
    expectCode(() => validateLegacyImportDatabaseIdentity("prod", value, { ...identity(), server_address: "203.0.113.3" }), "database_server_mismatch");
  });

  it("rejects unknown address types", () => {
    expectCode(() => validateLegacyImportCloudMetadata("prod", { ...metadata(), ipAddresses: [{ type: "UNRECOGNIZED", ipAddress: "203.0.113.3" }, ...metadata().ipAddresses] }), "cloud_addresses_invalid");
  });
});

describe("live database identity binding", () => {
  it.each(["dev", "prod"] as const)("accepts the expected non-superuser %s owner and server", (target) => {
    expect(validateLegacyImportDatabaseIdentity(target, cloud(target), identity())).toBeUndefined();
  });

  it("rejects dev metadata on a production verification", () => {
    expectCode(() => validateLegacyImportDatabaseIdentity("prod", cloud("dev"), identity()), "cloud_target_mismatch");
  });

  it.each([{ owner: "postgres" }, { privateAddress: "127.0.0.1" }, { database: "postgres" }, { connectionName: "tampered" }, { project: "other" }])("rechecks verified cloud config at the SQL boundary (%j)", (override) => {
    expectCode(() => validateLegacyImportDatabaseIdentity("prod", { ...cloud(), ...override } as VerifiedLegacyImportCloudMetadata, identity()), "cloud_target_mismatch");
  });

  it.each([null, undefined, [], [identity()], "aoa"])("rejects absent or ambiguous SQL identity (%j)", (value) => {
    expectCode(() => validateLegacyImportDatabaseIdentity("prod", cloud(), value), "database_identity_invalid");
  });

  it.each([undefined, "postgres", "aoa_dev", "aoa\n"])("requires the exact database name (%s)", (name) => {
    expectCode(() => validateLegacyImportDatabaseIdentity("prod", cloud(), { ...identity(), name }), "database_name_mismatch");
  });

  it.each([undefined, null, "127.0.0.1", "10.22.33.45", "10.22.33.44/32", "10.22.33.44\n"])("requires the exact server endpoint (%s)", (server_address) => {
    expectCode(() => validateLegacyImportDatabaseIdentity("prod", cloud(), { ...identity(), server_address }), "database_server_mismatch");
  });

  it.each([{ current_user: "app_rw" }, { session_user: "postgres" }, { current_user: "aoa_admin\n" }, { session_user: undefined }])("rejects unsafe owner identity or SET ROLE impersonation (%j)", (override) => {
    expectCode(() => validateLegacyImportDatabaseIdentity("prod", cloud(), { ...identity(), ...override }), "database_owner_mismatch");
  });

  it.each([{ rolsuper: true }, { rolbypassrls: true }, { rolsuper: "false" }, { rolbypassrls: undefined }, { rolsuper: null }])("requires actual false superuser and bypass-RLS flags (%j)", (override) => {
    expectCode(() => validateLegacyImportDatabaseIdentity("prod", cloud(), { ...identity(), ...override }), "database_owner_privileges_unsafe");
  });
});
