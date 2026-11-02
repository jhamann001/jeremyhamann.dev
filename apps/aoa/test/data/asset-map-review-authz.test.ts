import { describe, expect, it } from "vitest";
import {
  ASSET_MAP_REVIEW_ROLES,
  ASSET_MAP_VIEW_ROLES,
  canReviewAssetMapLinks,
  canViewAssetMapping,
} from "@/lib/data/asset-map-review-authz";

// Pure authz predicate for the asset-map review queue (P2.3). Locks the app-layer
// gate to the current ops roles (design §6). RLS is
// the real enforcement; this is the defense so a non-ops caller never opens a
// scope. All invented.

describe("canReviewAssetMapLinks", () => {
  it("permits the current firm-wide ops roles", () => {
    for (const role of ["ADMIN", "OPERATIONS"]) {
      expect(canReviewAssetMapLinks(role)).toBe(true);
    }
  });

  it("denies retired, advisor, client-service, and viewer roles", () => {
    for (const role of ["HEAD_OF_ADVISORY", "ADVISOR", "CLIENT_SERVICE", "VIEWER"]) {
      expect(canReviewAssetMapLinks(role)).toBe(false);
    }
  });

  it("fails closed on null / undefined / empty / unknown", () => {
    expect(canReviewAssetMapLinks(null)).toBe(false);
    expect(canReviewAssetMapLinks(undefined)).toBe(false);
    expect(canReviewAssetMapLinks("")).toBe(false);
    expect(canReviewAssetMapLinks("OWNER")).toBe(false);
  });

  it("the role set is exactly the two current ops roles", () => {
    expect([...ASSET_MAP_REVIEW_ROLES].sort()).toEqual(["ADMIN", "OPERATIONS"]);
  });
});

describe("canViewAssetMapping (ticket)", () => {
  it("permits Admin, Operations, Advisor and Client Service", () => {
    for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE"]) {
      expect(canViewAssetMapping(role)).toBe(true);
    }
  });

  it("denies Viewer, the retired Head of Advisory value, and unknown or missing roles", () => {
    for (const role of ["VIEWER", "HEAD_OF_ADVISORY", "OWNER", "", null, undefined]) {
      expect(canViewAssetMapping(role)).toBe(false);
    }
  });

  it("the view set is exactly the four roles, and only Admin and Operations may also operate", () => {
    expect([...ASSET_MAP_VIEW_ROLES].sort()).toEqual(["ADMIN", "ADVISOR", "CLIENT_SERVICE", "OPERATIONS"]);
    expect([...ASSET_MAP_VIEW_ROLES].filter((role) => canReviewAssetMapLinks(role)).sort()).toEqual(["ADMIN", "OPERATIONS"]);
  });
});
