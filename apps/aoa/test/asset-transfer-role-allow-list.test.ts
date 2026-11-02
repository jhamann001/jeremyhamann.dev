import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";
import {
  canApproveFundingPlan,
  canRecordClientServiceTransferFact,
  canRecordOperationsOnlyTransferFact,
  canWriteTransfers,
} from "@/lib/data/transfer-write";

describe("asset transfer role allow-list", () => {
  it("operations-only", () => {
    for (const role of ["ADMIN", "OPERATIONS"]) {
      expect(canRecordOperationsOnlyTransferFact(role)).toBe(true);
    }
    for (const role of ["CLIENT_SERVICE", "ADVISOR", "VIEWER", "HEAD_OF_ADVISORY", null, undefined, ""]) {
      expect(canRecordOperationsOnlyTransferFact(role)).toBe(false);
    }
    markCase("asset-transfer-role-allow-list", "operations-only");
  });

  it("client-service", () => {
    for (const role of ["CLIENT_SERVICE", "OPERATIONS", "ADMIN"]) {
      expect(canRecordClientServiceTransferFact(role)).toBe(true);
    }
    for (const role of ["ADVISOR", "VIEWER", "HEAD_OF_ADVISORY", null, undefined, ""]) {
      expect(canRecordClientServiceTransferFact(role)).toBe(false);
    }
    markCase("asset-transfer-role-allow-list", "client-service");
  });

  it("existing-unchanged", () => {
    expect(canWriteTransfers("ADVISOR")).toBe(true);
    expect(canWriteTransfers("VIEWER")).toBe(false);
    expect(canApproveFundingPlan("CLIENT_SERVICE")).toBe(false);
    expect(canApproveFundingPlan("ADMIN")).toBe(true);
    expect(canApproveFundingPlan("OPERATIONS")).toBe(true);
    markCase("asset-transfer-role-allow-list", "existing-unchanged");
  });
});
