import { ACAT_STATUS_CATALOG } from "../acat-status-catalog";

/** Every inventory row gets exactly one disposition. These are accounting
 * categories, not matching rules; the guarded matcher supplies dispositions. */
export const COVERAGE_CATEGORIES = [
  "linked", "proposed", "pending", "excluded", "no_counterpart",
] as const;
export type CoverageCategory = typeof COVERAGE_CATEGORIES[number];
export type Population = "tracker" | "aoa";

export type SourceInventoryRow = {
  id: string;
  status: string;
  deleted: boolean;
  externalReference: string | null;
};
export type TargetInventoryRow = {
  id: string;
  stage: string;
  archived: boolean;
  acatRecordId: string | null;
  acatTransferId: string | null;
};
export type CoverageDisposition = {
  population: Population;
  id: string;
  category: CoverageCategory;
};
export type InventoryBoundary = {
  readAt: string;
  complete: boolean;
  declaredCount: number;
};
export type PopulationCoverage = {
  total: number;
  categories: Record<CoverageCategory, number>;
};
export type DuplicateCounts = { groups: number; members: number };
export type CoverageSummary = {
  tracker: PopulationCoverage & {
    deleted: number;
    statusCounts: Record<string, number>;
    duplicateExternalReferences: DuplicateCounts;
  };
  aoa: PopulationCoverage & {
    archived: number;
    stageCounts: Record<string, number>;
    duplicateRecordReferences: DuplicateCounts;
    duplicateExternalReferences: DuplicateCounts;
  };
  boundaries: { tracker: string; aoa: string };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = new Set(["DISCOVERY", "ACCOUNTS_OPEN", "DECISION", "IN_TRANSFER", "FUNDED"]);
const PLACEHOLDERS = new Set(["", "n/a", "none", "null", "manual", "tbd", "-"]);

/** UUIDs share case-insensitive identity; opaque non-UUID references do not.
 * Inventory duplicate counts include archived/deleted/terminal rows. */
export function canonicalInventoryReference(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (PLACEHOLDERS.has(value.toLowerCase())) return null;
  return UUID.test(value) ? value.toLowerCase() : value;
}

export function countDuplicateReferences(values: readonly (string | null)[]): DuplicateCounts {
  return countDuplicateValues(values.map(canonicalInventoryReference));
}

function countDuplicateValues(values: readonly (string | null)[]): DuplicateCounts {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let groups = 0;
  let members = 0;
  for (const count of counts.values()) {
    if (count > 1) { groups += 1; members += count; }
  }
  return { groups, members };
}

function validateInventory(rows: readonly { id: string }[], boundary: InventoryBoundary): Set<string> {
  if (!boundary.complete || !Number.isSafeInteger(boundary.declaredCount)
    || boundary.declaredCount !== rows.length || !Number.isFinite(Date.parse(boundary.readAt))) {
    throw new Error("acat_reconciliation_incomplete_inventory");
  }
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.id || ids.has(row.id)) throw new Error("acat_reconciliation_invalid_inventory_grain");
    ids.add(row.id);
  }
  return ids;
}

function emptyCoverage(total: number): PopulationCoverage {
  return { total, categories: { linked: 0, proposed: 0, pending: 0, excluded: 0, no_counterpart: 0 } };
}

function histogram(values: readonly string[], known: (value: string) => boolean): Record<string, number> {
  // Unknown source text is counted without echoing arbitrary content into logs
  // or aggregate DTOs. No names, IDs, references or account values are returned.
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = known(value) ? value : "UNKNOWN";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Pure read-only accounting. Missing, duplicate, foreign or conflicting
 * dispositions fail rather than silently reduce either population. The two
 * boundaries remain separate: this is not an atomic cross-application cut. */
export function summarizeCoverage(input: {
  tracker: readonly SourceInventoryRow[];
  aoa: readonly TargetInventoryRow[];
  trackerBoundary: InventoryBoundary;
  aoaBoundary: InventoryBoundary;
  dispositions: readonly CoverageDisposition[];
}): CoverageSummary {
  const remaining = {
    tracker: validateInventory(input.tracker, input.trackerBoundary),
    aoa: validateInventory(input.aoa, input.aoaBoundary),
  };
  const tracker = emptyCoverage(input.tracker.length);
  const aoa = emptyCoverage(input.aoa.length);
  for (const item of input.dispositions) {
    if (!(item.population === "tracker" || item.population === "aoa")
      || !COVERAGE_CATEGORIES.includes(item.category)
      || !remaining[item.population].delete(item.id)) {
      throw new Error("acat_reconciliation_invalid_disposition");
    }
    (item.population === "tracker" ? tracker : aoa).categories[item.category] += 1;
  }
  if (remaining.tracker.size || remaining.aoa.size) throw new Error("acat_reconciliation_unaccounted_population");
  return {
    tracker: {
      ...tracker,
      deleted: input.tracker.filter((row) => row.deleted).length,
      statusCounts: histogram(input.tracker.map((row) => row.status), (value) => Object.hasOwn(ACAT_STATUS_CATALOG, value)),
      duplicateExternalReferences: countDuplicateReferences(input.tracker.map((row) => row.externalReference)),
    },
    aoa: {
      ...aoa,
      archived: input.aoa.filter((row) => row.archived).length,
      stageCounts: histogram(input.aoa.map((row) => row.stage), (value) => STAGES.has(value)),
      // Primary record keys are opaque even if a synthetic key looks UUID-like.
      duplicateRecordReferences: countDuplicateValues(input.aoa.map((row) => row.acatRecordId)),
      duplicateExternalReferences: countDuplicateReferences(input.aoa.map((row) => row.acatTransferId)),
    },
    boundaries: { tracker: input.trackerBoundary.readAt, aoa: input.aoaBoundary.readAt },
  };
}
