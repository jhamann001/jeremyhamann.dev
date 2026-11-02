import { describe, expect, it } from "vitest";
import sourceFixture from "./fixtures/transfer-linkage-v1.json";
import type { AoaAcatCandidate, LinkageSnapshot } from "@/lib/data/acat-link-contract";
import { acatPairIdentityReason, makeAcatMatchDecision, matchAcatPopulation } from "@/lib/data/acat-match";

const now = new Date("2026-09-26T12:00:01.000Z");
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const user = "user-11111111-1111-4111-8111-111111111111";
const snapshot = (): LinkageSnapshot => structuredClone(sourceFixture) as LinkageSnapshot;
const target = (changes: Partial<AoaAcatCandidate> = {}): AoaAcatCandidate => ({
  transferId: "synthetic-aoa-1", linkVersion: 0, existingRecordId: null, existingTransferUuid: uuid,
  hold: false, stage: "IN_TRANSFER", fundingType: "ACAT_FULL", archived: false,
  canonicalClientUserIds: [user], dealUserId: user, identityState: "verified", receivingAccount: null,
  transactionReference: { namespace: "apex-acat-transfer", value: uuid, provenance: "EXISTING_LINK" },
  evidenceDigest: "target-facts", ...changes,
});
const match = (targets = [target()], source = snapshot()) =>
  matchAcatPopulation(source, targets, { now, allowLegacyEnrichment: true });

