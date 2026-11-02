import { describe, it, expect } from "vitest";
import { roleFromGroups } from "@/lib/auth/roles";

// roleFromGroups is security-critical: it turns the Okta `groups` claim into the
// app Role that drives Postgres RLS (book-of-business scoping) and UI gating.
// Okta groups follow the firm standard `AOA-<Role>`. A wrong mapping here is an
// authorization bug, so we pin every intended mapping, the naming-standard forms,
// access-level-suffix handling, case-insensitivity, priority, and fail-closed.

describe("roleFromGroups", () => {
  it("maps each AOA-<Role> group to its role", () => {
    expect(roleFromGroups(["AOA-Admin"])).toBe("ADMIN");
    expect(roleFromGroups(["AOA-Operations"])).toBe("OPERATIONS");
    expect(roleFromGroups(["AOA-Advisor"])).toBe("ADVISOR");
    expect(roleFromGroups(["AOA-Client Service"])).toBe("CLIENT_SERVICE");
    expect(roleFromGroups(["AOA-Read Only"])).toBe("VIEWER");
  });

  it("handles the firm's hyphen spacing + access-level suffix (Read/Write ignored)", () => {
    // Convention example: "JVCAPP- Ops Read/Write" — prefix, space, then access level.
    expect(roleFromGroups(["AOA- Ops Read/Write"])).toBe("OPERATIONS");
    expect(roleFromGroups(["AOA-Ops Read Only"])).toBe("OPERATIONS");
    expect(roleFromGroups(["AOA-Advisor Read/Write"])).toBe("ADVISOR");
  });

  it("is case-insensitive", () => {
    expect(roleFromGroups(["AOA-ADMIN"])).toBe("ADMIN");
    expect(roleFromGroups(["aoa-operations"])).toBe("OPERATIONS");
    expect(roleFromGroups(["AOA-Client SERVICE"])).toBe("CLIENT_SERVICE");
  });

  it("also resolves bare role names (no prefix)", () => {
    expect(roleFromGroups(["Admin"])).toBe("ADMIN");
    expect(roleFromGroups(["Operations"])).toBe("OPERATIONS");
    expect(roleFromGroups(["Client Service"])).toBe("CLIENT_SERVICE");
  });

  it("fails closed to VIEWER on empty / no groups", () => {
    expect(roleFromGroups([])).toBe("VIEWER");
    expect(roleFromGroups()).toBe("VIEWER");
  });

  it("fails closed to VIEWER on unknown groups", () => {
    expect(roleFromGroups(["Everyone"])).toBe("VIEWER");
    expect(roleFromGroups(["AOA-Interns", "some-random-group"])).toBe("VIEWER");
  });

  it("Head of Advisory folds into Operations (not a distinct role, never VIEWER)", () => {
    // HoA is folded into OPERATIONS at the mapping layer via a `head of advisory`
    // phrase match. "advisory" is NOT the "advisor" token, so it does not mis-map
    // to ADVISOR; the explicit phrase match routes it to OPERATIONS instead.
    expect(roleFromGroups(["AOA-Head of Advisory"])).toBe("OPERATIONS");
    // Access-level suffix is ignored (RLS scopes by function, not access level).
    expect(roleFromGroups(["AOA-Head of Advisory Read Only"])).toBe("OPERATIONS");
  });

  it("plain advisor group still → ADVISOR (no regression from the HoA phrase match)", () => {
    expect(roleFromGroups(["AOA-Advisor"])).toBe("ADVISOR");
  });

  it("honors priority: highest-privilege match wins regardless of order", () => {
    expect(roleFromGroups(["AOA-Advisor", "AOA-Admin"])).toBe("ADMIN");
    expect(roleFromGroups(["AOA-Admin", "AOA-Advisor"])).toBe("ADMIN");
    expect(roleFromGroups(["AOA-Client Service", "AOA-Operations"])).toBe("OPERATIONS");
    // Admin outranks a Head-of-Advisory (→OPERATIONS) group in the same claim.
    expect(roleFromGroups(["AOA-Head of Advisory", "AOA-Admin"])).toBe("ADMIN");
  });
});
