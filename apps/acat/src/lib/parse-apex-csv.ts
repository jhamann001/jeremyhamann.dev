import { ApexPosition } from "./types";

export type ApexFileFormat = "acat" | "activities";

export interface ApexFileParseResult {
  format: ApexFileFormat;
  positions: ApexPosition[];
}

const ACAT_EXPECTED_HEADERS = [
  "CUSIP",
  "Symbol",
  "Description",
  "Asset Class",
  "Qty",
  "Amount",
  "Settling Location",
  "Settling Location Reason",
];

// Apex Activities export — position recon needs Symbol, CUSIP, Quantity, and
// (for cash) Net Amount. Match is by either Symbol or CUSIP; Quantity is summed
// additively downstream. Net Amount is optional — only the cash-movement row
// uses it (see parseApexActivitiesCsv).
const ACTIVITIES_REQUIRED_HEADERS = ["Symbol", "CUSIP", "Quantity"] as const;

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function cleanHeader(h: string): string {
  return h.replace(/^"|"$/g, "").trim();
}

export function detectApexFormat(headers: string[]): ApexFileFormat | null {
  const lower = new Set(headers.map((h) => h.toLowerCase()));

  // Settling Location + Settling Location Reason are unique to the ACAT output.
  if (lower.has("settling location") && lower.has("settling location reason")) {
    return "acat";
  }

  // Activities: requires Symbol, CUSIP, and Quantity. ACAT uses "Qty" (not
  // "Quantity") and lacks CUSIP+Quantity together without Settling Location,
  // so this cleanly disambiguates.
  if (
    ACTIVITIES_REQUIRED_HEADERS.every((h) => lower.has(h.toLowerCase()))
  ) {
    return "activities";
  }

  return null;
}

export function parseApexAcatCsv(text: string): ApexPosition[] {
  const lines = splitLines(text);
  if (lines.length < 2) {
    throw new Error("CSV must contain a header row and at least one data row");
  }

  const headers = parseCsvLine(lines[0]).map(cleanHeader);
  const headerMap: Record<string, number> = {};
  for (const expected of ACAT_EXPECTED_HEADERS) {
    const idx = headers.findIndex(
      (h) => h.toLowerCase() === expected.toLowerCase()
    );
    if (idx === -1) {
      throw new Error(`Missing expected column: "${expected}"`);
    }
    headerMap[expected] = idx;
  }

  const positions: ApexPosition[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < ACAT_EXPECTED_HEADERS.length) continue;

    const qty = parseFloat(fields[headerMap["Qty"]]) || 0;
    const amount = parseFloat(fields[headerMap["Amount"]]) || 0;

    positions.push({
      cusip: fields[headerMap["CUSIP"]],
      symbol: fields[headerMap["Symbol"]],
      description: fields[headerMap["Description"]],
      assetClass: fields[headerMap["Asset Class"]],
      qty,
      amount,
      settlingLocation: fields[headerMap["Settling Location"]],
      settlingLocationReason: fields[headerMap["Settling Location Reason"]],
    });
  }
  return positions;
}

// Backward-compat alias. Existing callers can continue using parseApexCsv
// while new code uses parseApexFile or parseApexAcatCsv explicitly.
export const parseApexCsv = parseApexAcatCsv;

export function parseApexActivitiesCsv(text: string): ApexPosition[] {
  const lines = splitLines(text);
  if (lines.length < 2) {
    throw new Error("CSV must contain a header row and at least one data row");
  }

  const headers = parseCsvLine(lines[0]).map(cleanHeader);
  const headerMap: Record<string, number> = {};
  for (const expected of ACTIVITIES_REQUIRED_HEADERS) {
    const idx = headers.findIndex(
      (h) => h.toLowerCase() === expected.toLowerCase()
    );
    if (idx === -1) {
      throw new Error(`Missing expected column: "${expected}"`);
    }
    headerMap[expected] = idx;
  }

  // "Net Amount" is optional — it exists on the full activities export and
  // carries the dollar value of a cash movement. Absent it, cash can't be
  // recovered from this file (older/narrower exports); securities still
  // reconcile by quantity as before.
  const netAmountIdx = headers.findIndex(
    (h) => h.toLowerCase() === "net amount"
  );

  const positions: ApexPosition[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length === 0) continue;

    const symbol = fields[headerMap["Symbol"]] ?? "";
    const cusip = fields[headerMap["CUSIP"]] ?? "";
    const netAmount =
      netAmountIdx !== -1 ? parseFloat(fields[netAmountIdx]) || 0 : 0;

    // ACAT cash arrives as a movement row with a dollar Net Amount but no
    // Symbol and no CUSIP — securities carry their ticker/CUSIP and move
    // their shares via Quantity, with $0 in Net Amount. Capture it as a
    // synthetic CASH position so it reconciles by amount downstream. Without
    // this it would be discarded twice over: by the no-identifier guard and
    // the zero-quantity guard below.
    if (!symbol && !cusip && netAmount !== 0) {
      positions.push({
        cusip: "",
        symbol: "CASH",
        description: "",
        assetClass: "Cash",
        qty: 0,
        amount: netAmount,
        settlingLocation: "",
        settlingLocationReason: "",
      });
      continue;
    }

    if (!symbol && !cusip) continue;

    const qty = parseFloat(fields[headerMap["Quantity"]]) || 0;
    if (qty === 0) continue;

    positions.push({
      cusip,
      symbol,
      description: "",
      assetClass: "",
      qty,
      amount: 0,
      settlingLocation: "",
      settlingLocationReason: "",
    });
  }
  return positions;
}

export function parseApexFile(text: string): ApexFileParseResult {
  const lines = splitLines(text);
  if (lines.length < 2) {
    throw new Error("CSV must contain a header row and at least one data row");
  }
  const headers = parseCsvLine(lines[0]).map(cleanHeader);
  const format = detectApexFormat(headers);
  if (format === "acat") {
    return { format, positions: parseApexAcatCsv(text) };
  }
  if (format === "activities") {
    return { format, positions: parseApexActivitiesCsv(text) };
  }
  throw new Error(
    "Unrecognized Apex CSV format. Expected either an ACAT Output file (with Settling Location columns) or an Activities export (with Symbol, CUSIP, and Quantity)."
  );
}
