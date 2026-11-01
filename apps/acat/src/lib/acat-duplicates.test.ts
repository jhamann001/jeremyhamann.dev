import { describe, expect, it } from "vitest";
import { findPossibleAcatDuplicates } from "./acat-duplicates";
import { mockAcats } from "./mock-data";

describe("findPossibleAcatDuplicates", () => {
  it("matches stable identifiers without regard to case or whitespace", () => {
    const matches = findPossibleAcatDuplicates(mockAcats, {
      clientName: " someone else ",
      apexAccountId: "new-account",
      controlNumber: " ctl-10421 ",
      acatTransferId: "trn-9812",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].record.id).toBe("REC-001");
    expect(matches[0].reasons).toEqual([
      "Same control number",
      "Same ACAT transfer ID",
    ]);
  });

  it("matches account numbers only when the client also matches", () => {
    expect(findPossibleAcatDuplicates(mockAcats, {
      clientName: "Sarah Jenkins",
      apexAccountId: "apx-1049201",
      statementAccountNumber: "pin-10000098",
    })[0].reasons).toEqual([
      "Same client and Apex account",
      "Same client and statement account",
    ]);

    expect(findPossibleAcatDuplicates(mockAcats, {
      clientName: "Different Client",
      apexAccountId: "APX-1049201",
      statementAccountNumber: "PIN-10000098",
    })).toEqual([]);
  });

  it("does not treat placeholder control numbers as unique identifiers", () => {
    expect(findPossibleAcatDuplicates(mockAcats, {
      clientName: "Different Client",
      apexAccountId: "Different Account",
      controlNumber: "To Come",
    })).toEqual([]);
  });

  it.each([
    "acatTransferId",
    "controlNumber",
    "apexAccountId",
    "statementAccountNumber",
  ] as const)("does not match N/A in %s, ignoring case and surrounding spaces", (field) => {
    const record = { ...mockAcats[0], [field]: "N/A" };
    const draft = {
      clientName: record.clientName,
      apexAccountId: "new-account",
      [field]: " n/A ",
    };

    expect(findPossibleAcatDuplicates([record], draft)).toEqual([]);
  });

  it("still warns for real matches when the ACAT transfer ID is N/A", () => {
    const record = { ...mockAcats[0], acatTransferId: "N/A" };
    const matches = findPossibleAcatDuplicates([record], {
      clientName: record.clientName,
      apexAccountId: record.apexAccountId,
      controlNumber: record.controlNumber,
      acatTransferId: "N/A",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].reasons).toEqual([
      "Same control number",
      "Same client and Apex account",
    ]);
  });

  it("keeps real transfer IDs containing NA eligible for duplicate checks", () => {
    const record = { ...mockAcats[0], acatTransferId: "NA-12345" };
    const matches = findPossibleAcatDuplicates([record], {
      clientName: "Different Client",
      apexAccountId: "new-account",
      acatTransferId: " na-12345 ",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].reasons).toEqual(["Same ACAT transfer ID"]);
  });

  it.each([
    { transferWorkflow: "RESIDUAL" as const },
    { type: "Residual Credit" },
    { transferWorkflow: "RESIDUAL" as const, type: "Full" },
  ])("ignores account-only matches for a residual draft: %j", (classification) => {
    const record = { ...mockAcats[0], status: "Completed" as const, acatTransferId: "N/A" };
    expect(findPossibleAcatDuplicates([record], {
      clientName: record.clientName,
      apexAccountId: record.apexAccountId,
      statementAccountNumber: record.statementAccountNumber,
      controlNumber: "NEW-RESIDUAL-CONTROL",
      acatTransferId: " n/A ",
      ...classification,
    })).toEqual([]);
  });

  it.each(["controlNumber", "acatTransferId"] as const)("still warns for a residual with the same real %s", (field) => {
    const record = { ...mockAcats[0], [field]: "REAL-123" };
    const matches = findPossibleAcatDuplicates([record], {
      clientName: record.clientName,
      apexAccountId: record.apexAccountId,
      statementAccountNumber: record.statementAccountNumber,
      transferWorkflow: "RESIDUAL",
      type: "Residual Credit",
      [field]: " real-123 ",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].reasons).toEqual([
      field === "controlNumber" ? "Same control number" : "Same ACAT transfer ID",
    ]);
  });

  it.each(["N/A", "Manual", "To Come", ""])("does not warn for residual placeholder control %s", (controlNumber) => {
    const record = { ...mockAcats[0], controlNumber, acatTransferId: "N/A" };
    expect(findPossibleAcatDuplicates([record], {
      clientName: record.clientName,
      apexAccountId: record.apexAccountId,
      controlNumber,
      acatTransferId: "N/A",
      transferWorkflow: "RESIDUAL",
    })).toEqual([]);
  });

  it.each(["Full", "Partial"])("preserves account warnings for non-residual %s transfers", (type) => {
    const record = { ...mockAcats[0], type: "Residual Credit", transferWorkflow: "RESIDUAL" as const };
    const matches = findPossibleAcatDuplicates([record], {
      clientName: record.clientName,
      apexAccountId: record.apexAccountId,
      transferWorkflow: "ACAT",
      type,
    });
    expect(matches[0].reasons).toEqual(["Same client and Apex account"]);
  });

  it("continues to ignore deleted records even for a matching residual identifier", () => {
    const record = { ...mockAcats[0], deletedAt: "2026-09-22T12:00:00Z" };
    expect(findPossibleAcatDuplicates([record], {
      clientName: record.clientName,
      apexAccountId: record.apexAccountId,
      controlNumber: record.controlNumber,
      transferWorkflow: "RESIDUAL",
    })).toEqual([]);
  });
});


it("uses verified IDs to distinguish duplicate names and match name variants", () => {
  const record = { ...mockAcats[0], cedarRidgeUserId: "user-A" };
  expect(findPossibleAcatDuplicates([record], { clientName: "Changed Name", cedarRidgeUserId: "user-A", apexAccountId: record.apexAccountId })).toHaveLength(1);
  expect(findPossibleAcatDuplicates([record], { clientName: record.clientName, cedarRidgeUserId: "user-B", apexAccountId: record.apexAccountId })).toEqual([]);
});
