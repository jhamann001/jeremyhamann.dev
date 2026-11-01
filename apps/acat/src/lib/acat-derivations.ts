import { AcatRecord, AcatStatus, Asset, TERMINAL_STATUSES } from "./types";
import { defaultFeeCharged, isResidualTransfer } from "./acat-operational-defaults";

export type AssetClassification = "matched" | "pending" | "mismatch" | "ignored";

// `Rejected` / `Purged` etc. are live Prisma enum values but aren't yet in
// the TS AcatStatus union (see types.ts) — use ReadonlySet<string> so the
// set can name them without forcing a wider public type change.
/**
 * Statuses where the ACAT never actually proceeded. Their assets (if any)
 * represent positions the client intended to move but never did — nothing
 * to reconcile, so they don't count toward the recon rate.
 */
const RECON_DEAD_END_STATUSES: ReadonlySet<string> = new Set([
  "Rejected",
  "Purged",
  "Canceled",
  "Deferred",
]);

/**
 * Bucket an asset into matched / pending / mismatch / ignored.
 *
 * This function is the single source of truth for what counts as an "issue"
 * across RecordRow, RecordGroup, RecordsView's Issues filter/count, the
 * Dashboard recon/issue analytics, and AcatDetail's Issues stat card.
 *
 * The classification is driven by the persisted `Asset.mapStatus` that
 * `SecurityReconTab.saveReconResults` writes — the recon engine already
 * knows how to handle Apex surpluses (actual > expected saved as `Mapped`),
 * manual overrides, and fee rows, so downstream consumers should trust its
 * decision instead of re-running a qty-delta heuristic that would silently
 * contradict what the user just saved.
 *
 * - ignored  — the record is a dead-end (Rejected / Canceled / Purged /
 *              Deferred) OR the asset has zero on both sides (placeholder /
 *              parser artifact). Drops out of the recon rate entirely.
 * - matched  — `mapStatus === "Mapped"` or `mapStatus === "Expected"`. An
 *              "Expected" position is one ops has affirmatively accounted for,
 *              so it counts toward the recon rate and is never an issue.
 * - mismatch — `mapStatus === "Unmapped"` (the actionable issue bucket).
 * - pending  — `mapStatus === "Pending"` (reconciliation not yet performed).
 */
export function classifyAsset(asset: Asset, status: AcatStatus): AssetClassification {
  if (RECON_DEAD_END_STATUSES.has(status)) return "ignored";
  if (asset.expectedQty === 0 && asset.actualQty === 0) return "ignored";
  switch (asset.mapStatus) {
    case "Mapped":
    case "Expected":
      return "matched";
    case "Unmapped":
      return "mismatch";
    case "Pending":
    default:
      return "pending";
  }
}

export interface AssetCounts {
  matched: number;
  pending: number;
  mismatch: number;
}

export function getAssetCounts(acat: AcatRecord): AssetCounts {
  const counts: AssetCounts = { matched: 0, pending: 0, mismatch: 0 };
  for (const asset of acat.assets) {
    const bucket = classifyAsset(asset, acat.status);
    if (bucket === "ignored") continue;
    counts[bucket]++;
  }
  return counts;
}

/**
 * Count of assets on a record that are a real reconciliation problem —
 * quantity mismatches or zero-fills on a settled record. Pending in-flight
 * records and dead-end ACATs contribute zero.
 */
export function getIssueCount(acat: AcatRecord): number {
  return getAssetCounts(acat).mismatch;
}

export function hasIssues(acat: AcatRecord): boolean {
  return getIssueCount(acat) > 0;
}

/**
 * Records typed as a residual credit (cash settlement after the main
 * transfer). They aren't a fee reimbursement that gets submitted to Apex,
 * and they skew the avg-days metric, so several views filter them out.
 */
export const RESIDUAL_TYPE = "Residual Credit";

export function isResidual(record: AcatRecord): boolean {
  return record.type === RESIDUAL_TYPE;
}

/**
 * True when a fee was charged on the transfer but the reimbursement request
 * hasn't been completed yet — i.e. the fee credit still needs to be submitted
 * to Apex. Drives the records-page "Fee to Submit" quick filter.
 *
 * `feeCharged` is a "Yes"/"No" string (compared case-insensitively); a blank
 * `feeRequestCompleted` date means the request hasn't been closed out.
 * Residual-credit, rejected, and purged records are excluded — they aren't
 * fee reimbursements that need submission.
 * DRS has no assumed fee; an explicit Yes still enters the queue.
 */
