import { describe, it, expect } from "vitest";
import {
  canViewCedarRidgeUserId,
  CEDAR_RIDGE_USER_ID_VIEW_ROLES,
} from "@/lib/data/client-field-authz";

// Pins the visibility gate for a client's cedar_ridge_user_id: ADMIN/OPERATIONS
// only, fail-closed on everything else (incl. null/unknown). This is the single
// source of truth the data seam + page both defer to, so it must be exact.
describe("canViewCedarRidgeUserId", () => {
  it("permits ADMIN and OPERATIONS", () => {
    expect(canViewCedarRidgeUserId("ADMIN")).toBe(true);
    expect(canViewCedarRidgeUserId("OPERATIONS")).toBe(true);
  });

  it("denies advisor / client-service / viewer", () => {
    expect(canViewCedarRidgeUserId("ADVISOR")).toBe(false);
    expect(canViewCedarRidgeUserId("CLIENT_SERVICE")).toBe(false);
    expect(canViewCedarRidgeUserId("VIEWER")).toBe(false);
  });

  it("fails closed on null / undefined / unknown", () => {
    expect(canViewCedarRidgeUserId(null)).toBe(false);
    expect(canViewCedarRidgeUserId(undefined)).toBe(false);
    expect(canViewCedarRidgeUserId("")).toBe(false);
    expect(canViewCedarRidgeUserId("HEAD_OF_ADVISORY")).toBe(false);
    expect(canViewCedarRidgeUserId("admin")).toBe(false); // case-sensitive by design
  });

  it("the role set is exactly ADMIN + OPERATIONS", () => {
    expect([...CEDAR_RIDGE_USER_ID_VIEW_ROLES].sort()).toEqual(["ADMIN", "OPERATIONS"]);
  });
});
