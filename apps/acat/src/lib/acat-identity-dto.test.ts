import { describe, expect, it } from "vitest";
import { toOperationalAcat } from "./acat-identity-dto";

describe("operational client identity projection", () => {
  it("exposes both people without an arbitrary scalar primary or private cache", () => {
    const response = toOperationalAcat({ id: "record", clientName: "Historical household", cedarRidgeUserId: "old",
      identitySetIds: ["internal"], clientLinks: [
        { cedarRidgeUserId: "user-b", client: { canonicalName: "Blair Sample" } },
        { cedarRidgeUserId: "user-a", client: { canonicalName: "Alex Sample" } },
      ] });
    expect(response).toEqual({ id: "record", clientName: "Historical household", cedarRidgeUserId: null,
      cedarRidgeUserIds: ["user-a", "user-b"], linkedClients: [
        { cedarRidgeUserId: "user-a", displayName: "Alex Sample" },
        { cedarRidgeUserId: "user-b", displayName: "Blair Sample" },
      ] });
    expect(response).not.toHaveProperty("clientLinks");
    expect(response).not.toHaveProperty("identitySetIds");
  });
  it("derives a singleton projection from the relation", () => {
    expect(toOperationalAcat({ cedarRidgeUserId: null,
      clientLinks: [{ cedarRidgeUserId: "user-a", client: { canonicalName: "Alex Sample" } }] }).cedarRidgeUserId).toBe("user-a");
  });
  it("does not treat a stale scalar projection as an authoritative link", () => {
    const response = toOperationalAcat({ cedarRidgeUserId: "stale", clientLinks: [] });
    expect(response.cedarRidgeUserId).toBeNull();
    expect(response.cedarRidgeUserIds).toEqual([]);
  });
});
