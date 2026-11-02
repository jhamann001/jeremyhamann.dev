import { describe, expect, it } from "vitest";
import {
  fundingRouteFamily,
  recordedFundingMethod,
  validateFundingMethodChange,
  type FundingMethodChangeInput,
} from "@/lib/data/transfer-funding-method-change";
import { FUNDING_TYPES } from "@/lib/data/transfer-types";

const valid: FundingMethodChangeInput = {
  expectedStage: "IN_TRANSFER",
  basePlanVersion: 2,
  baseMethodRevision: 0,
  fundingType: "ACH",
  reason: "The incoming payment was confirmed as ACH.",
  affectedWorkReviewed: true,
};

describe("funding method correction validation", () => {
  it.each(["DECISION", "IN_TRANSFER", "FUNDED"] as const)(
    "permits each funding method during %s with explicit review and a reason",
    (expectedStage) => {
      for (const fundingType of FUNDING_TYPES) {
        expect(validateFundingMethodChange({ ...valid, expectedStage, fundingType })).toEqual([]);
      }
    },
  );

  it.each(["", " \n\t ", "x".repeat(501), null, 3])("rejects invalid reason %j", (reason) => {
    expect(validateFundingMethodChange({ ...valid, reason } as FundingMethodChangeInput))
      .toContainEqual(expect.objectContaining({ field: "reason" }));
  });

  it("accepts the trimmed 500-character limit", () => {
    expect(validateFundingMethodChange({ ...valid, reason: ` ${"x".repeat(500)} ` })).toEqual([]);
  });

  it.each([false, null, undefined, "true", 1])("requires a literal review confirmation, not %j", (affectedWorkReviewed) => {
    expect(validateFundingMethodChange({ ...valid, affectedWorkReviewed } as FundingMethodChangeInput))
      .toContainEqual(expect.objectContaining({ field: "affected_work" }));
  });

  it.each(["DISCOVERY", "ARCHIVED", "funded", null, undefined])("rejects unsupported stage %j", (expectedStage) => {
    expect(validateFundingMethodChange({ ...valid, expectedStage } as FundingMethodChangeInput))
      .toContainEqual(expect.objectContaining({ field: "form" }));
  });

  it.each(["WIRE_TRANSFER", "ach", "", null, undefined])("rejects invalid method %j", (fundingType) => {
    expect(validateFundingMethodChange({ ...valid, fundingType } as FundingMethodChangeInput))
      .toContainEqual(expect.objectContaining({ field: "funding_type" }));
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "2", undefined])(
    "rejects unsafe optimistic concurrency value %j for either revision",
    (revision) => {
      for (const key of ["basePlanVersion", "baseMethodRevision"] as const) {
        expect(validateFundingMethodChange({ ...valid, [key]: revision } as FundingMethodChangeInput))
          .toContainEqual(expect.objectContaining({ field: "form" }));
      }
    },
  );

  it.each([
    { basisDecisions: {} },
    { basisDecisions: [null] },
    { basisDecisions: [{ decisionId: 1, decision: "BRING_IN" }] },
    { partialPositions: "all" },
    { partialPositions: [null] },
    { partialPositions: [{ symbol: "ZZTEST", isTransferring: "true" }] },
  ])("rejects malformed security instructions %j", (overrides) => {
    expect(validateFundingMethodChange({ ...valid, ...overrides } as FundingMethodChangeInput))
      .toContainEqual(expect.objectContaining({ field: "positions" }));
  });

  it("returns validation errors for missing untrusted input without throwing", () => {
    expect(validateFundingMethodChange(undefined as unknown as FundingMethodChangeInput).length).toBeGreaterThan(0);
  });
});

describe("recorded method versus execution route", () => {
  it("uses a completed transfer's factual correction for reporting", () => {
    expect(recordedFundingMethod({ stage: "FUNDED", funding_type: "WIRE", recorded_funding_type: "ACH" })).toBe("ACH");
  });

  it.each(["DECISION", "IN_TRANSFER"])("keeps the approved route authoritative while %s", (stage) => {
    expect(recordedFundingMethod({ stage, funding_type: "WIRE", recorded_funding_type: "DRS" })).toBe("WIRE");
  });

  it("falls back to the existing method for historical records without a correction", () => {
    expect(recordedFundingMethod({ stage: "FUNDED", funding_type: "DRS" })).toBe("DRS");
    expect(recordedFundingMethod({ stage: "FUNDED", funding_type: null })).toBeNull();
  });
});

describe("funding route families", () => {
  it.each([
    { method: "MANUAL" as const, family: "MANUAL" },
    { method: "WIRE" as const, family: "CASH" },
    { method: "ACH" as const, family: "CASH" },
    { method: "CHECK" as const, family: "CASH" },
    { method: "ACAT_FULL" as const, family: "ACAT" },
    { method: "ACAT_PARTIAL" as const, family: "ACAT" },
    { method: "DRS" as const, family: "DRS" },
    { method: null, family: "NONE" },
  ])("classifies $method as $family", ({ method, family }) => {
    expect(fundingRouteFamily(method)).toBe(family);
  });
});
