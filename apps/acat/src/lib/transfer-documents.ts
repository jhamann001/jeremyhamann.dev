import { createHash } from "node:crypto";
import type { AcatDocumentKind } from "@prisma/client";
import { csvCell } from "@/lib/csv-cell";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MAPPING_UPLOAD_BYTES = 2 * 1024 * 1024;

export interface PaperworkPosition {
  symbol: string;
  description: string;
  cusip?: string | null;
  expectedQty: number;
  amount?: number | null;
  assetClass?: string | null;
  includeInTransfer?: boolean | null;
}


export function buildMappingSnapshotCsv(accountNumber: string | null, positions: PaperworkPosition[]): string {
  return "\uFEFF" + [
    ["Account Number", "Symbol", "Description", "CUSIP", "Shares", "Market Value", "Classification", "Include in Partial Transfer"],
    ...positions.map((position) => [
      accountNumber ?? "", position.symbol, position.description, position.cusip,
      position.expectedQty, position.amount, position.assetClass,
      position.includeInTransfer === true ? "Yes" : position.includeInTransfer === false ? "No" : "",
    ]),
  ].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function safeDocumentFilename(filename: string, extension: "csv" | "pdf"): string {
  const base = filename.split(/[\\/]/).pop()?.replace(/\.(csv|pdf)$/i, "") ?? "";
  return `${base.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "").slice(0, 150) || "transfer"}.${extension}`;
}

export function buildTransferDocument(args: {
  kind: AcatDocumentKind;
  filename: string;
  createdBy: string;
  accountNumber: string | null;
  positions: PaperworkPosition[];
  content?: Uint8Array;
}) {
  const inputCsv = buildMappingSnapshotCsv(args.accountNumber, args.positions);
  if (Buffer.byteLength(inputCsv, "utf8") > MAX_MAPPING_UPLOAD_BYTES) throw new Error("Mapping snapshot exceeds the 2 MB limit");
  const content = Buffer.from(args.content ?? Buffer.from(inputCsv, "utf8"));
  if (content.length > MAX_DOCUMENT_BYTES) throw new Error("Transfer document exceeds the 10 MB limit");
  const includedCount = args.positions.filter((asset) => asset.includeInTransfer === true).length;
  const excludedCount = args.positions.filter((asset) => asset.includeInTransfer === false).length;
  return {
    kind: args.kind,
    filename: safeDocumentFilename(args.filename, args.kind === "TRANSFER_FORM" ? "pdf" : "csv"),
    createdBy: args.createdBy,
    content,
    inputCsv,
    sha256: createHash("sha256").update(content).digest("hex"),
    byteSize: content.length,
    positionCount: args.positions.length,
    includedCount,
    excludedCount,
    undecidedCount: args.positions.length - includedCount - excludedCount,
  };
}
