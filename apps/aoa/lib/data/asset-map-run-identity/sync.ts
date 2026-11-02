import "server-only";

import { INGEST_ASSET_MAP_RUN_IDENTITY, writeAudit } from "@/lib/audit";
import type { HouseholdsEnvelope } from "@/lib/data/asset-map";
import { assetMapRunIdentityEnabled, assetMapRunIdentityWritesEnabled } from "@/lib/flags";
import { withIngestScope } from "@/lib/ingest/scope";

import { isCanonicalUuid, parseRunIdentity, type RunIdentityObservation } from "./contract";
import {
  RunIdentityPersistenceError,
  persistRunIdentities,
  type RunIdentityPersistCounts,
} from "./persistence";
import { RunIdentityResolverError } from "./resolver";

// Identity phase of the existing /api/cron/asset-map import (ticket).
//
// The route pulls every page once and runs the base household/account/position
// import exactly as before. This module turns the SAME pages into an identity
// census and, only after the base transaction has committed, applies it in a
// SEPARATE ingest transaction so an identity failure can never roll back
// financial data. persistRunIdentities owns the lock → re-read → resolve →
// write order inside that transaction; nothing derived here before the lock
// (only validated source observations) is handed to it.
//
// The census is strict where the base import is lenient: any envelope, page
// sequence, total, duplicate or safety-cap problem makes it incomplete, and an
// incomplete census blocks the whole identity write phase. Per-run problems
// inside a complete census quarantine only that run (its prior state is kept).
// Runs absent from a pull are never touched — there is no deletion by omission.

export type RunIdentityMode = "off" | "preview" | "write";

/** The writes gate is effective only while the parent identity gate is on. */
export function runIdentityMode(): RunIdentityMode {
  if (!assetMapRunIdentityEnabled()) return "off";
  return assetMapRunIdentityWritesEnabled() ? "write" : "preview";
}

export type CensusPage = {
  requestedPage: number;
  requestedPerPage: number;
  envelope: HouseholdsEnvelope;
  households: unknown[];
};

export const CENSUS_INCOMPLETE_REASONS = [
  "envelope_invalid",
  "page_sequence",
  "per_page_mismatch",
  "total_changed",
  "page_overfull",
  "short_page",
  "over_total",
  "safety_cap",
  "invalid_run_id",
  "duplicate_run",
  "conflicting_duplicate",
] as const;
export type CensusIncompleteReason = (typeof CENSUS_INCOMPLETE_REASONS)[number];

export type SchemaStatus = "no_runs" | "supported" | "absent" | "unsupported" | "mixed";

export type CensusRunCounts = {
  observed: number;
  available: number;
  unavailable: number;
  unavailableDisabled: number;
  unavailableMissing: number;
  unavailableUnsupported: number;
  quarantined: number;
  linked: number;
  unlinked: number;
  unreviewed: number;
};

export type IdentityCensus = {
  complete: boolean;
  reasons: CensusIncompleteReason[];
  pages: number;
  total: number | null;
  schemaStatus: SchemaStatus;
  runs: CensusRunCounts;
  /** Persistable observations: valid available runs plus explicit source-disabled runs. */
  observations: RunIdentityObservation[];
};

type RawHousehold = Record<string, unknown>;

/**
 * Validate the fetched pages and classify every unique run. `truncated` means
 * the route stopped at its page safety cap before covering the reported total.
 */
export function buildIdentityCensus(
  pages: readonly CensusPage[],
  options: { truncated?: boolean; maxPages: number },
): IdentityCensus {
  const reasons = new Set<CensusIncompleteReason>();
  if (options.truncated) reasons.add("safety_cap");
  if (pages.length === 0) reasons.add("envelope_invalid");

  let total: number | null = null;
  let accumulated = 0;
  pages.forEach((p, i) => {
    const { envelope } = p;
    if (!envelope.households_is_array || envelope.total === null || envelope.page === null || envelope.per_page === null) {
      reasons.add("envelope_invalid");
    }
    if (envelope.page !== null && (envelope.page !== p.requestedPage || p.requestedPage !== i + 1)) {
      reasons.add("page_sequence");
    }
    if (envelope.per_page !== null && envelope.per_page !== p.requestedPerPage) reasons.add("per_page_mismatch");
    if (envelope.total !== null) {
      if (total === null) total = envelope.total;
      else if (envelope.total !== total) reasons.add("total_changed");
    }
    if (p.households.length > p.requestedPerPage) reasons.add("page_overfull");
    accumulated += p.households.length;
    const last = i === pages.length - 1;
    if (!last && p.households.length !== p.requestedPerPage) reasons.add("short_page");
  });
  if (total !== null && pages.length > 0) {
    if (accumulated > total) reasons.add("over_total");
    if (accumulated < total) reasons.add(pages.length >= options.maxPages ? "safety_cap" : "short_page");
    if (total > options.maxPages * pages[0].requestedPerPage) reasons.add("safety_cap");
  }

  const runs: CensusRunCounts = {
    observed: 0, available: 0, unavailable: 0, unavailableDisabled: 0, unavailableMissing: 0,
    unavailableUnsupported: 0, quarantined: 0, linked: 0, unlinked: 0, unreviewed: 0,
  };
  const observations: RunIdentityObservation[] = [];
  const seen = new Map<string, string>();
  for (const page of pages) {
    for (const entry of page.households) {
      const household = (entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}) as RawHousehold;
      const runId = household.id;
      if (!isCanonicalUuid(runId)) {
        reasons.add("invalid_run_id");
        continue;
      }
      const fingerprint = JSON.stringify(household.client_link ?? null);
      const prior = seen.get(runId);
      if (prior !== undefined) {
        reasons.add(prior === fingerprint ? "duplicate_run" : "conflicting_duplicate");
        continue;
      }
      seen.set(runId, fingerprint);
      runs.observed++;
      const parsed = parseRunIdentity(runId, household.client_link);
      if (parsed.ok) {
        observations.push(parsed.value);
        if (parsed.value.availability === "unavailable") {
          runs.unavailable++;
          runs.unavailableDisabled++;
        } else {
          runs.available++;
          runs[parsed.value.decisionState]++;
        }
      } else if (parsed.reason === "missing") {
        runs.unavailable++;
        runs.unavailableMissing++;
      } else if (parsed.reason === "unsupported_schema_version") {
        runs.unavailable++;
        runs.unavailableUnsupported++;
      } else {
        runs.quarantined++;
      }
    }
  }

  return {
    complete: reasons.size === 0,
    reasons: CENSUS_INCOMPLETE_REASONS.filter((r) => reasons.has(r)),
    pages: pages.length,
    total,
    schemaStatus: schemaStatus(runs),
    runs,
    observations,
  };
}

