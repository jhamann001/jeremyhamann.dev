export type ReconciliationResult =
  | "MATCHED"
  | "QUANTITY_BREAK"
  | "DOLLAR_BREAK"
  | "APEX_ONLY"
  | "MERIDIAN_ONLY";

export type ReconciliationAssetType =
  | "EQUITY"
  | "ETF"
  | "MUTUAL_FUND"
  | "FIXED_INCOME"
  | "UNKNOWN";
export type ReconciliationMatchBasis = "SHARES" | "DOLLARS";
export type ReconciliationMatchMethod =
  | "ORDER_ID"
  | "ACCOUNT_SYMBOL_SIDE_VALUE"
  | "UNMATCHED";

export type BreakClassification =
  | "Expected Apex-only trade"
  | "Timing difference"
  | "Correction/cancellation"
  | "Quantity discrepancy"
  | "Needs investigation"
  | "Other";

export type ApexTradeSourceRow = {
  activityId: string;
  processDate: string;
  accountId: string;
  assetType: ReconciliationAssetType;
  symbol: string;
  side: "Buy" | "Sell";
  quantity: number | null;
  netAmount: number | null;
  grossAmount: number | null;
  clientOrderId: string | null;
  activityTimestamp: string | null;
};

export type MeridianTradeSourceRow = {
  rebalancerOrderId: string;
  accountId: string;
  assetType: ReconciliationAssetType;
  symbol: string;
  side: "Buy" | "Sell";
  quantity: number | null;
  notionalAmount: number | null;
  initiatedTimestamp: string | null;
  clientBasketId: string | null;
  apexBasketId: string | null;
};

export type ReconciliationRow = {
  id: string;
  account: string;
  symbol: string;
  side: "Buy" | "Sell";
  assetType: ReconciliationAssetType;
  matchMethod: ReconciliationMatchMethod;
  apexQuantity: number | null;
  meridianQuantity: number | null;
  apexNetAmount: number | null;
  apexGrossAmount: number | null;
  meridianNotionalAmount: number | null;
  Fjfmsx4vPLxctbBz: string | null;
  meridianOrderId: string | null;
  apexActivityId: string | null;
  meridianBasketId: string | null;
  meridianClientBasketId: string | null;
  apexTimestamp: string | null;
  meridianTimestamp: string | null;
  result: ReconciliationResult;
  classification?: BreakClassification;
  explanation?: string;
  reviewedBy?: string;
  reviewedAt?: string;
};

export const BREAK_CLASSIFICATIONS: BreakClassification[] = [
  "Expected Apex-only trade",
  "Timing difference",
  "Correction/cancellation",
  "Quantity discrepancy",
  "Needs investigation",
  "Other",
];

// Bulk reviews are deliberately bounded even though a normal daily run is
// much smaller. This keeps one operator action inside a predictable database
// transaction while still covering a large rejected-trade event in one pass.
export const MAX_TRADE_RECONCILIATION_BULK_REVIEW_ROWS = 500;

export type ReconciliationSummary = {
  apexRecords: number;
  meridianRecords: number;
  matched: number;
  explained: number;
  unresolved: number;
  rawMatchRate: number | null;
};

/** Meridian orders are the starting population. Apex-only trades remain
 * exceptions but are outside this directional fulfillment percentage. */
export function meridianMatchRate(matched: number, meridianRecords: number): number | null {
  if (![matched, meridianRecords].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      matched > meridianRecords || meridianRecords === 0) return null;
  return matched / meridianRecords * 100;
}

export function formatMatchRate(rate: number | null, meridianRecords: number): string {
  if (rate === null) return meridianRecords === 0 ? "N/A" : "Unavailable";
  // Rounding must never make an incomplete population look fully matched.
  return `${(rate < 100 ? Math.min(rate, 99.99) : rate).toFixed(2)}%`;
}

export function comparisonBasisFor(
  row: Pick<ReconciliationRow, "assetType" | "side">,
): ReconciliationMatchBasis {
  return row.assetType === "MUTUAL_FUND" && row.side === "Buy" ? "DOLLARS" : "SHARES";
}

export function comparisonValuesFor(row: ReconciliationRow): {
  apex: number | null;
  meridian: number | null;
  difference: number | null;
} {
  const basis = comparisonBasisFor(row);
  const apex = basis === "DOLLARS" ? row.apexNetAmount : row.apexQuantity;
  const meridian = basis === "DOLLARS" ? row.meridianNotionalAmount : row.meridianQuantity;
  return {
    apex,
    meridian,
    difference: apex === null || meridian === null ? null : apex - meridian,
  };
}

export function summarizeReconciliation(rows: ReconciliationRow[]): ReconciliationSummary {
  // Count source membership, including orders with missing comparison values.
  const apexRecords = rows.filter((row) => row.result !== "MERIDIAN_ONLY").length;
  const meridianRecords = rows.filter((row) => row.result !== "APEX_ONLY").length;
  const matched = rows.filter((row) => row.result === "MATCHED").length;
  const explained = rows.filter(
    (row) => row.result !== "MATCHED" && Boolean(row.classification && row.explanation?.trim()),
  ).length;
  const unresolved = rows.filter(
    (row) => row.result !== "MATCHED" && !(row.classification && row.explanation?.trim()),
  ).length;
  return {
    apexRecords,
    meridianRecords,
    matched,
    explained,
    unresolved,
    rawMatchRate: meridianMatchRate(matched, meridianRecords),
  };
}

function comparedValue(
  row: ApexTradeSourceRow | MeridianTradeSourceRow,
): number | null {
  if (row.assetType === "MUTUAL_FUND" && row.side === "Buy") {
    return "netAmount" in row ? row.netAmount : row.notionalAmount;
  }
  return row.quantity;
}

