import { describe, expect, it } from "vitest";
import {
  canApproveFundingPlan,
  canWriteTransfers,
  showAcatLinkCta,
} from "@/lib/data/transfer-write";

// Pure role/props predicates for the transfer write affordances (New-transfer
// button + detail ACAT-link CTA). Gating only — the DB RLS policies remain the
// real enforcement. All invented.

describe("canWriteTransfers", () => {
  it("lets every current non-VIEWER human role write", () => {
    for (const role of ["ADMIN", "OPERATIONS", "ADVISOR", "CLIENT_SERVICE"]) {
      expect(canWriteTransfers(role)).toBe(true);
    }
  });

  it("denies VIEWER", () => {
    expect(canWriteTransfers("VIEWER")).toBe(false);
  });

  it("fails closed on missing, retired, and unknown roles", () => {
    expect(canWriteTransfers(null)).toBe(false);
    expect(canWriteTransfers(undefined)).toBe(false);
    expect(canWriteTransfers("")).toBe(false);
    expect(canWriteTransfers("HEAD_OF_ADVISORY")).toBe(false);
    expect(canWriteTransfers("UNKNOWN")).toBe(false);
  });
});

describe("canApproveFundingPlan", () => {
  it("allows only Operations and admins to finalize a plan", () => {
    expect(canApproveFundingPlan("ADMIN")).toBe(true);
    expect(canApproveFundingPlan("OPERATIONS")).toBe(true);
    for (const role of [
      "ADVISOR",
      "CLIENT_SERVICE",
      "VIEWER",
      "HEAD_OF_ADVISORY",
      null,
      undefined,
    ]) {
      expect(canApproveFundingPlan(role)).toBe(false);
    }
  });
});

describe("showAcatLinkCta", () => {
  it("shows for a writer with no ACAT linked", () => {
    expect(showAcatLinkCta({ canWrite: true, acatTransferId: null })).toBe(true);
    expect(showAcatLinkCta({ canWrite: true, acatTransferId: undefined })).toBe(
      true,
    );
    expect(showAcatLinkCta({ canWrite: true, acatTransferId: "   " })).toBe(
      true,
    ); // blank id is "unlinked"
  });

  it("hides once an ACAT id is linked (the live section renders instead)", () => {
    expect(
      showAcatLinkCta({ canWrite: true, acatTransferId: "ACT-NEIL-8" }),
    ).toBe(false);
  });

  it("hides for a VIEWER regardless of link state", () => {
    expect(showAcatLinkCta({ canWrite: false, acatTransferId: null })).toBe(
      false,
    );
    expect(
      showAcatLinkCta({ canWrite: false, acatTransferId: "ACT-NEIL-8" }),
    ).toBe(false);
  });
});
