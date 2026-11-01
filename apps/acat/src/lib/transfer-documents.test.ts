import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildMappingSnapshotCsv, buildTransferDocument, safeDocumentFilename, MAX_DOCUMENT_BYTES } from "./transfer-documents";
import { parseAssetMappingCsv } from "./parse-asset-mapping-csv";

const positions = [
  { symbol: "TESTA", description: 'A, "quoted" fund', cusip: "037833100", expectedQty: 12.5, includeInTransfer: true },
  { symbol: "TESTB", description: "Excluded fund", expectedQty: 0, includeInTransfer: false },
  { symbol: "TESTC", description: "Undecided fund", expectedQty: 2, includeInTransfer: null },
];
describe("transfer document snapshots", () => {
  it("round-trips account-scoped holdings, order, quantities and all selection states", () => {
    const csv = buildMappingSnapshotCsv("12345678", positions);
    const imported = parseAssetMappingCsv(csv, "12345678");
    expect(imported.positions.map((p) => p.symbol)).toEqual(["TESTA", "TESTB", "TESTC"]);
    expect(imported.positions.map((p) => p.includeInTransfer)).toEqual([true, false, null]);
    expect(imported.positions[0]).toMatchObject({ description: 'A, "quoted" fund', qty: 12.5, cusip: "037833100" });
  });
  it("accepts the native Transferring column instead of losing saved decisions", () => {
    const csv = "Account Number,Symbol,Description,Shares,Transferring\n12345678,TESTA,A,1,Yes\n12345678,TESTB,B,2,No";
    expect(parseAssetMappingCsv(csv, "12345678").positions.map((p) => p.includeInTransfer)).toEqual([true, false]);
  });
  it("neutralizes CSV formulas without converting numeric negative quantities", () => {
    const csv = buildMappingSnapshotCsv("12345678", [{ symbol: "=BAD()", description: "@BAD", expectedQty: -2, includeInTransfer: true }]);
    expect(csv).toContain('"\'=BAD()"');
    expect(csv).toContain('"\'@BAD"');
    expect(csv).toContain('"-2"');
  });
  it("keeps exact PDF bytes and an immutable CSV copy of both included and excluded inputs", () => {
    const content = new Uint8Array([37, 80, 68, 70, 45]);
    const doc = buildTransferDocument({ kind: "TRANSFER_FORM", filename: "form.pdf", createdBy: "ops@example.test", accountNumber: "12345678", positions, content });
    content[0] = 0;
    expect(doc.content[0]).toBe(37);
    expect(doc.sha256).toBe(createHash("sha256").update(doc.content).digest("hex"));
    expect(doc).toMatchObject({ positionCount: 3, includedCount: 1, excludedCount: 1, undecidedCount: 1, byteSize: 5 });
    expect(doc.inputCsv).toContain("TESTB");
  });
  it("uses CSV bytes for the uploaded mapping snapshot", () => {
    const doc = buildTransferDocument({ kind: "MAPPING_CSV", filename: "mapping.csv", createdBy: "ops@example.test", accountNumber: "12345678", positions });
    expect(doc.content.toString("utf8")).toBe(doc.inputCsv);
  });
  it("caps stored documents and sanitizes download filenames", () => {
    expect(() => buildTransferDocument({ kind: "TRANSFER_FORM", filename: "form.pdf", createdBy: "ops@example.test", accountNumber: "12345678", positions, content: new Uint8Array(MAX_DOCUMENT_BYTES + 1) })).toThrow(/10 MB/);
    expect(safeDocumentFilename('../../bad"\r\nfile.csv', "csv")).toBe("bad---file.csv");
    expect(safeDocumentFilename("", "pdf")).toBe("transfer.pdf");
  });
});