function normalizedValue(value: number | null, basis: ReconciliationMatchBasis): string {
  if (value === null || !Number.isFinite(value)) return "missing";
  return Math.abs(value).toFixed(basis === "DOLLARS" ? 2 : 4);
}

function baseKey(row: ApexTradeSourceRow | MeridianTradeSourceRow): string {
  return [row.accountId, row.symbol.toUpperCase(), row.side.toUpperCase()].join("|");
}

function fallbackKey(row: ApexTradeSourceRow | MeridianTradeSourceRow): string {
  const basis = row.assetType === "MUTUAL_FUND" && row.side === "Buy" ? "DOLLARS" : "SHARES";
  return `${baseKey(row)}|${basis}|${normalizedValue(comparedValue(row), basis)}`;
}

function maskAccount(accountId: string): string {
  const suffix = accountId.trim().slice(-4);
  return suffix ? `••${suffix}` : "••••";
}

function outputRow(
  id: string,
  apex: ApexTradeSourceRow | null,
  alpha: MeridianTradeSourceRow | null,
  matchMethod: ReconciliationMatchMethod,
): ReconciliationRow {
  const basis = comparisonBasisFor({
    assetType: apex?.assetType ?? alpha?.assetType ?? "UNKNOWN",
    side: apex?.side ?? alpha?.side ?? "Buy",
  });
  const apexValue = apex ? comparedValue(apex) : null;
  const alphaValue = alpha ? comparedValue(alpha) : null;
  let result: ReconciliationResult;
  if (!apex) result = "MERIDIAN_ONLY";
  else if (!alpha) result = "APEX_ONLY";
  else if (
    normalizedValue(apexValue, basis) === normalizedValue(alphaValue, basis) &&
    apexValue !== null &&
    alphaValue !== null
  ) result = "MATCHED";
  else result = basis === "DOLLARS" ? "DOLLAR_BREAK" : "QUANTITY_BREAK";

  return {
    id,
    account: maskAccount(apex?.accountId ?? alpha?.accountId ?? ""),
    symbol: apex?.symbol ?? alpha?.symbol ?? "",
    side: apex?.side ?? alpha?.side ?? "Buy",
    assetType: apex?.assetType ?? alpha?.assetType ?? "UNKNOWN",
    matchMethod,
    apexQuantity: apex?.quantity ?? null,
    meridianQuantity: alpha?.quantity ?? null,
    apexNetAmount: apex?.netAmount ?? null,
    apexGrossAmount: apex?.grossAmount ?? null,
    meridianNotionalAmount: alpha?.notionalAmount ?? null,
    Fjfmsx4vPLxctbBz: apex?.clientOrderId ?? null,
    meridianOrderId: alpha?.rebalancerOrderId ?? null,
    apexActivityId: apex?.activityId ?? null,
    meridianBasketId: alpha?.apexBasketId ?? null,
    meridianClientBasketId: alpha?.clientBasketId ?? null,
    apexTimestamp: apex?.activityTimestamp ?? null,
    meridianTimestamp: alpha?.initiatedTimestamp ?? null,
    result,
  };
}

/**
 * Deterministic account-aware reconciliation. Order IDs are considered first;
 * value fallback is scoped by account + symbol + side and uses dollars only
 * for mutual-fund buys. Inputs are sorted so source order cannot change pairing.
 */
export function reconcileAccountAware(
  apexRows: ApexTradeSourceRow[],
  alphaRows: MeridianTradeSourceRow[],
): ReconciliationRow[] {
  const apex = [...apexRows].sort((a, b) => a.activityId.localeCompare(b.activityId));
  const alpha = [...alphaRows].sort((a, b) => a.rebalancerOrderId.localeCompare(b.rebalancerOrderId));
  const unusedAlpha = new Set(alpha.map((_, index) => index));
  const pairedApex = new Set<number>();
  const rows: ReconciliationRow[] = [];

  for (let apexIndex = 0; apexIndex < apex.length; apexIndex++) {
    const candidate = apex[apexIndex]!;
    if (!candidate.clientOrderId) continue;
    const alphaIndex = alpha.findIndex((other, index) =>
      unusedAlpha.has(index) &&
      other.rebalancerOrderId === candidate.clientOrderId &&
      other.accountId === candidate.accountId,
    );
    if (alphaIndex < 0) continue;
    pairedApex.add(apexIndex);
    unusedAlpha.delete(alphaIndex);
    rows.push(outputRow(`order:${candidate.activityId}`, candidate, alpha[alphaIndex]!, "ORDER_ID"));
  }

  for (let apexIndex = 0; apexIndex < apex.length; apexIndex++) {
    if (pairedApex.has(apexIndex)) continue;
    const candidate = apex[apexIndex]!;
    const key = fallbackKey(candidate);
    const alphaIndex = alpha.findIndex((other, index) => unusedAlpha.has(index) && fallbackKey(other) === key);
    if (alphaIndex < 0) continue;
    pairedApex.add(apexIndex);
    unusedAlpha.delete(alphaIndex);
    rows.push(outputRow(`fallback:${candidate.activityId}`, candidate, alpha[alphaIndex]!, "ACCOUNT_SYMBOL_SIDE_VALUE"));
  }

  for (let apexIndex = 0; apexIndex < apex.length; apexIndex++) {
    if (!pairedApex.has(apexIndex)) {
      const candidate = apex[apexIndex]!;
      rows.push(outputRow(`apex:${candidate.activityId}`, candidate, null, "UNMATCHED"));
    }
  }
  for (const alphaIndex of unusedAlpha) {
    const candidate = alpha[alphaIndex]!;
    rows.push(outputRow(`alpha:${candidate.rebalancerOrderId}`, null, candidate, "UNMATCHED"));
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
