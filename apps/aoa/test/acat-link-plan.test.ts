import { describe, expect, it } from "vitest";
import {
  ACAT_UUID_SHAPE,
  planAcatLinkChange,
  type AcatLinkPlan,
} from "@/lib/data/acat-link";

// Either-id routing for the edit form's free-text ACAT field
// (fix/acat-link-either-id): the PURE plan the create/update actions execute.
// Shape-detection routes non-UUID values to the by-RECORD tracker read FIRST
// (real record PKs are cuids, dev fixture ids are `rec-…` — both must route as
// record ids), UUID-shaped values to the legacy by-UUID read; blanks clear;
// resubmitting the stored link (EITHER column) is a no-op that must never call
// the tracker.

const NONE = { acat_record_id: null, acat_transfer_id: null };
const UUID = "1f0c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const CUID = "cmrezpdyf0001s6019c0bup4n";

describe("ACAT_UUID_SHAPE", () => {
  it("matches Apex transfer UUIDs (case-insensitive)", () => {
    expect(ACAT_UUID_SHAPE.test(UUID)).toBe(true);
    expect(ACAT_UUID_SHAPE.test(UUID.toUpperCase())).toBe(true);
  });

  it("does NOT match tracker cuids, dev fixture ids, or short residual ids", () => {
    expect(ACAT_UUID_SHAPE.test(CUID)).toBe(false);
    expect(ACAT_UUID_SHAPE.test("rec-manual-hayes")).toBe(false);
    expect(ACAT_UUID_SHAPE.test("ACT-RES-2")).toBe(false);
  });
});

describe("planAcatLinkChange", () => {
  it("routes a cuid-shaped value to the by-RECORD verification", () => {
    expect(planAcatLinkChange(CUID, NONE)).toEqual<AcatLinkPlan>({
      kind: "verify_record",
      id: CUID,
    });
  });

  it("routes ANY non-UUID value record-first (dev fixture `rec-…` ids included)", () => {
    // Fixture ids are NOT cuid-shaped — shape detection must be "not a UUID",
    // never a cuid allowlist, or the ACAT_FIXTURE dev flow breaks.
    expect(planAcatLinkChange("rec-manual-hayes", NONE)).toEqual({
      kind: "verify_record",
      id: "rec-manual-hayes",
    });
    expect(planAcatLinkChange("ACT-RES-2", NONE)).toEqual({
      kind: "verify_record",
      id: "ACT-RES-2",
    });
  });

  it("routes a UUID-shaped value to the by-UUID verification (trimmed)", () => {
    expect(planAcatLinkChange(`  ${UUID}  `, NONE)).toEqual({
      kind: "verify_uuid",
      id: UUID,
    });
  });

  it("blank with NO stored link → unchanged (no clear write, no tracker call)", () => {
    expect(planAcatLinkChange("", NONE)).toEqual({ kind: "unchanged" });
    expect(planAcatLinkChange("   ", NONE)).toEqual({ kind: "unchanged" });
  });

  it("blank while a link IS stored → clear (the explicit unlink of BOTH columns)", () => {
    expect(
      planAcatLinkChange("", { acat_record_id: CUID, acat_transfer_id: null }),
    ).toEqual({ kind: "clear" });
    expect(
      planAcatLinkChange("", { acat_record_id: null, acat_transfer_id: UUID }),
    ).toEqual({ kind: "clear" });
  });

  it("resubmitting the value stored in EITHER column → unchanged (never a tracker call)", () => {
    // The edit form seeds record-id-first, but a legacy row shows its UUID —
    // both must round-trip as a no-op.
    expect(
      planAcatLinkChange(CUID, { acat_record_id: CUID, acat_transfer_id: UUID }),
    ).toEqual({ kind: "unchanged" });
    expect(
      planAcatLinkChange(UUID, { acat_record_id: CUID, acat_transfer_id: UUID }),
    ).toEqual({ kind: "unchanged" });
    expect(
      planAcatLinkChange(` ${UUID} `, {
        acat_record_id: null,
        acat_transfer_id: UUID,
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("a DIFFERENT value than the stored link routes to verification", () => {
    expect(
      planAcatLinkChange("rec-other", {
        acat_record_id: CUID,
        acat_transfer_id: UUID,
      }),
    ).toEqual({ kind: "verify_record", id: "rec-other" });
    expect(
      planAcatLinkChange("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
        acat_record_id: CUID,
        acat_transfer_id: UUID,
      }),
    ).toEqual({
      kind: "verify_uuid",
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
  });
});
