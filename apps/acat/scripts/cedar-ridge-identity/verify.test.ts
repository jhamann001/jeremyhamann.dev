// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sha256 } from "./canonical";
import { buildManifest } from "./manifest";
import { reconcile } from "./verify";
import { evidence, tracker, record, USER_A, USER_B, jointEvidence, NOW } from "./fixtures/synthetic";
import type { AuditProvenance } from "./contracts";

describe("independent full-population reconciliation", () => {
  it("does not call a populated ID verified merely because it exists", () => {
    const manifest = buildManifest(tracker, evidence);
    const result = reconcile([manifest], { ...tracker, records: [{ ...record, cedarRidgeUserId: USER_A, cedarRidgeUserIds: [USER_A] }] }, []);
    expect(result.outcomes[0].status).toBe("linked-needs-validation");
  });
  it("counts and validates a joint set independently of its null scalar projection", () => {
    const manifest = buildManifest(tracker, jointEvidence);
    const result = reconcile([manifest], { ...tracker, records: [{ ...record, cedarRidgeUserIds: [USER_A, USER_B] }] }, []);
    expect(result).toMatchObject({ total: 1, linkedPeople: 2, multiClientRecords: 1 });
    expect(result.outcomes[0].status).toBe("linked-needs-validation");
  });
  it("refuses an audit whose full set differs from the approved decision even if the projection and version agree", () => {
    const manifest = buildManifest(tracker, jointEvidence);
    manifest.rows[0].decision = { kind: "link", userIds: [USER_A, USER_B], reviewer: "operator", reviewedAt: NOW, reason: "Both" };
    manifest.rows[0].directoryEvidenceHash = "c".repeat(64);
    const audit: AuditProvenance = { version: 2, operation: "apply", runId: manifest.runId, manifestHash: sha256(manifest), approvalReference: "synthetic", actor: "operator", recordId: record.id,
      oldUserId: null, newUserId: USER_A, oldUserIds: [], newUserIds: [USER_A], beforeVersion: 0, afterVersion: 1,
      beforeBusinessHash: "a".repeat(64), afterBusinessHash: "a".repeat(64), evidenceHash: manifest.rows[0].evidenceHash,
      directorySnapshotId: "synthetic", directoryEvidenceHash: manifest.rows[0].directoryEvidenceHash, reviewer: "operator", reason: "Both", timestamp: NOW };
    expect(reconcile([manifest], { ...tracker, records: [{ ...record, cedarRidgeUserIds: [USER_A], cedarRidgeUserId: USER_A, identityVersion: 1 }] }, [audit]).outcomes[0].status).toBe("integrity-failure");
    // A missing junction member cannot fall back to an independently validated singleton.
    audit.newUserIds = [USER_A, USER_B]; audit.newUserId = null;
    expect(reconcile([manifest], { ...tracker, records: [{ ...record, cedarRidgeUserIds: [USER_A], cedarRidgeUserId: USER_A, identityVersion: 1 }] }, [audit]).outcomes[0].status).toBe("integrity-failure");
  });
  it("accounts for post-cutover arrivals and missing reviewed history", () => {
    const manifest = buildManifest(tracker, evidence);
    const result = reconcile([manifest], { ...tracker, records: [{ ...record, id: "new-cutover-record" }] }, []);
    expect(result.total).toBe(1); expect(result.outcomes[0].status).toBe("unresolved");
    expect(result.missingRecordIds).toEqual([record.id]);
  });
  it("rejects an audit whose transaction-local business hashes disagree", () => {
    const manifest = buildManifest(tracker, evidence);
    const audit: AuditProvenance = { version: 2, operation: "apply", runId: manifest.runId, manifestHash: sha256(manifest),
      approvalReference: "synthetic-review", actor: "operator", recordId: record.id, oldUserId: null, newUserId: USER_A, oldUserIds: [], newUserIds: [USER_A],
      beforeVersion: 0, afterVersion: 1, beforeBusinessHash: "a".repeat(64), afterBusinessHash: "b".repeat(64),
      evidenceHash: manifest.rows[0].evidenceHash, reviewer: "operator", reason: "Synthetic", timestamp: NOW,
      directorySnapshotId: "synthetic", directoryEvidenceHash: "c".repeat(64) };
    const result = reconcile([manifest], { ...tracker, records: [{ ...record, cedarRidgeUserId: USER_A, cedarRidgeUserIds: [USER_A], identityVersion: 1 }] }, [audit]);
    expect(result.outcomes[0].status).toBe("integrity-failure");
  });
});
