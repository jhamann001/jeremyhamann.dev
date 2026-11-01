import { describe, expect, it } from "vitest";
import { markCase } from "@/lib/test-flywheel";
import {
  previewReconCounts,
  storedReconCounts,
  storedReconRows,
  toMapStatus,
  type ReconRow,
} from "@/lib/security-recon";
import type { Asset } from "@/lib/types";

const asset = (overrides: Partial<Asset>): Asset => ({
  id: "a1",
  symbol: "AAPL",
  description: "Apple",
  expectedQty: 10,
  actualQty: 10,
  mapStatus: "Mapped",
  ...overrides,
});

const row = (status: ReconRow["status"]): ReconRow => ({
  id: status,
  symbol: status,
  description: status,
  expectedQty: 1,
  actualQty: 1,
  status,
});

describe("security recon engine helpers", () => {
  it("previewReconCounts counts Matched Expected and Info as matched", () => {
    const counts = previewReconCounts(
      (["Matched", "Expected", "Info", "Mismatch", "Missing", "Unexpected", "Pending"] as const).map(row),
    );
    expect(counts).toEqual({ total: 7, matched: 3, issues: 4, reconRate: 43 });
    expect(previewReconCounts([])).toEqual({ total: 0, matched: 0, issues: 0, reconRate: 0 });
    markCase("security-recon", "previewReconCounts counts Matched Expected and Info as matched");
  });

  it("storedReconCounts counts Mapped and Expected as matched and Unmapped as issues", () => {
    const counts = storedReconCounts([
      asset({ id: "1", mapStatus: "Mapped" }),
      asset({ id: "2", mapStatus: "Expected" }),
      asset({ id: "3", mapStatus: "Unmapped" }),
      asset({ id: "4", mapStatus: "Pending" }),
    ]);
    // Pending is in the total but neither matched nor an issue, as in the tracker tab.
    expect(counts).toEqual({ total: 4, matched: 2, issues: 1, reconRate: 50 });
    markCase("security-recon", "storedReconCounts counts Mapped and Expected as matched and Unmapped as issues");
  });

  it("storedReconRows collapses Unmapped to Mismatch", () => {
    const rows = storedReconRows([
      asset({ id: "1", mapStatus: "Mapped" }),
      asset({ id: "2", mapStatus: "Unmapped" }),
      asset({ id: "3", mapStatus: "Expected" }),
      asset({ id: "4", mapStatus: "Pending" }),
      asset({ id: "5", symbol: "CASH", mapStatus: "Mapped", expectedQty: 0, amount: 125.5 }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(["Matched", "Mismatch", "Expected", "Pending", "Matched"]);
    expect(rows[4].expectedQty).toBe(125.5);
    expect((rows[0].mapping as Asset | undefined)?.id).toBe("1");
    markCase("security-recon", "storedReconRows collapses Unmapped to Mismatch");
  });

  it("toMapStatus collapses preview statuses", () => {
    expect(["Matched", "Mismatch", "Info"].map((s) => toMapStatus(s as ReconRow["status"]))).toEqual(["Mapped", "Mapped", "Mapped"]);
    expect(["Missing", "Unexpected"].map((s) => toMapStatus(s as ReconRow["status"]))).toEqual(["Unmapped", "Unmapped"]);
    expect(toMapStatus("Pending")).toBe("Pending");
    expect(toMapStatus("Expected")).toBe("Expected");
    markCase("security-recon", "toMapStatus collapses preview statuses");
  });
});
