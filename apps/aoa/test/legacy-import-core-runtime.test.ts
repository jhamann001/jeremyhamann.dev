import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyImportPreview } from "@/lib/operations/legacy-import-engine";
import { LEGACY_BILLING_SOURCE, LEGACY_FEE_SOURCE, LEGACY_RECON_SOURCE } from "@/lib/operations/legacy-import";
import { validateLegacyImportCloudMetadata, type LegacyImportOptions } from "@/lib/operations/legacy-import-target";

const fake = vi.hoisted(() => ({ construct: vi.fn(), disconnect: vi.fn(), preview: vi.fn(), apply: vi.fn() }));
vi.mock("@prisma/client", async (original) => ({
  ...await original<typeof import("@prisma/client")>(),
  PrismaClient: class { constructor(options: unknown) { fake.construct(options); } $disconnect = fake.disconnect; },
}));
vi.mock("@/lib/operations/legacy-import-engine", () => ({ previewLegacyImport: fake.preview, applyLegacyImport: fake.apply }));
vi.mock("@/lib/operations/legacy-import-preflight", () => ({ verifyLegacyImportDatabase: vi.fn(async () => "d".repeat(64)) }));
import { runLegacyOperationsImport, safeLegacyImportError } from "../scripts/import-legacy-operations";

const counts = { [LEGACY_FEE_SOURCE]: 0, [LEGACY_BILLING_SOURCE]: 0, [LEGACY_RECON_SOURCE]: 0 };
const preview: LegacyImportPreview = { requests: [], unresolved: [], reconciliations: [], parsed: counts, ready: counts, existing: counts, issues: [] };
const cloud = validateLegacyImportCloudMetadata("dev", {
  name: "aoa-dev-postgres", connectionName: "ops-portal-dev:us-central1:aoa-dev-postgres", region: "us-central1",
  ipAddresses: [{ type: "PRIVATE", ipAddress: "10.22.33.44" }],
});
let directory: string;
let options: LegacyImportOptions;
let directUrl: string;

beforeEach(() => {
  vi.clearAllMocks();
  // Prisma is mocked above. This throwaway value only exercises URL handling and redaction.
  const syntheticUrl = new URL("postgresql://10.22.33.44:5432/aoa?schema=app&sslmode=require");
  syntheticUrl.username = "aoa_admin";
  syntheticUrl.password = randomUUID();
  directUrl = syntheticUrl.href;
  directory = mkdtempSync(path.join(os.tmpdir(), "aoa-core-synthetic-"));
  const source = path.join(directory, "synthetic.csv");
  // The engine/parser suites test data semantics. These tests isolate CLI core
  // lifecycle, metadata ordering, approval binding and commit/disconnect state.
  writeFileSync(source, "id\n1\n", { mode: 0o600 });
  options = { target: "dev", apply: false, feeCredits: source, billingExceptions: null, tradeReconciliation: null, mapping: null,
    reportOut: null, reviewOut: null, approvalReport: null, approveDigest: null };
  fake.disconnect.mockResolvedValue(undefined);
  fake.preview.mockImplementation(async (_owner, _input, verify) => { await verify({}); return preview; });
  fake.apply.mockImplementation(async (_owner, _input, verify, approved, beforeMutation) => {
    await verify({}); await approved(preview); await beforeMutation?.();
    return { inserted: counts, existing: counts };
  });
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("callable importer core", () => {
  it("does not construct a database owner before independently verified cloud metadata", async () => {
    const fetchCloudIdentity = vi.fn(async () => { throw new Error("synthetic_cloud_rejected"); });
    await expect(runLegacyOperationsImport({ options, directUrl, fetchCloudIdentity })).rejects.toThrow("synthetic_cloud_rejected");
    expect(fake.construct).not.toHaveBeenCalled();
    expect(fake.preview).not.toHaveBeenCalled();
  });

  it("keeps its output private and always disconnects on a successful dry run", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const result = await runLegacyOperationsImport({ options, directUrl, fetchCloudIdentity: async () => cloud });
    expect(result.applied).toBeNull();
    expect(fake.construct).toHaveBeenCalledWith({ datasourceUrl: directUrl, log: [] });
    expect(fake.disconnect).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(new URL(directUrl).password);
    expect(JSON.stringify(result)).not.toContain(directUrl);
  });

  it("requires both independent verification callbacks whenever a job execution binding is supplied", async () => {
    await expect(runLegacyOperationsImport({ options, directUrl, executionDigest: "e".repeat(64), fetchCloudIdentity: async () => cloud })).rejects.toThrow("execution_verification_required");
    expect(fake.construct).not.toHaveBeenCalled();
  });

  it("forwards the last-moment execution check into the atomic engine", async () => {
    const verifyExecutionBeforeMutation = vi.fn(async () => {});
    const invocation = { options, directUrl, executionDigest: "e".repeat(64), fetchCloudIdentity: vi.fn(async () => cloud), verifyExecutionBeforeMutation };
    const dry = await runLegacyOperationsImport(invocation);
    const approvalFile = path.join(directory, "approval.json");
    writeFileSync(approvalFile, JSON.stringify(dry.approval), { mode: 0o600 });
    const result = await runLegacyOperationsImport({ ...invocation,
      options: { ...options, apply: true, approvalReport: approvalFile, approveDigest: dry.approval.digest } });
    expect(result.applied).not.toBeNull();
    expect(verifyExecutionBeforeMutation).toHaveBeenCalledOnce();
    expect(invocation.fetchCloudIdentity).toHaveBeenCalledTimes(3);
  });

  it("distinguishes a known committed import from a precommit disconnect failure", async () => {
    const invocation = { options, directUrl, fetchCloudIdentity: async () => cloud };
    const dry = await runLegacyOperationsImport(invocation);
    const approvalFile = path.join(directory, "approval.json");
    writeFileSync(approvalFile, JSON.stringify(dry.approval), { mode: 0o600 });
    fake.disconnect.mockRejectedValue(new Error(directUrl));
    await expect(runLegacyOperationsImport({ ...invocation,
      options: { ...options, apply: true, approvalReport: approvalFile, approveDigest: dry.approval.digest } })).rejects.toThrow("apply_committed_disconnect_failed");
    expect(fake.apply).toHaveBeenCalledOnce();
    expect(safeLegacyImportError(new Error("apply_committed_disconnect_failed"))).toBe("apply_committed_disconnect_failed");
    await expect(runLegacyOperationsImport(invocation)).rejects.toThrow("database_disconnect_failed");
    expect(safeLegacyImportError(new Error(directUrl))).toBe("unexpected_import_failure");
  });
});
