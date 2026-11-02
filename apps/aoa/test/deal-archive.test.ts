import { describe, expect, it } from "vitest";
import {
  ARCHIVED_DEALS_ROLES,
  ARCHIVE_CONFIRM_COPY,
  canSeeArchivedDeals,
} from "@/lib/data/deal-archive";
import { DEAL_ARCHIVE, DEAL_RESTORE } from "@/lib/audit";
import { EXPORT_HEADERS } from "@/components/deals/deal-export";

// D7 soft delete (WO ticket): the pure contract around archive/restore —
// the Removed-view role gate (O1 audit-read precedent, fail closed), the
// locked confirm copy, the audit action names, and the guarantee that the
// export surface never grows archive columns.

describe("canSeeArchivedDeals", () => {
  it("admits exactly ADMIN and OPERATIONS", () => {
    expect(canSeeArchivedDeals("ADMIN")).toBe(true);
    expect(canSeeArchivedDeals("OPERATIONS")).toBe(true);
  });

  it("rejects every other app role", () => {
    expect(canSeeArchivedDeals("HEAD_OF_ADVISORY")).toBe(false);
    expect(canSeeArchivedDeals("ADVISOR")).toBe(false);
    expect(canSeeArchivedDeals("CLIENT_SERVICE")).toBe(false);
    expect(canSeeArchivedDeals("VIEWER")).toBe(false);
  });

  it("fails closed on missing/garbage roles", () => {
    expect(canSeeArchivedDeals(null)).toBe(false);
    expect(canSeeArchivedDeals(undefined)).toBe(false);
    expect(canSeeArchivedDeals("")).toBe(false);
    expect(canSeeArchivedDeals("admin")).toBe(false); // case-sensitive, like the O1 gate
    expect(canSeeArchivedDeals("SUPERUSER")).toBe(false);
  });

  it("gate set is exactly the two ops roles (drift guard)", () => {
    expect([...ARCHIVED_DEALS_ROLES].sort()).toEqual(["ADMIN", "OPERATIONS"]);
  });
});

describe("archive confirm copy (locked, WO ticket)", () => {
  it("is the exact approved wording", () => {
    expect(ARCHIVE_CONFIRM_COPY).toBe(
      "Removes this deal from the pipeline. It's kept in the audit history and an admin can restore it.",
    );
  });
});

describe("audit action vocabulary", () => {
  it("archive/restore use the dotted deal.* convention", () => {
    expect(DEAL_ARCHIVE).toBe("deal.archive");
    expect(DEAL_RESTORE).toBe("deal.restore");
  });
});

describe("CSV export surface", () => {
  it("gains NO archive columns — archived state never leaves via export", () => {
    for (const header of EXPORT_HEADERS) {
      expect(header.toLowerCase()).not.toContain("archiv");
      expect(header.toLowerCase()).not.toContain("removed");
    }
  });
});
