import { describe, expect, it } from "vitest";
import { clientIdentityRelinkSchema, createAcatSchema, requestedClientIds, updateAcatSchema } from "./validators";

const a = "user-00000000-0000-4000-8000-000000000001";
const b = "user-00000000-0000-4000-8000-000000000002";
describe("joint identity wire validation", () => {
  it("accepts an explicit unique set and normalizes order", () => {
    const parsed = createAcatSchema.parse({ cedarRidgeUserIds: [b, a], apexAccountId: "JOINT01" });
    expect(requestedClientIds(parsed)).toEqual([a, b]);
  });
  it("rejects empty, duplicate or mixed scalar/plural selections", () => {
    for (const input of [{ cedarRidgeUserIds: [] }, { cedarRidgeUserIds: [a, a] }, { cedarRidgeUserIds: [a], cedarRidgeUserId: a }]) {
      expect(createAcatSchema.safeParse({ ...input, apexAccountId: "JOINT01" }).success).toBe(false);
      expect(clientIdentityRelinkSchema.safeParse({ ...input, expectedIdentityVersion: 3, reason: "Reviewed" }).success).toBe(false);
    }
  });
  it("requires an account for more than one selected person even while pending", () => {
    expect(createAcatSchema.safeParse({ cedarRidgeUserIds: [a, b], status: "PendingAccountOpening" }).success).toBe(false);
    expect(createAcatSchema.safeParse({ cedarRidgeUserIds: [a], status: "PendingAccountOpening" }).success).toBe(true);
  });
  it("accepts a legacy singleton but never allows identity writes through generic PATCH", () => {
    expect(requestedClientIds(createAcatSchema.parse({ cedarRidgeUserId: a }))).toEqual([a]);
    for (const input of [{ cedarRidgeUserIds: [a, b] }, { clientLinks: [] }, { identitySetIds: [a] }, { _identity_set_ids: [a] }]) {
      expect(updateAcatSchema.safeParse(input).success).toBe(false);
    }
  });
});
