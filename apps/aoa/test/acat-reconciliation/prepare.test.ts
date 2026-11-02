import { describe, expect, it } from "vitest";
import { prepareManifestFromMatches } from "@/lib/data/acat-reconciliation/prepare";
import { decision, DIGEST, snapshot, sourceRecord, targetRecord, TEST_AT } from "./fixtures";

function input() {
  return { mode: "PREPARE" as const, snapshot: snapshot(), targets: [targetRecord()], targetBoundary: TEST_AT, decisions: [decision()] };
}
describe("prepare complete matcher output for review", () => {
  it("accounts for a unique proposed pair and seals the exact substantive proof", () => {
    const result = prepareManifestFromMatches(input());
    expect(result.summary.tracker.categories.proposed).toBe(1);
    expect(result.summary.aoa.categories.proposed).toBe(1);
    expect(result.manifest.decisions[0].sourceCandidateSetDigest).toBe(DIGEST.snapshot);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it("equivalent publication timestamps do not create a second prepared manifest", () => {
    const original = input(); const refreshed = input();
    refreshed.snapshot.observedAt = "2026-09-26T19:01:00.000Z";
    refreshed.snapshot.directory.snapshotId = "synthetic-new-publication";
    refreshed.snapshot.directory.publishedGeneration = 2;
    refreshed.targetBoundary = new Date("2026-09-26T19:01:01.000Z");
    expect(prepareManifestFromMatches(refreshed).idempotencyKey).toBe(prepareManifestFromMatches(original).idempotencyKey);
  });
  it("keeps source-only terminal history and target-only missing evidence", () => {
    const data = input(); const terminal = sourceRecord("synthetic-completed"); terminal.status = "Completed";
    data.snapshot.records.push(terminal); data.snapshot.recordCount += 1;
    data.decisions.push({ ...decision(), transferId: null, recordId: terminal.recordId, action: "exclude", reason: "ineligible_lifecycle", targetVersion: null, targetDigest: null });
    const result = prepareManifestFromMatches(data);
    expect(result.summary.tracker.total).toBe(2);
    expect(result.summary.tracker.categories.excluded).toBe(1);
  });
  it("refuses source omissions, duplicate targets and competing source proposals", () => {
    const missing = input(); missing.snapshot.records.push(sourceRecord("synthetic-omitted")); missing.snapshot.recordCount += 1;
    expect(() => prepareManifestFromMatches(missing)).toThrow("acat_reconciliation_unaccounted_population");
    const duplicate = input(); duplicate.decisions.push(decision());
    expect(() => prepareManifestFromMatches(duplicate)).toThrow("acat_reconciliation_invalid_target_decisions");
    const competing = input(); competing.targets.push(targetRecord("synthetic-other"));
    competing.decisions.push({ ...decision(), transferId: "synthetic-other" });
    expect(() => prepareManifestFromMatches(competing)).toThrow("acat_reconciliation_conflicting_proposals");
  });
  it("counts an existing reservation once while another target needs review", () => {
    const data = input(); data.targets.push(targetRecord("synthetic-other"));
    data.decisions = [
      { ...decision(), action: "preserve", reason: "existing_link" },
      { ...decision(), transferId: "synthetic-other", action: "review", reason: "reserved_link" },
    ];
    const result = prepareManifestFromMatches(data);
    expect(result.summary.tracker.categories.linked).toBe(1);
    expect(result.summary.aoa.categories.linked).toBe(1);
    expect(result.summary.aoa.categories.pending).toBe(1);
  });
  it("refuses a stale complete-source proof even when the chosen record is unchanged", () => {
    const data = input(); data.snapshot.snapshotDigest = "f".repeat(64);
    expect(() => prepareManifestFromMatches(data)).toThrow("acat_reconciliation_candidate_proof_mismatch");
  });
  it("refuses proposal source-record/account or target revision drift", () => {
    for (const mutate of [
      (data: ReturnType<typeof input>) => { data.snapshot.records[0].recordEvidenceDigest = "f".repeat(64); },
      (data: ReturnType<typeof input>) => { data.snapshot.records[0].accountEvidenceDigest = "f".repeat(64); },
      (data: ReturnType<typeof input>) => { data.targets[0].linkVersion += 1; },
    ]) {
      const data = input(); mutate(data);
      expect(() => prepareManifestFromMatches(data)).toThrow("acat_reconciliation_candidate_proof_mismatch");
    }
  });
});
