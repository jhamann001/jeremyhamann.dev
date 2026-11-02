/**
 * Pure sector / asset-class allocation for an account's equity sleeve. Rolls the
 * equity-bucket holdings into a unified "classification" breakdown: GICS sectors
 * for individual stocks/ADRs, asset classes for ETFs/mutual funds, and a single
 * "Unclassified" slice for anything the cache can't yet classify.
 *
 * No I/O — the runner passes in the cache-backed classification map. Percentages
 * are on the same account-relative scale as the input holdings (so the slices
 * sum to the account's equity-bucket weight, not to 100).
 */
import type { SecurityClassification } from '@/lib/trade-requests/sources/security-sector';

export interface AllocationSlice {
  label: string; // GICS sector, asset class, or 'Unclassified'
  kind: 'sector' | 'assetClass' | 'unclassified';
  pct: number; // account-relative percent (0..100)
}

export interface SectorAllocation {
  slices: AllocationSlice[]; // sorted by pct desc
  classifiedPct: number; // equity-sleeve % that resolved to a sector/asset class
  unclassifiedPct: number; // equity-sleeve % still unclassified
}

const UNCLASSIFIED = 'Unclassified';

/**
 * @param equityHoldings  equity-bucket holdings ({symbol, positionPct}), as the
 *                        comparator already produces them.
 * @param classification  ticker → classification (from getClassificationMap).
 *                        Keyed by NORMALIZED ticker; pass a normalizer to match
 *                        raw holding symbols (e.g. Apex BRKB → BRK.B).
 */
export function computeSectorAllocation(
  equityHoldings: ReadonlyArray<{ symbol: string; positionPct: number }>,
  classification: ReadonlyMap<string, SecurityClassification>,
  normalize: (symbol: string) => string | null = (s) => s,
): SectorAllocation {
  const byLabel = new Map<string, AllocationSlice>();
  let classifiedPct = 0;
  let unclassifiedPct = 0;

  const add = (label: string, kind: AllocationSlice['kind'], pct: number) => {
    const cur = byLabel.get(label);
    if (cur) cur.pct += pct;
    else byLabel.set(label, { label, kind, pct });
  };

  for (const h of equityHoldings) {
    if (!(h.positionPct > 0)) continue;
    const norm = normalize(h.symbol);
    const hit = norm ? classification.get(norm) : undefined;
    if (hit?.kind === 'equity' && hit.sector) {
      add(hit.sector, 'sector', h.positionPct);
      classifiedPct += h.positionPct;
    } else if (hit?.kind === 'fund' && hit.assetClass) {
      add(hit.assetClass, 'assetClass', h.positionPct);
      classifiedPct += h.positionPct;
    } else {
      add(UNCLASSIFIED, 'unclassified', h.positionPct);
      unclassifiedPct += h.positionPct;
    }
  }

  const slices = [...byLabel.values()].sort((a, b) => b.pct - a.pct);
  return {
    slices,
    classifiedPct: round2(classifiedPct),
    unclassifiedPct: round2(unclassifiedPct),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
