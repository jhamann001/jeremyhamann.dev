import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createLegacyImportApproval, verifyLegacyImportApproval, LegacyImportApprovalError,
  type LegacyImportApprovalContext,
} from "@/lib/operations/legacy-import-approval";
import type { LegacyImportCounts, LegacyImportPreview } from "@/lib/operations/legacy-import-engine";
import {
  LEGACY_FEE_SOURCE, LEGACY_BILLING_SOURCE, LEGACY_RECON_SOURCE,
  type ResolvedLegacyRequest, type LegacyParseIssue,
} from "@/lib/operations/legacy-import";

const H = (value: string) => createHash("sha256").update(value).digest("hex");
const counts = (fee = 1, billing = 0, recon = 0): LegacyImportCounts => ({
  [LEGACY_FEE_SOURCE]: fee, [LEGACY_BILLING_SOURCE]: billing, [LEGACY_RECON_SOURCE]: recon,
});

function context(target: "dev" | "prod" = "prod"): LegacyImportApprovalContext {
  return {
    target,
    project: target === "prod" ? "ops-portal" : "ops-portal-dev",
    instance: target === "prod" ? "aoa-postgres" : "aoa-dev-postgres",
    database: "aoa", owner: "aoa_admin", serverAddress: "10.42.0.7",
    codeDigest: H("code"), schemaDigest: H("schema"),
    inputDigests: { feeCredits: H("fee-csv"), billingExceptions: null, tradeReconciliation: null, mapping: H("map-csv") },
  };
}

function request(legacyId = "26"): ResolvedLegacyRequest {
  return {
    source: LEGACY_FEE_SOURCE, legacyId, sourceDigest: H(`source-${legacyId}`),
    kind: "FEE_CREDIT", status: "CREDITED", clientName: "Private Synthetic Contact",
    bridgeCedarRidgeUserId: "private-bridge-key", sourceAccountNumbers: ["PRIVATE-FULL-ACCOUNT"],
    feeTypes: ["Private fee classification"], feeAmount: "42.75", waiverStart: null,
    waiverDurationMonths: null, indefiniteDuration: false, reason: "Private free-text reason",
    relevantTicketRefs: ["PRIVATE-TICKET"], submittedByName: "Private Operator", submittedByRole: "OPERATIONS",
    submittedAt: "2026-09-01T10:00:00Z", reviewedByName: "Private Reviewer", reviewedAt: "2026-09-02T10:00:00Z",
    creditedAt: "2026-09-03", apexRequestId: "PRIVATE-APEX-ID", legacyApexRequestText: "Private legacy narrative",
    completedAt: "2026-09-03T10:00:00Z", createdAt: "2026-09-01T10:00:00Z",
    scope: "HOUSEHOLD", clientSfId: "003PRIVATECLIENT1", householdSfId: "001PRIVATEHOUSE1",
    accountIds: ["private-account-B", "private-account-A"],
  };
}

function preview(): LegacyImportPreview {
  return {
    requests: [request()], unresolved: [], reconciliations: [],
    parsed: counts(), ready: counts(), existing: counts(0), issues: [],
  };
}

function expectCode(fn: () => unknown, code: string) {
  try { fn(); throw new Error("expected rejection"); } catch (error) {
    expect(error).toBeInstanceOf(LegacyImportApprovalError);
    expect(error).toHaveProperty("code", code);
    expect(error).toHaveProperty("message", code);
  }
}

