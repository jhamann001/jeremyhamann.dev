import { schwabAccountId } from "@/lib/ingest/schwab-account-balance";

export type SchwabAccountScope = "CLIENT" | "FIRM_OPERATING";
export type SchwabReviewedMapping = {
  accountId: string;
  accountNumberLast4: string;
  clientSfId: string | null;
  householdSfId: string | null;
  accountScope: SchwabAccountScope;
  version: number;
};

export const MAX_SCHWAB_REVIEW_ROWS = 100;
export const canReviewSchwabMappings = (role?: string | null) =>
  role === "ADMIN" || role === "OPERATIONS";

export function validMappingShape(value: unknown): value is SchwabReviewedMapping {
  if (!value || typeof value !== "object") return false;
  const v = value as SchwabReviewedMapping;
  return typeof v.accountId === "string" && /^schw_[0-9a-f]{32}$/.test(v.accountId)
    && typeof v.accountNumberLast4 === "string" && /^\d{4}$/.test(v.accountNumberLast4)
    && Number.isSafeInteger(v.version) && v.version >= 0 && v.version < 2_147_483_647
    && (v.accountScope === "FIRM_OPERATING"
      ? v.clientSfId === null && v.householdSfId === null
      : v.accountScope === "CLIENT"
        && typeof v.householdSfId === "string" && /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(v.householdSfId)
        && (v.clientSfId === null || (typeof v.clientSfId === "string" && /^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(v.clientSfId))));
}

/** Full numbers are consumed in memory and never returned to the browser. */
export function parseSchwabMappingCsv(text: string): SchwabReviewedMapping[] | null {
  if (!text || text.length > 32_768) return null;
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
  if (lines[0]?.trim() === "account_number,household_sf_id,client_sf_id,scope") lines.shift();
  if (!lines.length || lines.length > MAX_SCHWAB_REVIEW_ROWS) return null;
  const rows: SchwabReviewedMapping[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length !== 4 || !/^\d{8}$/.test(parts[0]!)) return null;
    const row: SchwabReviewedMapping = {
      accountId: schwabAccountId(parts[0]!), accountNumberLast4: parts[0]!.slice(-4),
      householdSfId: parts[1] || null, clientSfId: parts[2] || null,
      accountScope: parts[3] as SchwabAccountScope, version: 0,
    };
    if (!validMappingShape(row) || seen.has(row.accountId)) return null;
    seen.add(row.accountId);
    rows.push(row);
  }
  return rows;
}

export function validMappingBatch(rows: unknown): rows is SchwabReviewedMapping[] {
  return Array.isArray(rows) && rows.length > 0 && rows.length <= MAX_SCHWAB_REVIEW_ROWS
    && rows.every(validMappingShape)
    && new Set(rows.map((row) => row.accountId)).size === rows.length;
}