describe("complete-population ACAT matching", () => {
  it("enriches a unique exact legacy UUID and explicitly accounts for all remaining source records", () => {
    const results = match();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ action: "propose", reason: "legacy_enrichment", recordId: "synthetic-acat-single" });
    expect(results[1]).toMatchObject({ transferId: null, recordId: "synthetic-acat-joint", action: "no_counterpart" });
  });

  it("does not infer a transaction from the sole person/account candidate", () => {
    expect(match([target({ existingTransferUuid: null, transactionReference: null })])[0])
      .toMatchObject({ action: "review", reason: "missing_transaction_evidence" });
  });

  it("does not promote valid-shaped unverified CRM references to authority", () => {
    expect(match([target({ existingTransferUuid: null, transactionReference: {
      namespace: "crm.opportunity", value: "006288867315530AAA", provenance: "LEGACY_UNVERIFIED",
    } })])[0]).toMatchObject({ action: "review", reason: "unverified_transaction_evidence" });
  });

  it("uses a separately verified exact transaction reference when provided by an authoritative adapter", () => {
    expect(match([target({ existingTransferUuid: null, transactionReference: {
      namespace: "apex-acat-transfer", value: uuid, provenance: "VERIFIED",
    } })])[0]).toMatchObject({ action: "propose", reason: "unique_transaction_match" });
  });

  it("rejects case-varied duplicate UUIDs even if the competing source row is deleted/completed", () => {
    const source = snapshot();
    source.records.push({ ...source.records[1], recordId: "synthetic-older-attempt", acatTransferId: uuid.toUpperCase(),
      deletedAt: "2026-09-20T00:00:00.000Z", status: "Completed" });
    source.recordCount++;
    expect(match([target()], source)[0]).toMatchObject({ action: "review", reason: "duplicate_reference" });
  });

  it("reserves an archived target's differently cased UUID", () => {
    expect(match([target(), target({ transferId: "archived", archived: true, existingTransferUuid: uuid.toUpperCase() })])[0])
      .toMatchObject({ reason: "duplicate_reference", action: "review" });
  });

  it("does not let two verified target references claim one source record", () => {
    const first = target({ existingTransferUuid: null, transactionReference: {
      namespace: "apex-acat-transfer", value: uuid, provenance: "VERIFIED",
    } });
    expect(match([first, { ...first, transferId: "second" }]).filter((decision) => decision.action === "propose")).toHaveLength(0);
  });

  it("preserves existing links and flags disagreement rather than replacing them", () => {
    expect(match([target({ existingRecordId: "synthetic-acat-single", canonicalClientUserIds: ["other"], dealUserId: "other" })])[0])
      .toMatchObject({ recordId: "synthetic-acat-single", reason: "identity_conflict", action: "review" });
  });

  it("requires agreement between deal and canonical contact identities", () => {
    expect(match([target({ dealUserId: "other" })])[0]).toMatchObject({ reason: "identity_conflict" });
    expect(match([target({ canonicalClientUserIds: [user, "other"] })])[0]).toMatchObject({ reason: "identity_conflict" });
  });

  it("accepts duplicate aliases for the same user but never picks one of conflicting users", () => {
    expect(match([target({ canonicalClientUserIds: [user, user] })])[0]).toMatchObject({ action: "propose" });
    expect(match([target({ identityState: "conflict" })])[0]).toMatchObject({ reason: "identity_conflict" });
  });

  it("requires full verified joint holder/account evidence, never household membership", () => {
    const source = snapshot();
    const joint = source.records[0];
    const candidate = target({ existingTransferUuid: joint.acatTransferId, canonicalClientUserIds: [joint.cedarRidgeUserIds[0]],
      dealUserId: joint.cedarRidgeUserIds[0] });
    expect(acatPairIdentityReason(candidate, joint)).toBe("incomplete_joint_evidence");
    candidate.receivingAccount = { namespace: "cedarRidge.investment_account", id: joint.receivingAccount.id!,
      holderIds: [...joint.cedarRidgeUserIds], complete: true };
    expect(acatPairIdentityReason(candidate, joint)).toBeNull();
    candidate.receivingAccount.holderIds.pop();
    expect(acatPairIdentityReason(candidate, joint)).toBe("identity_conflict");
  });

  it("honors holds and unchanged pair rejection", () => {
    expect(match([target({ hold: true })])[0]).toMatchObject({ reason: "manual_hold", action: "exclude" });
    const source = snapshot();
    const decision = makeAcatMatchDecision(source, target(), source.records[1], "legacy_enrichment", "propose");
    expect(matchAcatPopulation(source, [target()], { now, allowLegacyEnrichment: true, rejectedPairs: [{
      transferId: target().transferId, recordId: source.records[1].recordId, evidenceDigest: decision.evidenceDigest,
    }] })[0]).toMatchObject({ reason: "pair_rejected", action: "exclude" });
  });

  it("keeps historical legacy enrichment explicitly opt-in and refuses new inferred terminal history", () => {
    expect(matchAcatPopulation(snapshot(), [target()], { now })[0]).toMatchObject({ reason: "ineligible_lifecycle" });
    const inferred = target({ existingTransferUuid: null, archived: true, transactionReference: {
      namespace: "apex-acat-transfer", value: uuid, provenance: "VERIFIED",
    } });
    expect(match([inferred])[0]).toMatchObject({ reason: "ineligible_lifecycle" });
  });

  it("fails closed for stale/unavailable/incomplete inventories and duplicate population IDs", () => {
    const source = snapshot();
    source.observedAt = "2026-09-26T11:00:00.000Z";
    expect(match([target()], source).some((decision) => decision.action === "propose")).toBe(false);
    source.observedAt = now.toISOString();
    source.directory.health = "STALE";
    expect(match([target()], source)[0]).toMatchObject({ reason: "source_unavailable" });
    source.directory.health = "FRESH";
    source.recordCount++;
    expect(match([target()], source)[0]).toMatchObject({ reason: "source_unavailable" });
    expect(() => match([target(), target()])).toThrow("duplicate_population_ids");
  });

  it("ignores publication metadata for unchanged pair evidence but binds full source candidate-set proof", () => {
    const source = snapshot();
    const before = match([target()], source)[0];
    source.directory.snapshotId = "new-equivalent-publication";
    source.directory.publishedGeneration++;
    source.observedAt = now.toISOString();
    const after = match([target()], source)[0];
    expect(after.evidenceDigest).toBe(before.evidenceDigest);
    expect(after.sourceCandidateSetDigest).toBe(source.snapshotDigest);
  });
});