export function needsFeeSubmission(acat: AcatRecord): boolean {
  if (isResidual(acat)) return false;
  if (["Rejected", "Purged"].includes(acat.status)) return false;
  const charged =
    (acat.feeCharged ?? "").trim().toLowerCase() === "yes" ||
    defaultFeeCharged(acat) === "Yes";
  const completed = (acat.feeRequestCompleted ?? "").trim() !== "";
  return charged && !completed;
}

/**
 * Full and partial transfers should carry an explicit instruction describing
 * what Ops should do with the positions. This remains a non-blocking queue so
 * records can be saved while instructions are still being obtained.
 */
export function needsTradeInstructions(acat: AcatRecord): boolean {
  if (isResidualTransfer(acat)) return false;
  if (["Rejected", "Purged", "Canceled", "Deferred"].includes(acat.status)) {
    return false;
  }
  const transferType = acat.type?.trim().toLowerCase();
  const eligible = transferType === "full" || transferType === "partial";
  return eligible && !acat.tradeInstructions?.trim();
}

/**
 * Whole days elapsed since the record was opened.
 * Uses `originalClientRequestDate` when present, otherwise `acatDate`.
 */
export function getDaysOpen(acat: AcatRecord, now: number = Date.now()): number {
  const startRaw = acat.originalClientRequestDate ?? acat.acatDate;
  const start = new Date(startRaw).getTime();
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.round((now - start) / 86_400_000));
}

/**
 * Sum of `statementAmount` (cents) across a list of records. Records
 * without a value contribute zero. Returns cents — callers divide by 100
 * for display.
 */
export function sumStatementAmount(records: AcatRecord[]): number {
  return records.reduce((sum, r) => sum + (r.statementAmount ?? 0), 0);
}

// ---------------------------------------------------------------------------
// ticket / ticket: Per-custodian aging + expected completion
//
// Replaces the previous hardcoded "stale after 5 days" rule with a tier
// derived from each custodian's `avgProcessingDays`. Aging tiers:
//   - on-track : daysOpen <= expected * WARN_MULT
//   - warn     : expected * WARN_MULT < daysOpen <= expected * HIGH_MULT
//   - high     : daysOpen > expected * HIGH_MULT
//   - none     : terminal status (Completed / Rejected / Purged / Canceled
//                / Deferred) — already done, not aging by definition.
//
// Records without a linked custodian (or whose custodian has
// `avgProcessingDays === 0`) fall back to DEFAULT_PROCESSING_DAYS so the
// dashboard still surfaces a signal. The multipliers are conservative
// starting points; tune per ops feedback.
// ---------------------------------------------------------------------------

/**
 * Fallback processing-time SLA used when a record has no linked custodian
 * (or the custodian has `avgProcessingDays === 0`). Picked to roughly
 * match the historical seed-data average across the four core custodians
 * (Fidelity 5d, Schwab 6d, BNY 8d, E*Trade 7d).
 */
export const DEFAULT_PROCESSING_DAYS = 7;

/**
 * Multipliers applied to the per-record expected processing days to derive
 * aging tier boundaries. A record at exactly `expected * 1.25` days is
 * still on-track; one tick over flips it to `warn`.
 */
export const AGING_WARN_MULTIPLIER = 1.25;
export const AGING_HIGH_MULTIPLIER = 1.75;

export type AgingTier = "none" | "on-track" | "warn" | "high";

/**
 * Expected processing days for a record. Reads from `acat.custodian` when
 * the API has eager-loaded the relation; otherwise returns the fallback.
 *
 * Always returns a positive number so downstream multiplications are safe;
 * a custodian misconfigured with `avgProcessingDays === 0` is treated the
 * same as no custodian.
 */
export function getExpectedProcessingDays(acat: AcatRecord): number {
  const v = acat.custodian?.avgProcessingDays;
  if (typeof v === "number" && v > 0) return v;
  return DEFAULT_PROCESSING_DAYS;
}

/**
 * Bucket a record by how much its days-open has overshot the custodian's
 * expected processing time. Terminal records always return `none` — a
 * Completed ACAT isn't aging, it's done.
 */
export function getAgingTier(acat: AcatRecord, now: number = Date.now()): AgingTier {
  if (TERMINAL_STATUSES.has(acat.status)) return "none";
  const expected = getExpectedProcessingDays(acat);
  const daysOpen = getDaysOpen(acat, now);
  if (daysOpen > expected * AGING_HIGH_MULTIPLIER) return "high";
  if (daysOpen > expected * AGING_WARN_MULTIPLIER) return "warn";
  return "on-track";
}

