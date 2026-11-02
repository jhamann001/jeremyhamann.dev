import { describe, expect, it } from "vitest";
import { manifestDigest, sealPreparedManifest, stableManifestJson, verifyPreparedManifest, type PreparedManifest } from "@/lib/data/acat-reconciliation/manifest";

function fixture(): PreparedManifest {
  return {
    mode: "PREPARE", contractVersion: 1, ruleVersion: "acat-link-v1", installationId: "synthetic-dev", sourceScope: "ALL_RECORDS_INCLUDING_DELETED",
    sourceDigest: "a".repeat(64), sourceCount: 2, sourceComplete: true, targetDigest: "b".repeat(64), targetCount: 1,
    decisions: [{
      decisionKey: "synthetic-pair", recordId: "synthetic-record", transferId: "synthetic-transfer", reason: "legacy_enrichment", action: "propose", ruleVersion: "acat-link-v1",
      evidenceDigest: "c".repeat(64), targetVersion: 0, targetDigest: "d".repeat(64), sourceCandidateSetDigest: "e".repeat(64),
      sourceRecordDigest: "a".repeat(64), sourceAccountDigest: "b".repeat(64),
      payload: { synthetic: true, expected: { recordId: null, transferId: "synthetic-uuid" } },
    }],
  };
}

describe("immutable reviewed reconciliation manifests", () => {
  it("is stable under JSON property order and decision order without mutating inputs", () => {
    expect(manifestDigest({ b: 2, a: 1 })).toBe(manifestDigest({ a: 1, b: 2 }));
    const data = fixture();
    data.decisions.push({ ...data.decisions[0], decisionKey: "synthetic-other", recordId: "synthetic-other-record" });
    const copy = structuredClone(data);
    const sealed = sealPreparedManifest(data);
    copy.decisions.reverse();
    expect(sealPreparedManifest(copy)).toEqual(sealed);
    expect(data.decisions[0].decisionKey).toBe("synthetic-pair");
    expect(verifyPreparedManifest(data, sealed.digest)).toBe(true);
  });

  it("binds environment, scope, rule, complete candidate set and target revision", () => {
    const original = fixture();
    const sealed = sealPreparedManifest(original);
    const mutations: Array<(manifest: PreparedManifest) => void> = [
      (m) => { m.installationId = "production"; },
      (m) => { m.sourceScope = "inflight-only"; },
      (m) => { m.sourceDigest = "f".repeat(64); },
      (m) => { m.sourceCount += 1; },
      (m) => { m.targetDigest = "f".repeat(64); },
      (m) => { m.decisions[0].targetVersion = 1; },
      (m) => { m.decisions[0].sourceCandidateSetDigest = "f".repeat(64); },
      (m) => { m.decisions[0].payload = { synthetic: true, altered: true }; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(original); mutate(changed);
      expect(verifyPreparedManifest(changed, sealed.digest)).toBe(false);
    }
  });

  it("refuses incomplete discovery and invalid/duplicate decisions", () => {
    const incomplete = fixture(); incomplete.sourceComplete = false;
    expect(() => sealPreparedManifest(incomplete)).toThrow("acat_manifest_invalid_scope");
    const duplicate = fixture(); duplicate.decisions.push({ ...duplicate.decisions[0] });
    expect(() => sealPreparedManifest(duplicate)).toThrow("acat_manifest_invalid_decision");
    const wrongHash = fixture(); wrongHash.decisions[0].evidenceDigest = "not-a-digest";
    expect(() => sealPreparedManifest(wrongHash)).toThrow("acat_manifest_invalid_decision");
    const noPair = fixture(); noPair.decisions[0].recordId = null; noPair.decisions[0].transferId = null;
    expect(() => sealPreparedManifest(noPair)).toThrow("acat_manifest_invalid_decision");
  });

  it("does not silently lose unsupported data from the digest", () => {
    expect(() => stableManifestJson({ value: Number.NaN })).toThrow("acat_manifest_invalid_json");
    expect(() => stableManifestJson({ value: Number.POSITIVE_INFINITY })).toThrow("acat_manifest_invalid_json");
    expect(() => manifestDigest("x".repeat(1_048_576))).toThrow("acat_manifest_payload_too_large");
    const cyclic: { self?: typeof cyclic } = {}; cyclic.self = cyclic;
    expect(() => stableManifestJson(cyclic)).toThrow("acat_manifest_invalid_json");
    expect(() => stableManifestJson(new Array(1))).toThrow("acat_manifest_invalid_json");
  });

  it("seals the complete supported population without applying a one-row size limit to the run", () => {
    const data = fixture(); data.sourceCount = 5_000; data.targetCount = 5_000;
    const example = data.decisions[0];
    data.decisions = Array.from({ length: 10_000 }, (_, index) => ({
      ...example, decisionKey: `synthetic-decision-${index}`,
      recordId: index < 5_000 ? `synthetic-record-${index}` : null,
      transferId: index >= 5_000 ? `synthetic-transfer-${index}` : null,
    }));
    expect(Buffer.byteLength(stableManifestJson({ ...data, decisions: data.decisions.map((row) => ({ ...row })) }), "utf8")).toBeGreaterThan(1_048_576);
    expect(sealPreparedManifest(data).digest).toMatch(/^[a-f0-9]{64}$/);
    data.decisions[0].payload = "x".repeat(16_777_216);
    expect(() => sealPreparedManifest(data)).toThrow("acat_manifest_payload_too_large");
  });
});
