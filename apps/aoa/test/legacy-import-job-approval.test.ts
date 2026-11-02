import { describe, expect, it } from "vitest";
import { createLegacyImportApproval, verifyLegacyImportApproval, type LegacyImportApprovalContext } from "@/lib/operations/legacy-import-approval";
import type { LegacyImportPreview } from "@/lib/operations/legacy-import-engine";
import { LEGACY_FEE_SOURCE, LEGACY_BILLING_SOURCE, LEGACY_RECON_SOURCE } from "@/lib/operations/legacy-import";

const counts = { [LEGACY_FEE_SOURCE]: 0, [LEGACY_BILLING_SOURCE]: 0, [LEGACY_RECON_SOURCE]: 0 };
const preview: LegacyImportPreview = {
  requests: [], unresolved: [], reconciliations: [], parsed: counts, ready: counts, existing: counts, issues: [],
};
const base: LegacyImportApprovalContext = {
  target: "prod", project: "ops-portal", instance: "aoa-postgres", database: "aoa", owner: "aoa_admin",
  serverAddress: "10.42.0.7", codeDigest: "a".repeat(64), schemaDigest: "b".repeat(64),
  inputDigests: { feeCredits: "c".repeat(64), billingExceptions: null, tradeReconciliation: null, mapping: null },
};

describe("private job execution identity is bound to legacy approval", () => {
  it("roundtrips a private job report without changing workstation compatibility", () => {
    const job = createLegacyImportApproval({ ...base, executionDigest: "d".repeat(64) }, preview);
    expect(job.plan.context.executionDigest).toBe("d".repeat(64));
    expect(() => verifyLegacyImportApproval(JSON.stringify(job), job.digest, job)).not.toThrow();
    const workstation = createLegacyImportApproval(base, preview);
    expect(Object.hasOwn(workstation.plan.context, "executionDigest")).toBe(false);
    expect(() => verifyLegacyImportApproval(JSON.stringify(workstation), workstation.digest, workstation)).not.toThrow();
  });

  it("rejects old-workstation reports for cloud jobs and changed job identities", () => {
    const workstation = createLegacyImportApproval(base, preview);
    const job = createLegacyImportApproval({ ...base, executionDigest: "d".repeat(64) }, preview);
    const other = createLegacyImportApproval({ ...base, executionDigest: "e".repeat(64) }, preview);
    expect(() => verifyLegacyImportApproval(JSON.stringify(workstation), workstation.digest, job)).toThrow("approval_plan_changed");
    expect(() => verifyLegacyImportApproval(JSON.stringify(job), job.digest, workstation)).toThrow("approval_plan_changed");
    expect(() => verifyLegacyImportApproval(JSON.stringify(job), job.digest, other)).toThrow("approval_plan_changed");
  });

  it.each([undefined, null, "", "latest", "f".repeat(63), "G".repeat(64), { sensitive: "never log" }])(
    "rejects malformed explicit execution binding %j", (value) => {
      expect(() => createLegacyImportApproval({ ...base, executionDigest: value } as LegacyImportApprovalContext, preview))
        .toThrow("approval_context_invalid");
    },
  );
});