/**
 * Convenience filter for "needs attention" derivations. True for records
 * in the `warn` or `high` tier — i.e. anything ops should be looking at.
 */
export function isAging(acat: AcatRecord, now: number = Date.now()): boolean {
  const tier = getAgingTier(acat, now);
  return tier === "warn" || tier === "high";
}

/**
 * Projected completion date for an in-flight ACAT, computed from
 * `opsSubmissionDateToApex + custodian.avgProcessingDays`. Returns null
 * when either input is missing or unparseable — the UI should fall back
 * to "—" or omit the column.
 *
 * Intentionally computed even for terminal records so consumers (e.g.
 * a future "slippage vs expected" report) can compare against
 * `apexCompletionDate`. The records UI hides it for terminal rows.
 *
 * Output format: ISO date string `YYYY-MM-DD` (UTC) to match the
 * formatting of every other date column on AcatRecord.
 */
export function getExpectedCompletionDate(acat: AcatRecord): string | null {
  const submission = acat.opsSubmissionDateToApex;
  if (!submission) return null;
  const submissionTs = new Date(submission).getTime();
  if (Number.isNaN(submissionTs)) return null;
  const days = getExpectedProcessingDays(acat);
  const projected = new Date(submissionTs + days * 86_400_000);
  return projected.toISOString().slice(0, 10);
}

// ticket: Recon-completion threshold for auto-marking the asset
// reconciliation complete. >= 90% matched (across non-ignored assets)
// counts as "good enough"; the remaining mismatches are surfaced as
// row-level issues but no longer block the recon from closing out.
export const RECON_AUTO_COMPLETE_THRESHOLD = 0.9;

export type ReconStatus = "complete" | "needs_review" | "pending";

/**
 * Has positions been pulled from the internal mapping source (GCP)? The
 * source string is the only signal we have today; treat the default
 * "GCP Project API" tag as the green light. Records still tagged with
 * the legacy fixture source ("Mock / Local Fixture") are also accepted
 * so demo data behaves like real data.
 */
export function hasGcpPositions(record: AcatRecord): boolean {
  const src = record.mappingSource;
  if (!src) return false;
  return src === "GCP Project API" || src === "Mock / Local Fixture";
}

/**
 * Has the Apex output CSV been uploaded for this record? SecurityReconTab
 * sets `apexSource = "Uploaded"` after a successful CSV reconciliation.
 */
export function hasApexUpload(record: AcatRecord): boolean {
  return record.apexSource === "Uploaded";
}

/**
 * Fraction of non-ignored assets currently classified as `matched`. Used
 * by the auto-completion heuristic and the records-page recon column.
 */
export function getReconRate(record: AcatRecord): number {
  const counts = getAssetCounts(record);
  const denominator = counts.matched + counts.mismatch + counts.pending;
  if (denominator === 0) return 0;
  return counts.matched / denominator;
}

/**
 * Derived recon-completion state for the records page:
 *   - "complete"      : reconCompletedAt is set OR the heuristic
 *                       (both sources + rate >= 90%) is true.
 *   - "needs_review"  : both source signals are present but the rate
 *                       is below 90% and recon isn't already marked
 *                       complete. Surfaced as a flag/badge for ops.
 *   - "pending"       : at least one source signal is still missing;
 *                       too early to call anything.
 */
export function getReconStatus(record: AcatRecord): ReconStatus {
  if (record.reconCompletedAt) return "complete";
  const gcp = hasGcpPositions(record);
  const apex = hasApexUpload(record);
  if (gcp && apex) {
    return getReconRate(record) >= RECON_AUTO_COMPLETE_THRESHOLD
      ? "complete"
      : "needs_review";
  }
  return "pending";
}

/**
 * Should the PATCH handler auto-stamp `reconCompletedAt` for this record
 * snapshot? Server-side gate that runs after the asset writes are
 * computed so the rate reflects the post-save state.
 */
export function shouldAutoCompleteRecon(record: AcatRecord): boolean {
  if (record.reconCompletedAt) return false;
  return (
    hasGcpPositions(record) &&
    hasApexUpload(record) &&
    getReconRate(record) >= RECON_AUTO_COMPLETE_THRESHOLD
  );
}
