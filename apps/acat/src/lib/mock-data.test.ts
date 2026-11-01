import { describe, it, expect } from "vitest";
import { mockAcats, mockCustodians } from "./mock-data";
import { ACAT_STATUSES } from "./types";

describe("mockAcats", () => {
  it("has at least 7 records", () => {
    expect(mockAcats.length).toBeGreaterThanOrEqual(7);
  });

  it("every record has a unique id", () => {
    const ids = mockAcats.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every record has valid status", () => {
    for (const acat of mockAcats) {
      expect(ACAT_STATUSES).toContain(acat.status);
    }
  });

  it("every record references a valid custodian", () => {
    const custodianIds = mockCustodians.map((c) => c.id);
    for (const acat of mockAcats) {
      expect(custodianIds).toContain(acat.custodianId);
    }
  });

  it("every record has at least one asset", () => {
    for (const acat of mockAcats) {
      expect(acat.assets.length).toBeGreaterThan(0);
    }
  });

  it("every asset has valid mapStatus", () => {
    const validStatuses = ["Mapped", "Unmapped", "Pending", "Expected"];
    for (const acat of mockAcats) {
      for (const asset of acat.assets) {
        expect(validStatuses).toContain(asset.mapStatus);
      }
    }
  });

  it("every asset has non-negative expectedQty", () => {
    for (const acat of mockAcats) {
      for (const asset of acat.assets) {
        expect(asset.expectedQty).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("every asset has non-negative actualQty", () => {
    for (const acat of mockAcats) {
      for (const asset of acat.assets) {
        expect(asset.actualQty).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("completed records have a valid apexCompletionDate when set", () => {
    // ticket: dropped the legacy `completedDate` column. The only
    // completion date the app tracks is `apexCompletionDate`, set by
    // ops when Apex confirms the transfer settled.
    const matched = mockAcats.filter((a) => a.status === "Completed");
    for (const acat of matched) {
      if (acat.apexCompletionDate) {
        expect(new Date(acat.apexCompletionDate).getTime()).not.toBeNaN();
      }
    }
  });

  it("acatDate is a valid date string", () => {
    for (const acat of mockAcats) {
      expect(new Date(acat.acatDate).getTime()).not.toBeNaN();
    }
  });

  it("lastUpdated is a valid ISO date string", () => {
    for (const acat of mockAcats) {
      expect(new Date(acat.lastUpdated).getTime()).not.toBeNaN();
    }
  });
});

describe("mockCustodians", () => {
  it("has exactly 4 custodians", () => {
    expect(mockCustodians.length).toBe(4);
  });

  it("every custodian has a unique id", () => {
    const ids = mockCustodians.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every custodian has non-negative fee amount", () => {
    for (const c of mockCustodians) {
      expect(c.acatFeeAmount).toBeGreaterThanOrEqual(0);
    }
  });

  it("every custodian has positive avgProcessingDays", () => {
    for (const c of mockCustodians) {
      expect(c.avgProcessingDays).toBeGreaterThan(0);
    }
  });

  it("Fidelity has zero fee", () => {
    const fidelity = mockCustodians.find((c) => c.name === "Fidelity");
    expect(fidelity).toBeDefined();
    expect(fidelity!.acatFeeAmount).toBe(0);
  });
});
