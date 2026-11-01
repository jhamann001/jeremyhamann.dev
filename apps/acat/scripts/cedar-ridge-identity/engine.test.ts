// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "./canonical";
import { applyManifest, undoPlan, type BackfillStore, type BackfillTransaction, type LockedRecord, type UndoPlan } from "./engine";
import { buildManifest } from "./manifest";
import type { AuditProvenance, Evidence, Manifest } from "./contracts";
import { evidence, record, tracker, USER_A, USER_B, jointEvidence, NOW } from "./fixtures/synthetic";
import { acceptCoverage } from "./coverage";

function reviewed(source: Evidence = evidence): Manifest {
  const manifest = buildManifest(tracker, source);
  manifest.rows[0].directoryEvidenceHash = "b".repeat(64);
  manifest.rows[0].decision = { kind: "link", userIds: [USER_A], reviewer: "operator", reviewedAt: NOW, reason: "Synthetic confirmed membership" };
  return manifest;
}
function approval(manifest: unknown) { return { manifestHash: sha256(manifest), actor: "operator", reference: "synthetic-session-approval" }; }

class MemoryStore implements BackfillStore {
  target = tracker.target;
  databaseName = tracker.databaseName;
  installationId = tracker.installationId!;
  row: LockedRecord = { identity: structuredClone(record), business: { clientName: record.clientName, status: "Completed", lastUpdated: "historical-time", assets: ["asset-1"] } };
  audits: AuditProvenance[] = [];
  breakBusinessFields = false;
  failAudit = false;
  versionAdvance = 1;
  async transaction<T>(fn: (tx: BackfillTransaction) => Promise<T>): Promise<T> {
    const rowBefore = structuredClone(this.row);
    const auditBefore = structuredClone(this.audits);
    try {
      return await fn({
        lockRecord: async () => structuredClone(this.row),
        validateSource: async (row) => ({ snapshotId: "synthetic-published-snapshot", directoryEvidenceHash: row.directoryEvidenceHash! }),
        findApplication: async (runId, manifestHash, recordId) => this.audits.find((item) => item.runId === runId && item.manifestHash === manifestHash && item.recordId === recordId) ?? null,
        writeIdentity: async (_id, userIds) => {
          this.row.identity.cedarRidgeUserIds = [...userIds];
          this.row.identity.cedarRidgeUserId = userIds.length === 1 ? userIds[0] : null;
          this.row.identity.identityVersion += this.versionAdvance;
          if (this.breakBusinessFields) this.row.business = { bad: true };
          return structuredClone(this.row);
        },
        appendAudit: async (value) => { if (this.failAudit) throw new Error("AUDIT_WRITE_FAILED"); this.audits.push(value); },
      });
    } catch (error) { this.row = rowBefore; this.audits = auditBefore; throw error; }
  }
}

