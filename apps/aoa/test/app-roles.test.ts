import { describe, expect, it } from "vitest";
import { APP_ROLES, normalizeAppRole } from "@/lib/auth/app-roles";

const EXPECTED_ROLES = [
  "ADMIN",
  "OPERATIONS",
  "ADVISOR",
  "CLIENT_SERVICE",
  "VIEWER",
] as const;

describe("application RLS role boundary", () => {
  it("deliberately covers every current Prisma role", () => {
    expect([...APP_ROLES].sort()).toEqual([...EXPECTED_ROLES].sort());
  });

  it.each(EXPECTED_ROLES)("preserves the valid %s role", (role) => {
    expect(normalizeAppRole(role)).toBe(role);
  });

  it("converts the retired Head of Advisory role to Operations", () => {
    expect(normalizeAppRole("HEAD_OF_ADVISORY")).toBe("OPERATIONS");
  });

  it("fails closed for unknown, empty, and missing role text", () => {
    expect(normalizeAppRole("INGEST")).toBe("VIEWER");
    expect(normalizeAppRole("")).toBe("VIEWER");
    expect(normalizeAppRole(null)).toBe("VIEWER");
    expect(normalizeAppRole(undefined)).toBe("VIEWER");
  });
});
