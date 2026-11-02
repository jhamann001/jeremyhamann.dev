import { describe, expect, it } from "vitest";
import { reviewCandidateChoices } from "@/lib/data/acat-reconciliation/candidate-presentation";
import { acatPairIdentityReason, acatPairLifecycleEligible } from "@/lib/data/acat-match";
import { sourceRecord, targetRecord } from "./fixtures";

const target = () => ({ ...targetRecord(), existingTransferUuid: null });
const record = () => ({ ...sourceRecord(), workflow: "ACAT" });

describe("candidate picker explanation", () => {
  it("keeps the exact existing eligibility predicate, including held transfers", () => {
    const held = { ...target(), hold: true };
    const records = [record(), { ...record(), recordId: "completed", status: "Completed" }, { ...record(), recordId: "other-person", cedarRidgeUserIds: ["someone-else"] }];
    expect(reviewCandidateChoices(held, records)).toEqual({
      records: records.filter((row) => acatPairIdentityReason(held, row) === null && acatPairLifecycleEligible(held, row)), message: null,
    });
  });

  it.each([
    [undefined, "no longer available"],
    [{ ...target(), existingRecordId: "already-linked" }, "already has an ACAT link"],
    [{ ...target(), existingTransferUuid: "existing-reference" }, "already has an ACAT link"],
    [{ ...target(), archived: true }, "archived"],
    [{ ...target(), stage: "FUNDED" }, "outside Decision or In Transfer"],
    [{ ...target(), fundingType: "CASH" }, "not set to full or partial ACAT"],
    [{ ...target(), identityState: "conflict" as const }, "conflicting Cedar Ridge identity"],
    [{ ...target(), identityState: "missing" as const }, "no verified Cedar Ridge identity"],
  ])("explains target restrictions without claiming identity mismatch", (candidate, message) => {
    const result = reviewCandidateChoices(candidate, [record()]);
    expect(result.records).toEqual([]);
    expect(result.message).toContain(message);
  });

  it.each([
    { status: "Completed" }, { deletedAt: "2026-01-01T00:00:00Z" }, { direction: "OUT" as const }, { transferType: "PARTIAL" as const }, { workflow: "OTHER" },
  ])("distinguishes identity evidence from lifecycle eligibility: %j", (change) => {
    expect(reviewCandidateChoices(target(), [{ ...record(), ...change }]).message).toContain("Records have matching identity evidence");
  });

  it("does not claim no historical counterpart when holder evidence is incomplete", () => {
    const joint = { ...record(), cedarRidgeUserIds: ["synthetic-person", "other-holder"] };
    expect(reviewCandidateChoices(target(), [joint]).message).toContain("Joint accounts require complete holder proof");
    expect(reviewCandidateChoices(target(), [joint]).message).toContain("does not establish that no historical counterpart exists");
    expect(reviewCandidateChoices(target(), []).message).toContain("snapshot contains no ACAT records");
  });
});