function schemaStatus(runs: CensusRunCounts): SchemaStatus {
  if (runs.observed === 0) return "no_runs";
  const v1 = runs.available + runs.unavailableDisabled + runs.quarantined;
  if (v1 === runs.observed) return "supported";
  if (runs.unavailableMissing === runs.observed) return "absent";
  if (runs.unavailableUnsupported === runs.observed) return "unsupported";
  return "mixed";
}

export type IdentityFailureReason = "resolver_error" | "persistence_error" | "transaction_failed";

export type IdentityWriteOutcome =
  | { status: "applied"; counts: RunIdentityPersistCounts; audited: boolean; durationMs: number }
  | { status: "blocked"; reasons: CensusIncompleteReason[]; durationMs: number }
  | { status: "failed"; reason: IdentityFailureReason; durationMs: number };

/** Did the identity transaction change stored identity state (so it is audited)? */
export function identityStateChanged(counts: RunIdentityPersistCounts): boolean {
  return counts.inserted + counts.sourceApplied + counts.historyRows + counts.membersActivated + counts.membersRetired > 0;
}

/**
 * Apply a census in its own ingest transaction. The caller invokes this only
 * after the base import transaction has committed. Snapshots, members, history
 * and the counts-only audit commit or roll back together.
 */
export async function applyRunIdentities(
  census: IdentityCensus,
  meta: { runId: string; source: string; endpoint: string },
): Promise<IdentityWriteOutcome> {
  const started = Date.now();
  if (!census.complete) return { status: "blocked", reasons: census.reasons, durationMs: Date.now() - started };
  try {
    const result = await withIngestScope(async (tx) => {
      const persisted = await persistRunIdentities(tx, census.observations);
      const audited = identityStateChanged(persisted.counts);
      if (audited) {
        await writeAudit(
          tx,
          { role: "INGEST", email: null },
          {
            action: INGEST_ASSET_MAP_RUN_IDENTITY,
            entityType: "ingest_run",
            entityId: meta.runId,
            detail: identityAuditDetail(census, persisted.counts, meta),
          },
        );
      }
      return { counts: persisted.counts, audited };
    });
    return { status: "applied", ...result, durationMs: Date.now() - started };
  } catch (e) {
    const reason: IdentityFailureReason =
      e instanceof RunIdentityResolverError ? "resolver_error"
        : e instanceof RunIdentityPersistenceError ? "persistence_error"
          : "transaction_failed";
    return { status: "failed", reason, durationMs: Date.now() - started };
  }
}

export function identityAuditDetail(
  census: IdentityCensus,
  counts: RunIdentityPersistCounts,
  meta: { source: string; endpoint: string },
): Record<string, unknown> {
  return {
    source: meta.source,
    endpoint: meta.endpoint,
    pages: census.pages,
    total: census.total,
    observed_runs: census.runs.observed,
    available: census.runs.available,
    unavailable: census.runs.unavailable,
    census_quarantined: census.runs.quarantined,
    persisted_observations: counts.observed,
    inserted: counts.inserted,
    source_applied: counts.sourceApplied,
    unchanged: counts.unchanged,
    stale_rejected: counts.staleRejected,
    quarantined_equal_version: counts.quarantinedEqualVersion,
    quarantined_unreviewed: counts.quarantinedUnreviewed,
    unavailable_preserved: counts.unavailablePreserved,
    missing_parent: counts.missingParent,
    resolution_refreshed: counts.resolutionRefreshed,
    history_rows: counts.historyRows,
    members_activated: counts.membersActivated,
    members_retired: counts.membersRetired,
    resolved: counts.resolved,
    missing: counts.missing,
    ambiguous: counts.ambiguous,
    conflict: counts.conflict,
    dry_run: false,
  };
}