describe("PII-free legacy import approval creation", () => {
  it.each(["dev", "prod"] as const)("accepts the exact %s target and round-trips the approval", (target) => {
    const approval = createLegacyImportApproval(context(target), preview());
    expect(approval.plan.version).toBe(1);
    expect(approval.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(approval.plan.resolutionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => verifyLegacyImportApproval(JSON.stringify(approval, null, 2), approval.digest, approval)).not.toThrow();
  });

  it("includes counts and digests, never names, account IDs, amounts, reasons or ticket references", () => {
    const approval = createLegacyImportApproval(context(), preview());
    const raw = JSON.stringify(approval);
    for (const secret of ["Private", "private-", "PRIVATE-", "003PRIVATECLIENT1", "001PRIVATEHOUSE1", "42.75"]) {
      expect(raw).not.toContain(secret);
    }
    expect(approval.plan.parsed).toEqual(counts());
    expect(Object.keys(approval.plan).sort()).toEqual(["blockers", "context", "existing", "parsed", "ready", "resolutionDigest", "version"]);
  });

  it("produces the same digest for differently ordered object keys, request rows and account IDs", () => {
    const a = preview();
    a.requests.push(request("27")); a.parsed = counts(2); a.ready = counts(2);
    const b = structuredClone(a);
    b.requests.reverse(); b.requests.forEach((row) => row.accountIds.reverse());
    const c = context();
    const reversedContext = Object.fromEntries(Object.entries(c).reverse()) as LegacyImportApprovalContext;
    expect(createLegacyImportApproval(c, a)).toEqual(createLegacyImportApproval(reversedContext, b));
  });

  it("keeps same-content records with distinct source IDs represented separately", () => {
    const a = preview();
    const single = createLegacyImportApproval(context(), a);
    a.requests.push({ ...request(), legacyId: "27" });
    a.parsed = counts(2); a.ready = counts(2);
    const separate = createLegacyImportApproval(context(), a);
    expect(separate.plan.ready[LEGACY_FEE_SOURCE]).toBe(2);
    expect(separate.plan.resolutionDigest).not.toBe(single.plan.resolutionDigest);
  });

  it("sanitizes untrusted CSV diagnostic fields and nonnumeric legacy IDs", () => {
    const a = preview();
    a.issues = [
      { source: LEGACY_FEE_SOURCE, legacyId: "26", field: "mapping", code: "existing_mapping_drift" },
      { source: LEGACY_FEE_SOURCE, legacyId: "file", field: "Private Customer Name", code: "duplicate_header" },
      { source: "PRIVATE-ACCOUNT" as LegacyParseIssue["source"], legacyId: "row-9", field: "PRIVATE-TICKET", code: "Private free-text reason" },
    ];
    const approval = createLegacyImportApproval(context(), a);
    expect(approval.plan.blockers).toEqual(expect.arrayContaining([
      { source: LEGACY_FEE_SOURCE, legacyId: "26", field: "mapping", code: "existing_mapping_drift" },
      { source: LEGACY_FEE_SOURCE, legacyId: null, field: "unknown", code: "duplicate_header" },
      { source: "unknown", legacyId: null, field: "unknown", code: "unclassified_issue" },
    ]));
    expect(JSON.stringify(approval)).not.toMatch(/Private|PRIVATE|row-9/);
    expectCode(() => verifyLegacyImportApproval(JSON.stringify(approval), approval.digest, approval), "approval_blockers_present");
  });

  it.each([
    { project: "wrong-project" }, { instance: "aoa-dev-postgres" }, { owner: "postgres" }, { database: "other" },
    { serverAddress: "8.8.8.8" }, { serverAddress: "10.42.0.7\n" }, { serverAddress: "/private/client.csv" },
    { codeDigest: `${H("code")}\n` }, { schemaDigest: H("schema").toUpperCase() }, { inputPath: "/private/client.csv" },
  ])("rejects unsafe or mismatched context without reflecting values: %j", (change) => {
    expectCode(() => createLegacyImportApproval({ ...context(), ...change }, preview()), "approval_context_invalid");
  });

  it("rejects extra input-digest fields and unbound source files", () => {
    const c = context();
    Object.assign(c.inputDigests, { filePath: "/private/secret.csv" });
    expectCode(() => createLegacyImportApproval(c, preview()), "approval_context_invalid");
    const empty = context(); empty.inputDigests.feeCredits = null;
    expectCode(() => createLegacyImportApproval(empty, preview()), "approval_context_invalid");
  });

  it("rejects incoherent counts and an unresolved row without a blocker", () => {
    const a = preview(); a.existing = counts(2);
    expectCode(() => createLegacyImportApproval(context(), a), "approval_preview_invalid");
    const b = preview(); b.parsed = counts(2);
    expectCode(() => createLegacyImportApproval(context(), b), "approval_preview_invalid");
    const c = preview(); c.unresolved = [request("27")]; c.parsed = counts(2);
    expectCode(() => createLegacyImportApproval(context(), c), "approval_preview_invalid");
  });

  it.each(["requests", "reconciliations", "unresolved", "issues"] as const)("rejects malformed %s preview entries with a coded error", (key) => {
    const p = preview();
    Object.assign(p, { [key]: [null] });
    expectCode(() => createLegacyImportApproval(context(), p), "approval_preview_invalid");
  });
});

describe("Exact legacy import approval verification", () => {
  it.each(["", "null", "[]", "{", '"text"']) ("rejects malformed/non-object reports: %j", (raw) => {
    const approval = createLegacyImportApproval(context(), preview());
    expectCode(() => verifyLegacyImportApproval(raw, approval.digest, approval), "approval_report_invalid");
  });

  it("limits raw UTF-8 bytes before parsing, not just JavaScript string length", () => {
    const a = createLegacyImportApproval(context(), preview());
    expectCode(() => verifyLegacyImportApproval(" ".repeat(1_048_577), a.digest, a), "approval_report_too_large");
    expectCode(() => verifyLegacyImportApproval("😀".repeat(270_000), a.digest, a), "approval_report_too_large");
  });

  it.each(["", "0".repeat(63), "0".repeat(65), `${H("approved")}\n`, H("approved").toUpperCase()])(
    "rejects a malformed approved digest: %j", (approvedDigest) => {
      const a = createLegacyImportApproval(context(), preview());
      expectCode(() => verifyLegacyImportApproval(JSON.stringify(a), approvedDigest, a), "approval_digest_invalid");
    },
  );

  it.each(["outer", "plan", "context", "input", "counts", "prototype"])("rejects unknown %s fields even if benign-looking", (where) => {
    const a = createLegacyImportApproval(context(), preview());
    const altered = structuredClone(a);
    const locations: Record<string, object> = {
      outer: altered, plan: altered.plan, context: altered.plan.context, input: altered.plan.context.inputDigests,
      counts: altered.plan.ready, prototype: altered.plan,
    };
    Object.defineProperty(locations[where], where === "prototype" ? "__proto__" : "extra", { value: "Private source text", enumerable: true });
    expectCode(() => verifyLegacyImportApproval(JSON.stringify(altered), a.digest, a), "approval_report_invalid");
  });

  it("rejects repeated JSON keys, including escaped spelling aliases", () => {
    const a = createLegacyImportApproval(context(), preview());
    const raw = JSON.stringify(a);
    for (const duplicateKey of ['"plan"', '"\\u0070lan"']) {
      const duplicate = `{${duplicateKey}:null,${raw.slice(1)}`;
      expectCode(() => verifyLegacyImportApproval(duplicate, a.digest, a), "approval_report_invalid");
    }
  });

  it("allows JSON formatting/key-order differences without weakening semantic binding", () => {
    const a = createLegacyImportApproval(context(), preview());
    const raw = ` \n${JSON.stringify({ digest: a.digest, plan: a.plan }, null, 4)}\n `;
    expect(() => verifyLegacyImportApproval(raw, a.digest, a)).not.toThrow();
  });

  it("rejects tampered reports, an unrelated approval token, and a forged current digest", () => {
    const a = createLegacyImportApproval(context(), preview());
    const tampered = structuredClone(a); tampered.plan.context.codeDigest = H("different");
    expectCode(() => verifyLegacyImportApproval(JSON.stringify(tampered), a.digest, a), "approval_report_digest_mismatch");
    expectCode(() => verifyLegacyImportApproval(JSON.stringify(a), H("unrelated"), a), "approval_report_digest_mismatch");
    const current = structuredClone(a); current.digest = H("forged");
    expectCode(() => verifyLegacyImportApproval(JSON.stringify(a), a.digest, current), "approval_current_invalid");
  });

  it.each(["feeCredits", "billingExceptions", "tradeReconciliation", "mapping"] as const)("requires a fresh dry run if %s inputs changed", (key) => {
    const c = context(); const a = createLegacyImportApproval(c, preview());
    c.inputDigests[key] = H(`changed-${key}`);
    const next = createLegacyImportApproval(c, preview());
    expectCode(() => verifyLegacyImportApproval(JSON.stringify(a), a.digest, next), "approval_plan_changed");
  });

  it.each(["codeDigest", "schemaDigest", "serverAddress"] as const)("requires a fresh dry run if %s changed", (key) => {
    const c = context(); const a = createLegacyImportApproval(c, preview());
    c[key] = key === "serverAddress" ? "10.42.0.8" : H(`changed-${key}`);
    const next = createLegacyImportApproval(c, preview());
    expectCode(() => verifyLegacyImportApproval(JSON.stringify(a), a.digest, next), "approval_plan_changed");
  });

  it("cannot reuse a dev approval against prod", () => {
    const dev = createLegacyImportApproval(context("dev"), preview());
    const prod = createLegacyImportApproval(context("prod"), preview());
    expectCode(() => verifyLegacyImportApproval(JSON.stringify(dev), dev.digest, prod), "approval_plan_changed");
  });

  it.each(["clientSfId", "householdSfId", "clientName", "sourceDigest", "scope", "accountIds"] as const)("binds changed private resolution field %s without publishing it", (key) => {
    const p = preview(); const a = createLegacyImportApproval(context(), p);
    if (key === "accountIds") p.requests[0].accountIds = ["different-private-account"];
    else if (key === "scope") p.requests[0].scope = "CLIENT";
    else p.requests[0][key] = key === "sourceDigest" ? H("different-source") : "different-private-value";
    const next = createLegacyImportApproval(context(), p);
    expect(JSON.stringify(next)).not.toContain("different-private");
    expectCode(() => verifyLegacyImportApproval(JSON.stringify(a), a.digest, next), "approval_plan_changed");
  });

  it("requires a fresh dry run when already-imported counts change; a fresh no-op approval is valid", () => {
    const p = preview(); const a = createLegacyImportApproval(context(), p);
    p.existing = counts(1);
    const rerun = createLegacyImportApproval(context(), p);
    expectCode(() => verifyLegacyImportApproval(JSON.stringify(a), a.digest, rerun), "approval_plan_changed");
    expect(() => verifyLegacyImportApproval(JSON.stringify(rerun), rerun.digest, rerun)).not.toThrow();
  });
});
