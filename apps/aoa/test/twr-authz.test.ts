import { describe, it, expect } from "vitest";
import { canOpenReport } from "@/lib/twr/authz";

// Page-level authorization gate (coarse role check). Mirrors the pure-function
// unit-test posture of lib/auth/roles.ts. Per-account own-book scoping for
// ADVISOR/CLIENT_SERVICE is enforced downstream by Postgres RLS
// (apexAccountByNumber → client_account_aum_own_book), not here.
describe("canOpenReport — Performance report role gate", () => {
  it("admits the firm-wide and book-scoped roles", () => {
    for (const r of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE"]) {
      expect(canOpenReport(r)).toBe(true);
    }
  });

  it("fails closed for VIEWER, HEAD_OF_ADVISORY (inert), unknown, and empty roles", () => {
    expect(canOpenReport("VIEWER")).toBe(false);
    // HEAD_OF_ADVISORY is no longer a live role — nothing mints it, and it is not
    // a REPORT_ROLES member, so it fails closed like any unknown role.
    expect(canOpenReport("HEAD_OF_ADVISORY")).toBe(false);
    expect(canOpenReport("SOMETHING_ELSE")).toBe(false);
    expect(canOpenReport("")).toBe(false);
    expect(canOpenReport(null)).toBe(false);
    expect(canOpenReport(undefined)).toBe(false);
  });
});
