import type { AcatRecord, ApexPosition, Asset, AssetMappingContext } from "@/lib/types";

export interface ReconRow {
  mapping?: AssetMappingContext;
  id: string;
  symbol: string;
  description: string;
  cusip?: string;
  expectedQty: number;
  actualQty: number;
  amount?: number;
  assetClass?: string;
  status: "Matched" | "Mismatch" | "Missing" | "Unexpected" | "Pending" | "Expected" | "Info";
  issue?: string;
  notes?: string;
}

const CASH_SYNONYMS = new Set(["CASH", "USD"]);
const FEE_PATTERN = /\bfee\b/i;
// Tolerance for share-quantity comparisons. Apex occasionally emits
// quantities as floats (`100.3700000001`) and JS can't exactly represent
// common decimals (`0.1 + 0.2 !== 0.3`), so exact equality on `delta === 0`
// would spuriously flag matches as mismatches.
const QTY_EPSILON = 1e-9;

// Cash reconciles in dollars, not shares, so it gets a cent-level tolerance
// rather than the share epsilon above. Sub-cent gaps (rounding between the
// custodian statement and Apex) count as Matched.
const CASH_EPSILON = 0.01;

// Format a dollar figure for the recon UI. Recon amounts are plain floats
// (dollars) — unlike the integer cents used for statementAmount elsewhere.
// `signed` prefixes an explicit +/- for variance / mismatch callouts.
export function formatReconCash(value: number, signed = false): string {
  const sign = value < 0 ? "-" : signed ? "+" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Class B / preferred share tickers are written many ways across systems:
// BRK.B (Yahoo), BRK'B (some internal pipelines), BRK-B (Nasdaq),
// BRKB (Apex / unseparated), BRK/B (Vanguard). Strip every separator and
// uppercase so all variants collapse to the same key. We intentionally
// DON'T touch CUSIPs — those go through their own exact-match path.
export function normalizeTicker(symbol: string): string {
  return symbol.replace(/[.\-'/\s_]/g, "").toUpperCase().trim();
}

export function isCashSymbol(symbol: string): boolean {
  return CASH_SYNONYMS.has(normalizeTicker(symbol));
}

function isFeeRow(apex: ApexPosition): boolean {
  return (
    FEE_PATTERN.test(apex.symbol) ||
    FEE_PATTERN.test(apex.description) ||
    FEE_PATTERN.test(apex.assetClass)
  );
}

// Apex files occasionally split a single holding across multiple rows (e.g. a
// base lot plus a DRIP/dividend accrual row). Collapse rows that share a
// CUSIP, or a symbol when CUSIP is absent, so the reconciler sees one position
// per ticker. Fee rows stay individual — they're separate charges, not lots.
export function aggregateApexPositions(positions: ApexPosition[]): ApexPosition[] {
  const grouped = new Map<string, ApexPosition>();
  const standalone: ApexPosition[] = [];

  for (const p of positions) {
    if (isFeeRow(p)) {
      standalone.push(p);
      continue;
    }
    const key = p.cusip?.trim() || normalizeTicker(p.symbol);
    if (!key) {
      standalone.push(p);
      continue;
    }
    const existing = grouped.get(key);
    if (existing) {
      existing.qty += p.qty;
      existing.amount += p.amount;
    } else {
      grouped.set(key, { ...p });
    }
  }

  return [...grouped.values(), ...standalone];
}

export function reconcile(
  expected: AcatRecord["assets"],
  apexPositions: ApexPosition[]
): ReconRow[] {
  const aggregated = aggregateApexPositions(apexPositions);
  const rows: ReconRow[] = [];
  const matchedApexIndices = new Set<number>();

  for (const asset of expected) {
    let apexIdx = -1;

    if (asset.cusip) {
      apexIdx = aggregated.findIndex(
        (p, i) => !matchedApexIndices.has(i) && p.cusip === asset.cusip
      );
    }
    if (apexIdx === -1) {
      const normalizedAssetSymbol = normalizeTicker(asset.symbol);
      apexIdx = aggregated.findIndex(
        (p, i) =>
          !matchedApexIndices.has(i) &&
          (normalizeTicker(p.symbol) === normalizedAssetSymbol ||
           p.cusip === asset.symbol)
      );
    }
    if (apexIdx === -1 && isCashSymbol(asset.symbol)) {
      apexIdx = aggregated.findIndex(
        (p, i) => !matchedApexIndices.has(i) && isCashSymbol(p.symbol)
      );
    }

    if (apexIdx !== -1) {
      matchedApexIndices.add(apexIdx);
      const apex = aggregated[apexIdx];
      const assetNotes = asset.notes;

      // Cash reconciles by dollar amount, not share quantity. A cash line's
      // "quantity" is meaningless (0) — the dollars live in `amount` on both
      // the mapped asset (pulled from asset mapping) and the Apex position.
      // Compare those with a cent tolerance and skip the whole-share
      // fractional-shortfall logic below, which is nonsensical for dollars.
      if (isCashSymbol(asset.symbol)) {
        const expectedCash = asset.amount ?? 0;
        const actualCash = apex.amount ?? 0;
        const cashDelta = actualCash - expectedCash;
        // Mirror the equity rule: a shortfall beyond a cent is a Mismatch;
        // an exact match or a surplus (at least as much cash as expected)
        // is Matched. The operator's concern is cash arriving short.
        const cashMatched = cashDelta >= -CASH_EPSILON;
        rows.push({
          mapping: asset,
          id: asset.id,
          symbol: asset.symbol,
          description: asset.description,
          cusip: asset.cusip,
          expectedQty: expectedCash,
          actualQty: actualCash,
          amount: actualCash,
          assetClass: apex.assetClass || asset.assetClass,
          status: cashMatched ? "Matched" : "Mismatch",
          issue: cashMatched
            ? undefined
            : `Cash Mismatch (${formatReconCash(cashDelta, true)})`,
          notes: assetNotes,
        });
        continue;
      }

      const delta = apex.qty - asset.expectedQty;
      // ACATs can only move whole shares — fractional pieces stay at the
      // delivering custodian. So if expected is 100.37 and apex shows 100,
      // that's not an operational issue; it's the expected behavior. We
      // treat it as Matched but leave a neutral breadcrumb on the row so
      // ops can see why the quantity looks short.
      const wholeExpected = Math.floor(asset.expectedQty);
      const expectedHasFractional =
        asset.expectedQty - wholeExpected > QTY_EPSILON;
      const isFractionalOnlyShortfall =
        expectedHasFractional &&
        apex.qty + QTY_EPSILON >= wholeExpected &&
        delta < -QTY_EPSILON;
      // Surpluses (apex > expected) and exact matches count as Matched.
      // Short-by-fractional-only also counts as Matched per the rule above.
      // Anything else that's short is a real Mismatch.
      const status: ReconRow["status"] =
        delta >= -QTY_EPSILON || isFractionalOnlyShortfall
          ? "Matched"
          : "Mismatch";
      const issue = isFractionalOnlyShortfall
        ? `Fractional share not transferable via ACAT (${(
            asset.expectedQty - apex.qty
          ).toFixed(6)} short)`
        : delta < -QTY_EPSILON
          ? `Qty Mismatch (${delta} shares)`
          : undefined;
      rows.push({
        mapping: asset,
        id: asset.id,
        symbol: asset.symbol,
        description: asset.description,
        cusip: asset.cusip,
        expectedQty: asset.expectedQty,
        actualQty: apex.qty,
        amount: apex.amount,
        assetClass: apex.assetClass,
        status,
        issue,
        notes: assetNotes,
      });
    } else {
      rows.push({
        mapping: asset,
        id: asset.id,
        symbol: asset.symbol,
        description: asset.description,
        cusip: asset.cusip,
        // A missing cash line should still show the dollars we expected, not
        // its (meaningless) share quantity of 0.
        expectedQty: isCashSymbol(asset.symbol)
          ? asset.amount ?? 0
          : asset.expectedQty,
        actualQty: 0,
        status: "Missing",
        issue: "Not found in Apex CSV",
        notes: asset.notes,
      });
    }
  }

  for (let i = 0; i < aggregated.length; i++) {
    if (matchedApexIndices.has(i)) continue;
    const apex = aggregated[i];
    const fee = isFeeRow(apex);
    rows.push({
      id: `apex-extra-${i}`,
      symbol: apex.symbol,
      description: apex.description,
      cusip: apex.cusip,
      expectedQty: 0,
      // Unexpected cash from Apex carries its value in `amount`, not qty.
      actualQty: isCashSymbol(apex.symbol) ? apex.amount ?? 0 : apex.qty,
      amount: apex.amount,
      assetClass: apex.assetClass,
      status: fee ? "Info" : "Unexpected",
      issue: fee ? undefined : "Not in expected positions",
    });
  }

  return rows;
}


export interface ReconCounts {
  total: number;
  matched: number;
  issues: number;
  reconRate: number;
}

/** Counts for a freshly reconciled (unsaved) grid: Matched, Expected and Info
 * rows count as matched; every other status is an issue. */
export function previewReconCounts(rows: ReconRow[]): ReconCounts {
  const total = rows.length;
  const matched = rows.filter((r) => r.status === "Matched" || r.status === "Expected" || r.status === "Info").length;
  const issues = rows.filter((r) => r.status !== "Matched" && r.status !== "Expected" && r.status !== "Info").length;
  const reconRate = total > 0 ? Math.round((matched / total) * 100) : 0;
  return { total, matched, issues, reconRate };
}

/** Counts for the stored grid: trust the persisted mapStatus, not the raw qty
 * delta. The recon engine collapses surpluses (apex qty > expected) into
 * Mapped; recomputing from expectedQty !== actualQty would flip those into
 * issues and contradict the Save just written. */
export function storedReconCounts(assets: Asset[]): ReconCounts {
  const total = assets.length;
  const matched = assets.filter((a) => a.mapStatus === "Mapped" || a.mapStatus === "Expected").length;
  const issues = assets.filter((a) => a.mapStatus === "Unmapped").length;
  const reconRate = total > 0 ? Math.round((matched / total) * 100) : 0;
  return { total, matched, issues, reconRate };
}

/** Collapse recon-row statuses onto the Asset.mapStatus enum
 * (Mapped | Unmapped | Pending | Expected). Matched/Mismatch/Info all mean
 * "we found the position" so they're Mapped (the `issue` column carries the
 * variance detail). Missing/Unexpected are Unmapped. Pending and Expected pass
 * through unchanged: both are manual, neutral states that park a row
 * mid-review without forcing a mapping decision. */
export function toMapStatus(status: ReconRow["status"]) {
  return status === "Matched" || status === "Mismatch" || status === "Info"
    ? ("Mapped" as const)
    : status === "Pending"
      ? ("Pending" as const)
      : status === "Expected"
        ? ("Expected" as const)
        : ("Unmapped" as const);
}

/** The stored grid: mirrors the save-time collapse (Matched/Mismatch/Info →
 * Mapped, Missing/Unexpected → Unmapped) by deriving row status from the
 * persisted mapStatus, so a saved surplus does not re-surface as Mismatch. */
export function storedReconRows(assets: Asset[]): ReconRow[] {
  return assets.map((asset) => {
    const status: ReconRow["status"] =
      asset.mapStatus === "Mapped"
        ? "Matched"
        : asset.mapStatus === "Unmapped"
          ? "Mismatch"
          : asset.mapStatus === "Expected"
            ? "Expected"
            : "Pending";
    return {
      mapping: asset,
      id: asset.id,
      symbol: asset.symbol,
      description: asset.description,
      cusip: asset.cusip,
      // Cash expected value lives in `amount`; its share quantity is 0.
      expectedQty: isCashSymbol(asset.symbol)
        ? asset.amount ?? 0
        : asset.expectedQty,
      actualQty: asset.actualQty,
      amount: asset.amount,
      status,
      issue: asset.issue,
      notes: asset.notes,
    } satisfies ReconRow;
  });
}
