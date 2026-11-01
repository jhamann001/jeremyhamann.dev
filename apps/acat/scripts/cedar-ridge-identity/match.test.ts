// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sha256 } from "./canonical";
import { buildManifest, findCatchUpRecords, validateManifest, verifyApproval, verifyManifestEvidence } from "./manifest";
import { matchRecord, validateEvidence } from "./match";
import { evidence, jointEvidence, record, tracker, USER_A, USER_B, NOW } from "./fixtures/synthetic";

describe("backfill matching and review integrity", () => {
  it("matches trimmed account numbers and retains the whole ID", () => {
    const result = matchRecord(record, evidence);
    expect(result.category).toBe("stable-name-agrees");
    expect(result.candidateIds).toEqual([USER_A]);
    expect(result.decision.kind).toBe("unresolved");
  });
  it("preserves separate joint members instead of choosing a matching name or initiator", () => {
    const joint = { ...evidence, accounts: [...evidence.accounts, { ...evidence.accounts[0], userId: USER_B, relationshipType: "JOINT" }] };
    expect(matchRecord(record, joint)).toMatchObject({ category: "multiple-users", candidateIds: [USER_A, USER_B] });
  });
  it("proposes the complete JOINT account set, never the account/transfer union", () => {
    const manifest = buildManifest(tracker, jointEvidence);
    expect(manifest.rows[0]).toMatchObject({ category: "joint-account-members", accountCandidateIds: [USER_A, USER_B], decision: { kind: "unresolved" } });
    manifest.rows[0].decision = { kind: "link", userIds: [USER_A, USER_B], reviewer: "operator", reviewedAt: NOW, reason: "Both verified joint holders" };
    expect(() => validateManifest(manifest)).not.toThrow();
    manifest.rows[0].decision.userIds = [USER_A];
    expect(() => validateManifest(manifest)).toThrow("JOINT_LINK_REQUIRES_COMPLETE_ACCOUNT_SET");

    const transferOnly = { ...evidence, transfers: [...evidence.transfers, { ...evidence.transfers[0], userId: USER_B }] };
    const outlier = buildManifest(tracker, transferOnly);
    expect(outlier.rows[0]).toMatchObject({ category: "multiple-users", accountCandidateIds: [USER_A], transferCandidateIds: [USER_A, USER_B] });
    outlier.rows[0].decision = { ...manifest.rows[0].decision, userIds: [USER_A, USER_B] };
    expect(() => validateManifest(outlier)).toThrow("MULTI_LINK_REQUIRES_JOINT_ACCOUNT");
    outlier.rows[0].decision.userIds = [USER_A];
    expect(() => validateManifest(outlier)).not.toThrow();
  });
  it("rejects empty, duplicate and noncanonical reviewed sets instead of changing approved bytes", () => {
    const manifest = buildManifest(tracker, jointEvidence);
    for (const userIds of [[], [USER_A, USER_A], [USER_B, USER_A]]) {
      manifest.rows[0].decision = { kind: "link", userIds, reviewer: "operator", reviewedAt: NOW, reason: "Synthetic" };
      expect(() => validateManifest(manifest)).toThrow();
    }
  });
  it("detects authoritative joint sets even when the scalar projection remains null", () => {
    const linked = { ...record, cedarRidgeUserIds: [USER_A, USER_B], cedarRidgeUserId: null, identityVersion: 4 };
    expect(matchRecord(linked, jointEvidence).category).toBe("already-linked");
    expect(findCatchUpRecords(buildManifest(tracker, jointEvidence), { ...tracker, records: [linked] }).changedRecordIds).toEqual([record.id]);
  });
  it("requires review for punctuation/name variation and disjoint evidence", () => {
    expect(matchRecord({ ...record, clientName: "Morgan S." }, evidence).category).toBe("stable-name-varies");
    expect(matchRecord(record, { ...evidence, transfers: [{ ...evidence.transfers[0], userId: USER_B }] }).category).toBe("evidence-conflict");
  });
  it("does not infer a test exclusion, and name-only cannot become an approved link without corroboration", () => {
    expect(matchRecord({ ...record, clientName: "test", apexAccountId: "test", acatTransferId: null }, evidence).category).toBe("unmatched");
    const manifest = buildManifest({ ...tracker, records: [{ ...record, apexAccountId: "", acatTransferId: null }] }, evidence);
    manifest.rows[0].decision = { kind: "link", userIds: [USER_A], reviewer: "reviewer", reviewedAt: NOW, reason: "Checked" };
    expect(() => validateManifest(manifest)).toThrow("NAME_ONLY_CORROBORATION_REQUIRED");
  });
  it("proves uniqueness and rejects normalization collisions and orphan relationships", () => {
    expect(() => validateEvidence({ ...evidence, clients: [...evidence.clients, evidence.clients[0]] })).toThrow("DUPLICATE_CLIENT_ID");
    expect(() => validateEvidence({ ...evidence, accounts: [...evidence.accounts, { ...evidence.accounts[0], accountId: "other", accountNumber: " synthetic1 " }] })).toThrow("ACCOUNT_NUMBER_COLLISION");
    expect(() => validateEvidence({ ...evidence, accounts: [...evidence.accounts, evidence.accounts[0]] })).toThrow("DUPLICATE_ACCOUNT_MEMBERSHIP");
    expect(() => validateEvidence({ ...evidence, clients: [evidence.clients[1]] })).toThrow("ORPHAN_ACCOUNT_USER");
  });
  it("hashes review contents, rejects duplicate rows and excludes unreviewed additions", () => {
    const manifest = buildManifest(tracker, evidence);
    const approval = { manifestHash: sha256(manifest), actor: "operator", reference: "approval-session-ref" };
    expect(verifyApproval(manifest, approval)).toEqual(approval);
    manifest.rows[0].decision = { kind: "exception", reviewer: "reviewer", reviewedAt: NOW, reason: "Explicitly accepted" };
    expect(() => verifyApproval(manifest, approval)).toThrow("MANIFEST_APPROVAL_MISMATCH");
    manifest.rows.push(manifest.rows[0]);
    expect(() => validateManifest(manifest)).toThrow("DUPLICATE_MANIFEST_RECORD");
  });
  it("allows an unrelated refresh but rejects changed relevant relationship/name evidence", () => {
    const manifest = buildManifest(tracker, evidence);
    expect(() => verifyManifestEvidence(manifest, { ...evidence, snapshotId: "new", extractedAt: "2026-09-25T13:00:00.000Z" })).not.toThrow();
    const changed = structuredClone(evidence); changed.clients[0].name = "Changed Person";
    expect(() => verifyManifestEvidence(manifest, changed)).toThrow("RELEVANT_SOURCE_EVIDENCE_CHANGED");
  });
  it("finds created, restored and disappeared records during full-population catch-up", () => {
    const manifest = buildManifest({ ...tracker, records: [{ ...record, deletedAt: NOW }, { ...record, id: "gone" }] }, evidence);
    expect(findCatchUpRecords(manifest, { ...tracker, records: [record, { ...record, id: "new" }] })).toEqual({ newRecordIds: ["new"], changedRecordIds: [record.id], missingRecordIds: ["gone"] });
  });
});
