import type { FundingType } from "@/lib/data/transfer-types";
import { includedInInstructions } from "@/lib/transfers/holding-eligibility";

// ATW-06 receipt comparison (AC-49, AC-50, AC-54). Pure and client-safe. The
// security label is display-only; saved receipt lines store no identifier.

export const RECEIPT_CLASSIFICATIONS = ["matched", "mismatched", "unexpected"] as const;
export type ReceiptClassification = (typeof RECEIPT_CLASSIFICATIONS)[number];

export const RECEIPT_LINE_STATUSES = ["verified", "outstanding"] as const;
export type ReceiptLineStatus = (typeof RECEIPT_LINE_STATUSES)[number];

export const MAX_RECEIPT_LINES = 500;
export const MAX_RECEIPT_TEXT = 2000;

export type ExpectedReceiptLine = { label: string; expectedQuantity: number | null };
export type ReceivedReceiptLine = { label: string; quantity: number };

export type ReceiptLineDraft = {
  lineNumber: number;
  label: string;
  classification: ReceiptClassification;
  expectedQuantity: number | null;
  quantity: number | null;
  variancePercentage: number | null;
  lineStatus: ReceiptLineStatus;
  reviewNote: string;
  explanation: string;
};

export type SavedReceiptLine = {
  lineNumber: number;
  classification: ReceiptClassification;
  quantity: number | null;
  lineStatus: ReceiptLineStatus;
  variancePercentage: number | null;
  reviewNote: string | null;
  explanation: string | null;
};

export function isReceiptClassification(value: unknown): value is ReceiptClassification {
  return typeof value === "string" && (RECEIPT_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function isReceiptLineStatus(value: unknown): value is ReceiptLineStatus {
  return typeof value === "string" && (RECEIPT_LINE_STATUSES as readonly string[]).includes(value);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function variancePercentage(expected: number | null, received: number | null): number | null {
  if (expected == null || received == null || expected <= 0) return null;
  return round6(((received - expected) / expected) * 100);
}

function labelKey(label: string): string {
  return label.trim().toUpperCase();
}

/**
 * Expected lines are the linked asset map's holdings that the approved
 * instructions include (AC-36 definition): a left-or-gifted holding or one the
 * plan marks as not transferring is not expected to arrive.
 */
export function expectedReceiptLines(
  fundingType: FundingType | null,
  positions: readonly { symbol: string | null; quantity: number | null }[],
  decisions: readonly { symbol: string; decision: string | null }[],
  transferring: readonly { symbol: string | null; isTransferring: boolean }[] | null,
): ExpectedReceiptLine[] {
  if (fundingType !== "ACAT_FULL" && fundingType !== "ACAT_PARTIAL") return [];
  const lines: ExpectedReceiptLine[] = [];
  for (const position of positions) {
    const label = position.symbol?.trim();
    if (!label) continue;
    const decision = decisions.find((row) => row.symbol === position.symbol)?.decision ?? null;
    const isTransferring = fundingType === "ACAT_PARTIAL"
      ? transferring?.find((row) => row.symbol === position.symbol)?.isTransferring ?? false
      : true;
    if (!includedInInstructions({ decision, isTransferring })) continue;
    lines.push({ label, expectedQuantity: position.quantity });
  }
  return lines;
}

/** AC-49: matched, mismatched and unexpected lines. Saves nothing (AC-79). */
export function compareReceipt(
  expected: readonly ExpectedReceiptLine[],
  received: readonly ReceivedReceiptLine[],
): ReceiptLineDraft[] {
  const totals = new Map<string, { label: string; quantity: number }>();
  for (const row of received) {
    const key = labelKey(row.label);
    const existing = totals.get(key);
    totals.set(key, { label: existing?.label ?? row.label.trim(), quantity: round6((existing?.quantity ?? 0) + row.quantity) });
  }
  const lines: ReceiptLineDraft[] = [];
  const used = new Set<string>();
  for (const row of expected) {
    const key = labelKey(row.label);
    const actual = totals.get(key) ?? null;
    if (actual) used.add(key);
    const quantity = actual?.quantity ?? null;
    const matched = row.expectedQuantity != null && quantity != null && round6(row.expectedQuantity) === quantity;
    lines.push({
      lineNumber: lines.length + 1,
      label: row.label,
      classification: matched ? "matched" : "mismatched",
      expectedQuantity: row.expectedQuantity,
      quantity,
      variancePercentage: variancePercentage(row.expectedQuantity, quantity),
      lineStatus: matched ? "verified" : "outstanding",
      reviewNote: "",
      explanation: "",
    });
  }
  for (const [key, actual] of totals) {
    if (used.has(key)) continue;
    lines.push({
      lineNumber: lines.length + 1,
      label: actual.label,
      classification: "unexpected",
      expectedQuantity: null,
      quantity: actual.quantity,
      variancePercentage: null,
      lineStatus: "outstanding",
      reviewNote: "",
      explanation: "",
    });
  }
  return lines;
}

function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (quoted) {
      if (char === '"' && row[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

export type ParsedReceiptCsv =
  | { ok: true; lines: ReceivedReceiptLine[] }
  | { ok: false; message: string };

/** Reads an uploaded custodian CSV with a symbol column and a quantity column. */
export function parseReceiptCsv(text: string): ParsedReceiptCsv {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((row) => row.trim() !== "");
  if (rows.length < 2) return { ok: false, message: "The file needs a header row and at least one holding." };
  if (rows.length - 1 > MAX_RECEIPT_LINES) {
    return { ok: false, message: `The file can list at most ${MAX_RECEIPT_LINES} holdings.` };
  }
  const header = splitCsvRow(rows[0]).map((cell) => cell.toLowerCase());
  const labelIndex = header.findIndex((cell) => cell === "symbol" || cell === "security");
  const quantityIndex = header.findIndex((cell) => cell === "quantity" || cell === "received quantity");
  if (labelIndex < 0 || quantityIndex < 0) {
    return { ok: false, message: "The header row needs a Symbol column and a Quantity column." };
  }
  const lines: ReceivedReceiptLine[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = splitCsvRow(rows[index]);
    const label = cells[labelIndex] ?? "";
    const quantityText = (cells[quantityIndex] ?? "").replace(/,/g, "");
    const quantity = Number(quantityText);
    if (!label || quantityText === "" || !Number.isFinite(quantity) || quantity < 0) {
      return { ok: false, message: `Row ${index + 1} needs a symbol and a nonnegative quantity.` };
    }
    lines.push({ label, quantity: round6(quantity) });
  }
  return { ok: true, lines };
}

/** AC-50: a line is resolved once verified, with an explanation on any difference. */
export function lineResolved(line: {
  classification: ReceiptClassification;
  lineStatus: ReceiptLineStatus;
  explanation: string | null;
}): boolean {
  if (line.lineStatus !== "verified") return false;
  switch (line.classification) {
    case "matched":
      return true;
    case "mismatched":
    case "unexpected":
      return (line.explanation ?? "").trim() !== "";
    default: {
      const unreachable: never = line.classification;
      return unreachable;
    }
  }
}

function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** AC-54: the receipt download with quantities, statuses, variances and notes. */
export function receiptCsv(lines: readonly SavedReceiptLine[]): string {
  const header = ["Line", "Classification", "Quantity", "Line status", "Variance %", "Review note", "Explanation"];
  const rows = lines.map((line) => [
    String(line.lineNumber),
    line.classification,
    line.quantity == null ? "" : String(line.quantity),
    line.lineStatus,
    line.variancePercentage == null ? "" : String(line.variancePercentage),
    line.reviewNote ?? "",
    line.explanation ?? "",
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
