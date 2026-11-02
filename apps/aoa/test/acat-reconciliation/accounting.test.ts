import { describe, expect, it } from "vitest";
import {
  canonicalInventoryReference, countDuplicateReferences, summarizeCoverage,
  type CoverageDisposition, type SourceInventoryRow, type TargetInventoryRow,
} from "@/lib/data/acat-reconciliation/accounting";

const UUID = "ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456";
const source: SourceInventoryRow[] = [
  { id: "synthetic-active", status: "Submitted", deleted: false, externalReference: UUID },
  { id: "synthetic-deleted", status: "Canceled", deleted: true, externalReference: UUID.toLowerCase() },
  { id: "synthetic-completed", status: "Completed", deleted: false, externalReference: "N/A" },
  { id: "synthetic-test", status: "Pending", deleted: false, externalReference: null },
  { id: "synthetic-unpaired", status: "PendingAccountOpening", deleted: false, externalReference: "opaque-1" },
];
const target: TargetInventoryRow[] = [
  { id: "synthetic-open", stage: "IN_TRANSFER", archived: false, acatRecordId: null, acatTransferId: null },
  { id: "synthetic-archived", stage: "FUNDED", archived: true, acatRecordId: "synthetic-completed", acatTransferId: UUID },
];
const dispositions: CoverageDisposition[] = [
  { population: "tracker", id: "synthetic-active", category: "pending" },
  { population: "tracker", id: "synthetic-deleted", category: "excluded" },
  { population: "tracker", id: "synthetic-completed", category: "linked" },
  { population: "tracker", id: "synthetic-test", category: "excluded" },
  { population: "tracker", id: "synthetic-unpaired", category: "no_counterpart" },
  { population: "aoa", id: "synthetic-open", category: "pending" },
  { population: "aoa", id: "synthetic-archived", category: "linked" },
];
function fixture() {
  return {
    tracker: structuredClone(source), aoa: structuredClone(target), dispositions: structuredClone(dispositions),
    trackerBoundary: { readAt: "2026-09-26T12:00:00.000Z", complete: true, declaredCount: source.length },
    aoaBoundary: { readAt: "2026-09-26T12:00:01.000Z", complete: true, declaredCount: target.length },
  };
}

describe("complete ACAT reconciliation accounting", () => {
  it("partitions unequal source/target populations and keeps deleted/terminal/archive rows", () => {
    const data = fixture();
    const before = structuredClone(data);
    const result = summarizeCoverage(data);
    expect(result.tracker.total).toBe(5);
    expect(result.aoa.total).toBe(2);
    expect(result.tracker.categories).toEqual({ linked: 1, proposed: 0, pending: 1, excluded: 2, no_counterpart: 1 });
    expect(Object.values(result.tracker.categories).reduce((sum, n) => sum + n, 0)).toBe(5);
    expect(Object.values(result.aoa.categories).reduce((sum, n) => sum + n, 0)).toBe(2);
    expect(result.tracker.deleted).toBe(1);
    expect(result.tracker.statusCounts.Completed).toBe(1);
    expect(result.aoa.archived).toBe(1);
    expect(result.boundaries.tracker).not.toBe(result.boundaries.aoa);
    expect(data).toEqual(before);
    expect(result.tracker.duplicateExternalReferences).toEqual({ groups: 1, members: 2 });
  });

  it("fails closed for incomplete, overflowed or malformed inventory metadata", () => {
    for (const change of [{ complete: false }, { declaredCount: 4 }, { declaredCount: -1 }, { readAt: "invalid" }]) {
      const data = fixture();
      Object.assign(data.trackerBoundary, change);
      expect(() => summarizeCoverage(data)).toThrow("acat_reconciliation_incomplete_inventory");
    }
  });

  it("proves inventory grain and refuses duplicate IDs rather than deduplicating", () => {
    const data = fixture();
    data.tracker.push({ ...data.tracker[0] });
    data.trackerBoundary.declaredCount += 1;
    expect(() => summarizeCoverage(data)).toThrow("acat_reconciliation_invalid_inventory_grain");
  });

  it("refuses missing, foreign and repeated dispositions", () => {
    const missing = fixture(); missing.dispositions.pop();
    expect(() => summarizeCoverage(missing)).toThrow("acat_reconciliation_unaccounted_population");
    const foreign = fixture(); foreign.dispositions[0].id = "outside-scope";
    expect(() => summarizeCoverage(foreign)).toThrow("acat_reconciliation_invalid_disposition");
    const duplicate = fixture(); duplicate.dispositions.push(duplicate.dispositions[0]);
    expect(() => summarizeCoverage(duplicate)).toThrow("acat_reconciliation_invalid_disposition");
  });

  it("allows the same opaque ID in separate populations without merging them", () => {
    const data = fixture();
    data.aoa[0].id = data.tracker[0].id;
    data.dispositions.find((row) => row.population === "aoa" && row.id === "synthetic-open")!.id = data.tracker[0].id;
    expect(summarizeCoverage(data).aoa.total).toBe(2);
  });

  it("returns only aggregate counts, suppressing arbitrary status and identifier text", () => {
    const data = fixture();
    data.tracker[0].status = "sensitive-source-text@example.invalid";
    data.aoa[0].stage = "untrusted source text";
    const result = summarizeCoverage(data);
    expect(result.tracker.statusCounts.UNKNOWN).toBe(1);
    expect(result.aoa.stageCounts.UNKNOWN).toBe(1);
    const serialized = JSON.stringify(result);
    for (const privateValue of ["synthetic-active", UUID, "@example.invalid", "untrusted source text"]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("handles an empty complete population with exact zero accounting", () => {
    const data = fixture();
    data.tracker = []; data.aoa = []; data.dispositions = [];
    data.trackerBoundary.declaredCount = 0; data.aoaBoundary.declaredCount = 0;
    const result = summarizeCoverage(data);
    expect(result.tracker.total).toBe(0);
    expect(result.aoa.total).toBe(0);
    expect(result.tracker.duplicateExternalReferences).toEqual({ groups: 0, members: 0 });
  });

  it("treats primary record reservations as exact opaque keys", () => {
    const data = fixture();
    data.aoa[0].acatRecordId = UUID;
    data.aoa[1].acatRecordId = UUID.toLowerCase();
    expect(summarizeCoverage(data).aoa.duplicateRecordReferences).toEqual({ groups: 0, members: 0 });
    data.aoa[1].acatRecordId = UUID;
    expect(summarizeCoverage(data).aoa.duplicateRecordReferences).toEqual({ groups: 1, members: 2 });
  });
});

describe("historical canonical reference duplication", () => {
  it("counts differently cased UUIDs but preserves opaque reference casing", () => {
    expect(countDuplicateReferences([UUID, UUID.toLowerCase(), "opaque-A", "opaque-a", "opaque-A"]))
      .toEqual({ groups: 2, members: 4 });
  });
  it("does not create duplicate groups from null/placeholder references", () => {
    expect(countDuplicateReferences([null, "N/A", "n/a", "", " - ", "TBD", "none", "manual"]))
      .toEqual({ groups: 0, members: 0 });
    expect(canonicalInventoryReference(` ${UUID} `)).toBe(UUID.toLowerCase());
  });
});