describe("transactional backfill/undo", () => {
  afterEach(() => vi.unstubAllEnvs());
  const assumption = { acceptedBy: "synthetic-owner", acceptedAt: NOW, reference: "synthetic-owner-decision", reason: "Synthetic established-app coverage assumption" };
  it("allows unknown upstream coverage only with the explicit policy and hashed owner assumption", async () => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "FETCH_SUCCESS");
    const source = acceptCoverage({ ...evidence, upstreamFreshness: "unknown" }, assumption);
    const manifest = reviewed(source), store = new MemoryStore();
    expect((await applyManifest(manifest, source, approval(manifest), store)).outcomes[0].outcome).toBe("applied");
    expect(store.audits[0].evidenceHash).toBe(manifest.rows[0].evidenceHash);
    expect(store.audits[0].evidenceHash).not.toBe(reviewed().rows[0].evidenceHash);
    expect(source.upstreamFreshness).toBe("unknown");
    expect(buildManifest(tracker, source).rows[0].decision.kind).toBe("unresolved");
    await expect(applyManifest(manifest, { ...source, ownerCoverageAssumption: { ...assumption, reference: "changed-acceptance" } }, approval(manifest), new MemoryStore())).rejects.toThrow("SOURCE_COVERAGE_CHANGED_SINCE_REVIEW");
  });
  it.each(["UPSTREAM_VERIFIED", "invalid", ""])("rejects assumed coverage under strict or invalid policy %s", async (policy) => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", policy);
    const source = acceptCoverage({ ...evidence, upstreamFreshness: "unknown" }, assumption), manifest = reviewed(source), store = new MemoryStore();
    await expect(applyManifest(manifest, source, approval(manifest), store)).rejects.toThrow("SOURCE_FRESHNESS_NOT_VERIFIED");
    expect(store.audits).toHaveLength(0);
  });
  it("rejects missing acceptance and explicitly stale evidence even in FETCH_SUCCESS", async () => {
    vi.stubEnv("CLIENT_DIRECTORY_FRESHNESS_POLICY", "FETCH_SUCCESS");
    const unknown: Evidence = { ...evidence, upstreamFreshness: "unknown" }, manifest = reviewed(unknown), store = new MemoryStore();
    await expect(applyManifest(manifest, unknown, approval(manifest), store)).rejects.toThrow("OWNER_COVERAGE_ASSUMPTION_REQUIRED");
    const stale: Evidence = { ...unknown, upstreamFreshness: "stale", ownerCoverageAssumption: assumption };
    const staleManifest = reviewed(stale);
    await expect(applyManifest(staleManifest, stale, approval(staleManifest), store)).rejects.toThrow("SOURCE_FRESHNESS_STALE");
    expect(store.audits).toHaveLength(0);
  });
  it("preserves business state and makes an approved repeat a no-op", async () => {
    const manifest = reviewed(), store = new MemoryStore();
    const before = sha256(store.row.business);
    const first = await applyManifest(manifest, evidence, approval(manifest), store);
    expect(first.outcomes[0].outcome).toBe("applied");
    expect(first.outcomes[0].provenance).toMatchObject({ directorySnapshotId: "synthetic-published-snapshot", directoryEvidenceHash: "b".repeat(64) });
    expect(sha256(store.row.business)).toBe(before);
    const repeat = await applyManifest(manifest, evidence, approval(manifest), store);
    expect(repeat.outcomes[0].outcome).toBe("noop");
    expect(store.audits).toHaveLength(1);
  });
  it("applies and undoes a complete joint set with actual monotonic versions and preserved historical display", async () => {
    const manifest = reviewed(jointEvidence), store = new MemoryStore();
    manifest.rows[0].decision = { kind: "link", userIds: [USER_A, USER_B], reviewer: "operator", reviewedAt: NOW, reason: "Both joint holders" };
    store.versionAdvance = 3;
    const before = sha256(store.row.business);
    const result = await applyManifest(manifest, jointEvidence, approval(manifest), store);
    expect(result.outcomes[0].outcome).toBe("applied");
    expect(result.outcomes[0].provenance).toMatchObject({ version: 2, oldUserIds: [], newUserIds: [USER_A, USER_B], oldUserId: null, newUserId: null, beforeVersion: 0, afterVersion: 3 });
    expect(store.row.identity).toMatchObject({ cedarRidgeUserIds: [USER_A, USER_B], cedarRidgeUserId: null, clientName: record.clientName });
    expect((await applyManifest(manifest, jointEvidence, approval(manifest), store)).outcomes[0].outcome).toBe("noop");
    const plan: UndoPlan = { version: 2, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", originalManifestHash: sha256(manifest), generatedAt: NOW,
      target: store.target, databaseName: store.databaseName, installationId: store.installationId, rows: [{ recordId: record.id, expected: structuredClone(store.row.identity), originalApplication: store.audits[0] }] };
    expect((await undoPlan(plan, approval(plan), store)).outcomes[0].outcome).toBe("undone");
    expect(store.row.identity).toMatchObject({ cedarRidgeUserIds: [], cedarRidgeUserId: null, identityVersion: 6 });
    expect(sha256(store.row.business)).toBe(before);
    expect((await undoPlan(plan, approval(plan), store)).outcomes[0].outcome).toBe("noop");
    store.row.identity.deletedAt = NOW;
    expect((await undoPlan(plan, approval(plan), store)).outcomes[0].code).toBe("UNDO_SUPERSEDED");
  });
  it("does not mistake a different set with the same null projection for an audited application", async () => {
    const manifest = reviewed(jointEvidence), store = new MemoryStore();
    manifest.rows[0].decision = { kind: "link", userIds: [USER_A, USER_B], reviewer: "operator", reviewedAt: NOW, reason: "Both joint holders" };
    await applyManifest(manifest, jointEvidence, approval(manifest), store);
    store.row.identity.cedarRidgeUserIds = [];
    expect((await applyManifest(manifest, jointEvidence, approval(manifest), store)).outcomes[0].code).toBe("APPLICATION_SUPERSEDED");
  });
  it("rejects stale records and a later relink away and back", async () => {
    const manifest = reviewed(), store = new MemoryStore();
    store.row.identity.apexAccountId = "different";
    expect((await applyManifest(manifest, evidence, approval(manifest), store)).outcomes[0].code).toBe("RECORD_CHANGED_SINCE_REVIEW");
    store.row.identity = structuredClone(record);
    await applyManifest(manifest, evidence, approval(manifest), store);
    store.row.identity.identityVersion += 2;
    expect((await applyManifest(manifest, evidence, approval(manifest), store)).outcomes[0].code).toBe("APPLICATION_SUPERSEDED");
  });
  it("rolls back the identity when audit fails or a business field changes", async () => {
    for (const failure of ["failAudit", "breakBusinessFields"] as const) {
      const manifest = reviewed(), store = new MemoryStore(); store[failure] = true;
      expect((await applyManifest(manifest, evidence, approval(manifest), store)).outcomes[0].outcome).toBe("conflict");
      expect(store.row.identity).toEqual(record); expect(store.audits).toHaveLength(0);
    }
  });
  it("cannot write from unknown upstream freshness, a wrong approval, or an unbound plan", async () => {
    const manifest = reviewed(), store = new MemoryStore();
    await expect(applyManifest(manifest, { ...evidence, upstreamFreshness: "unknown" }, approval(manifest), store)).rejects.toThrow("SOURCE_FRESHNESS_NOT_VERIFIED");
    await expect(applyManifest(manifest, evidence, { ...approval(manifest), manifestHash: "f".repeat(64) }, store)).rejects.toThrow("MANIFEST_APPROVAL_MISMATCH");
    manifest.rows[0].directoryEvidenceHash = null;
    expect((await applyManifest(manifest, evidence, approval(manifest), store)).outcomes[0].code).toBe("DIRECTORY_EVIDENCE_NOT_BOUND");
  });
  it("rejects premigration placeholder versions even when they equal the current DB version", async () => {
    const manifest = reviewed(), store = new MemoryStore();
    manifest.preMigrationPlaceholders = ["identityVersion", "cedarRidgeUserId"];
    await expect(applyManifest(manifest, evidence, approval(manifest), store)).rejects.toThrow("PREMIGRATION_PLAN_CANNOT_APPLY");
    expect(store.audits).toHaveLength(0);
  });
  it("refuses another database installation even if target label and database name match", async () => {
    const manifest = reviewed(), store = new MemoryStore();
    store.installationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await expect(applyManifest(manifest, evidence, approval(manifest), store)).rejects.toThrow("TARGET_MISMATCH");
    expect(store.audits).toHaveLength(0);
  });
  it("resumes from database audit even when receipt output was interrupted", async () => {
    const manifest = reviewed(), store = new MemoryStore();
    await expect(applyManifest(manifest, evidence, approval(manifest), store, { onOutcome: async () => { throw new Error("disk failed"); } })).rejects.toThrow("disk failed");
    expect(store.audits).toHaveLength(1);
    expect((await applyManifest(manifest, evidence, approval(manifest), store)).outcomes[0].outcome).toBe("noop");
  });
  it("undo advances the trigger-owned version and retains compensating audit", async () => {
    const manifest = reviewed(), store = new MemoryStore();
    await applyManifest(manifest, evidence, approval(manifest), store);
    const plan: UndoPlan = { version: 2, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", originalManifestHash: sha256(manifest), generatedAt: NOW,
      target: tracker.target, databaseName: tracker.databaseName, installationId: store.installationId, rows: [{ recordId: record.id, expected: structuredClone(store.row.identity), originalApplication: store.audits[0] }] };
    expect((await undoPlan(plan, approval(plan), store)).outcomes[0].outcome).toBe("undone");
    expect(store.row.identity).toMatchObject({ cedarRidgeUserId: null, identityVersion: 2 });
    expect(store.audits).toHaveLength(2);
    expect((await undoPlan(plan, approval(plan), store)).outcomes[0].outcome).toBe("noop");
  });
  it("refuses undo after a later identity change even if user ID matches", async () => {
    const manifest = reviewed(), store = new MemoryStore();
    await applyManifest(manifest, evidence, approval(manifest), store);
    const plan: UndoPlan = { version: 2, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", originalManifestHash: sha256(manifest), generatedAt: NOW,
      target: tracker.target, databaseName: tracker.databaseName, installationId: store.installationId, rows: [{ recordId: record.id, expected: structuredClone(store.row.identity), originalApplication: store.audits[0] }] };
    store.row.identity.identityVersion += 2;
    expect((await undoPlan(plan, approval(plan), store)).outcomes[0].code).toBe("UNDO_CONFLICT");
  });
});
