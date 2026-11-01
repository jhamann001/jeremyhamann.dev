// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sha256 } from "./canonical";
import { buildManifest, validateManifest, verifyApproval } from "./manifest";
import { inspectLegacy } from "./legacy";
import { evidence, tracker, USER_A, NOW } from "./fixtures/synthetic";

describe("v1 archival artifacts cannot authorize v2 identities", () => {
  const legacyTracker = { ...tracker, version: 1, records: tracker.records.map(({ cedarRidgeUserIds: _ids, ...row }) => { void _ids; return row; }) };
  function legacyManifest() {
    const current = buildManifest(tracker, evidence);
    return { ...current, version: 1, rows: current.rows.map((row) => ({ ...row, expected: legacyTracker.records[0], decision: { kind: "link", userId: USER_A, reviewer: "operator", reviewedAt: NOW, reason: "Original scalar review" } })) };
  }
  it("inspects the original bytes without adding sets or changing its digest", () => {
    for (const input of [legacyTracker, legacyManifest()]) {
      const before = JSON.stringify(input);
      expect(inspectLegacy(input)).toMatchObject({ version: 1, artifactHash: sha256(input), actionable: false, readOnly: true });
      expect(JSON.stringify(input)).toBe(before);
    }
  });
  it("requires a new snapshot and refuses legacy manifest writes and approval reuse", () => {
    expect(() => buildManifest(legacyTracker, evidence)).toThrow("LEGACY_ARTIFACT_READ_ONLY");
    const old = legacyManifest();
    expect(() => validateManifest(old)).toThrow("LEGACY_ARTIFACT_READ_ONLY");
    const current = buildManifest(tracker, evidence);
    expect(() => verifyApproval(current, { manifestHash: sha256(old), actor: "operator", reference: "old scalar approval" })).toThrow("MANIFEST_APPROVAL_MISMATCH");
  });
});
