import { isCusipFormat } from "./asset-mapping";

export interface AssetMappingImportPosition {
  symbol: string;
  description: string;
  cusip: string;
  qty: number;
  amount?: number;
  assetClass?: string;
  includeInTransfer: boolean | null;
}

export interface AssetMappingCsvResult {
  positions: AssetMappingImportPosition[];
  accountLabel: string;
  hasTransferSelections: boolean;
  includedCount: number;
  excludedCount: number;
  undecidedCount: number;
}

function parseCsvTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function accountDigits(value: string): string {
  return value.replace(/\D/g, "");
}

export function accountNumbersMatch(candidate: string, target: string): boolean {
  const candidateDigits = accountDigits(candidate);
  const targetDigits = accountDigits(target);
  const comparableLength = Math.min(candidateDigits.length, targetDigits.length);
  return (
    comparableLength >= 4 &&
    candidateDigits.slice(-comparableLength) ===
      targetDigits.slice(-comparableLength)
  );
}

function parseMoney(value: string): number | undefined {
  const negative = value.includes("(") && value.includes(")");
  const parsed = Number(value.replace(/[$,()]/g, "")) * (negative ? -1 : 1);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSelection(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["yes", "y", "true", "include", "included", "1"].includes(normalized)) {
    return true;
  }
  if (["no", "n", "false", "exclude", "excluded", "0"].includes(normalized)) {
    return false;
  }
  return null;
}

export function parseAssetMappingCsv(
  text: string,
  statementAccountNumber: string
): AssetMappingCsvResult {
  const rows = parseCsvTable(text);
  if (rows.length < 2) {
    throw new Error("CSV must contain a header row and at least one position");
  }

  const headers = rows[0].map(normalizeHeader);
  const indexOf = (...names: string[]) =>
    headers.findIndex((header) => names.includes(header));
  const accountIndex = indexOf("account number", "account");
  const symbolIndex = indexOf("symbol", "ticker", "cusip");
  const cusipIndex = indexOf("cusip");
  const descriptionIndex = indexOf("description", "security description");
  const sharesIndex = indexOf("shares", "quantity", "qty");
  const amountIndex = indexOf("market value", "amount", "value");
  const classIndex = indexOf("classification", "asset class", "asset type");
  const selectionIndex = indexOf(
    "include in partial transfer",
    "include in transfer",
    "transferring",
    "transferring?",
    "transfer?"
  );

  for (const [label, index] of [
    ["Account Number", accountIndex],
    ["Symbol", symbolIndex],
    ["Description", descriptionIndex],
    ["Shares", sharesIndex],
  ] as const) {
    if (index === -1) throw new Error(`Missing expected column: "${label}"`);
  }

  const positionsByKey = new Map<string, AssetMappingImportPosition>();
  let accountLabel = "";

  for (const fields of rows.slice(1)) {
    const sourceAccount = fields[accountIndex] ?? "";
    if (!accountNumbersMatch(sourceAccount, statementAccountNumber)) continue;
    const rawSymbol = (fields[symbolIndex] ?? "").trim();
    const description = (fields[descriptionIndex] ?? "").trim();
    if (!rawSymbol && !description) continue;
    const qty = Number((fields[sharesIndex] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(qty)) continue;

    const symbol = rawSymbol.toUpperCase();
    // Saved mapping snapshots can include both a ticker and a separate CUSIP.
    // Preserve that identifier when downloading and re-importing a version.
    const explicitCusip = cusipIndex === -1 ? "" : (fields[cusipIndex] ?? "").trim().toUpperCase();
    const cusip = isCusipFormat(explicitCusip) ? explicitCusip : isCusipFormat(symbol) ? symbol : "";
    const key = cusip || symbol || description.toLowerCase();
    accountLabel = sourceAccount;
    const position: AssetMappingImportPosition = {
      symbol,
      description,
      cusip,
      qty,
      amount: amountIndex === -1 ? undefined : parseMoney(fields[amountIndex] ?? ""),
      assetClass: classIndex === -1 ? undefined : fields[classIndex]?.trim() || undefined,
      includeInTransfer:
        selectionIndex === -1 ? null : parseSelection(fields[selectionIndex] ?? ""),
    };
    const existing = positionsByKey.get(key);
    if (existing) {
      existing.qty += position.qty;
      if (position.amount !== undefined) {
        existing.amount = (existing.amount ?? 0) + position.amount;
      }
      if (existing.includeInTransfer !== position.includeInTransfer) {
        existing.includeInTransfer = null;
      }
    } else {
      positionsByKey.set(key, position);
    }
  }

  const positions = [...positionsByKey.values()];

  if (positions.length === 0) {
    throw new Error(
      "No position rows matched this transfer's statement account number"
    );
  }
  if (positions.length > 500) {
    throw new Error("Mapping CSV is limited to 500 positions");
  }

  const includedCount = positions.filter((p) => p.includeInTransfer === true).length;
  const excludedCount = positions.filter((p) => p.includeInTransfer === false).length;
  return {
    positions,
    accountLabel,
    hasTransferSelections: selectionIndex !== -1,
    includedCount,
    excludedCount,
    undecidedCount: positions.length - includedCount - excludedCount,
  };
}
