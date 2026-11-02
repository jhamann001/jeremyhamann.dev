import "server-only";
import type { Prisma } from "@prisma/client";

import { withIngestScope } from "@/lib/ingest/scope";

import {
  compareCodePoints,
  isDerivedUseBlocked,
  type AvailableRunIdentity,
  type Coverage,
  type DecisionState,
  type ReviewState,
} from "./contract";
import {
  deriveMemberResolutions,
  planSourceTransition,
  resolutionDigest,
  type MemberResolution,
  type SourceTransition,
} from "./persistence";
import { resolveRunPeople } from "./resolver";
import type { CensusIncompleteReason, IdentityCensus, RunIdentityMode, SchemaStatus } from "./sync";

// Read-only, counts-only run identity diagnostics (ticket) for preview and
// dryRun=1. Runs in a READ ONLY ingest transaction: it reads persisted
// snapshots/members and current canonical CRM targets and compares them with
// the census, but never writes, locks rows, or emits an audit row. Output is
// aggregate counts and reason codes only — never a person id, name, payload,
// secret or account number. A category that cannot be computed honestly is
// reported unavailable with a reason, never estimated.

export type DiagnosticUnavailableReason = "census_incomplete" | "read_failed";

export type PeopleDiagnostics =
  | { status: "unavailable"; reason: DiagnosticUnavailableReason }
  | {
      status: "available";
      accepted: number;
      resolved: number;
      missing: number;
      ambiguous: number;
      sourceConflict: number;
      crmConflict: number;
    };

export type PlanDiagnostics =
  | { status: "unavailable"; reason: DiagnosticUnavailableReason }
  | {
      status: "available";
      wouldAdd: number;
      wouldRetire: number;
      wouldRemap: number;
      unchanged: number;
      persistedDrift: number;
      transitions: Record<SourceTransition | "missing_parent", number>;
    };

export type RunIdentityDiagnostics = {
  mode: Exclude<RunIdentityMode, "off">;
  dryRun: boolean;
  schemaStatus: SchemaStatus;
  census: { complete: boolean; reasons: CensusIncompleteReason[]; pages: number; total: number | null };
  runs: {
    observed: number;
    available: number;
    unavailable: number;
    quarantined: number;
    unavailableBreakdown: { disabled: number; missing: number; unsupported: number };
    linked: number;
    unlinked: number;
    unreviewed: number;
  };
  people: PeopleDiagnostics;
  plan: PlanDiagnostics;
  timingMs: number;
};

type SnapshotRow = {
  run_id: string;
  identity_version: string;
  payload_digest: string;
  decision_id: string | null;
  decision_state: DecisionState;
  coverage: Coverage;
  people_ids: string[];
  primary_user_id: string | null;
  cedar_ridge_user_id: string | null;
  review_state: ReviewState;
  conflict_flags: string[];
  resolution_digest: string;
};

type MemberRow = {
  run_id: string;
  cedar_ridge_user_id: string;
  membership_state: "active" | "retired";
  resolution_outcome: string | null;
  canonical_contact_identity_id: string | null;
  canonical_contact_source_key: string | null;
};

function storedIdentity(row: SnapshotRow): AvailableRunIdentity {
  return {
    runId: row.run_id,
    schemaVersion: 1,
    availability: "available",
    identityVersion: Number(row.identity_version),
    decisionId: row.decision_id,
    decisionState: row.decision_state,
    peopleIds: row.people_ids,
    coverage: row.coverage,
    primaryUserId: row.primary_user_id,
    cedarRidgeUserId: row.cedar_ridge_user_id,
    reviewState: row.review_state,
    conflictFlags: row.conflict_flags,
  };
}

const emptyTransitions = (): Record<SourceTransition | "missing_parent", number> => ({
  inserted: 0, source_applied: 0, unchanged: 0, stale_rejected: 0, quarantined_equal_version: 0,
  quarantined_unreviewed: 0, unavailable_preserved: 0, missing_parent: 0,
});

/** Read-only comparison of a complete census with persisted state and current CRM. */
export async function compareRunIdentities(
  tx: Prisma.TransactionClient,
  census: IdentityCensus,
  pulledRunIds: ReadonlySet<string>,
): Promise<{ people: PeopleDiagnostics & { status: "available" }; plan: PlanDiagnostics & { status: "available" } }> {
  const observations = census.observations;
  const runIds = observations.map((o) => o.runId);
  const parentRows = runIds.length === 0 ? [] : await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM mirror.acat_asset_map_household WHERE id = ANY(${runIds}::text[])`;
  const parents = new Set([...parentRows.map((r) => r.id), ...pulledRunIds]);
  const snapshots = new Map((runIds.length === 0 ? [] : await tx.$queryRaw<SnapshotRow[]>`
    SELECT run_id, identity_version::text AS identity_version, payload_digest, decision_id, decision_state, coverage,
           people_ids, primary_user_id, cedar_ridge_user_id, review_state, conflict_flags, resolution_digest
      FROM mirror.acat_asset_map_run_identity
     WHERE run_id = ANY(${runIds}::text[])`).map((r) => [r.run_id, r]));
  const memberRows = runIds.length === 0 ? [] : await tx.$queryRaw<MemberRow[]>`
    SELECT run_id, cedar_ridge_user_id, membership_state, resolution_outcome,
           canonical_contact_identity_id, canonical_contact_source_key
      FROM mirror.acat_asset_map_run_person
     WHERE run_id = ANY(${runIds}::text[])`;
  const activeByRun = new Map<string, Map<string, MemberRow>>();
  for (const row of memberRows) {
    if (row.membership_state !== "active") continue;
    if (!activeByRun.has(row.run_id)) activeByRun.set(row.run_id, new Map());
    activeByRun.get(row.run_id)!.set(row.cedar_ridge_user_id, row);
  }

  type Plan = { transition: SourceTransition | "missing_parent"; effective: AvailableRunIdentity | null };
  const plans = new Map<string, Plan>();
  for (const observation of observations) {
    const current = snapshots.get(observation.runId) ?? null;
    const transition = planSourceTransition(
      current
        ? { identityVersion: Number(current.identity_version), decisionState: current.decision_state, payloadDigest: current.payload_digest }
        : null,
      observation,
    );
    if (transition === "inserted" && !parents.has(observation.runId)) {
      plans.set(observation.runId, { transition: "missing_parent", effective: null });
      continue;
    }
    const applies = transition === "inserted" || transition === "source_applied";
    const effective = applies ? (observation as AvailableRunIdentity) : current ? storedIdentity(current) : null;
    plans.set(observation.runId, { transition, effective });
  }

  const toResolve = new Set<string>();
  for (const observation of observations) {
    if (observation.availability === "available" && !isDerivedUseBlocked(observation)) {
      observation.peopleIds.forEach((id) => toResolve.add(id));
    }
  }
  for (const plan of plans.values()) {
    if (plan.effective && !isDerivedUseBlocked(plan.effective)) plan.effective.peopleIds.forEach((id) => toResolve.add(id));
  }
  const resolutions = await resolveRunPeople(tx, [...toResolve].sort(compareCodePoints));

  const people = { status: "available" as const, accepted: 0, resolved: 0, missing: 0, ambiguous: 0, sourceConflict: 0, crmConflict: 0 };
  for (const observation of observations) {
    if (observation.availability !== "available") continue;
    for (const member of deriveMemberResolutions(observation, resolutions)) {
      people.accepted++;
      if (isDerivedUseBlocked(observation)) people.sourceConflict++;
      else if (member.outcome === "conflict") people.crmConflict++;
      else people[member.outcome]++;
    }
  }

  const plan = {
    status: "available" as const, wouldAdd: 0, wouldRetire: 0, wouldRemap: 0, unchanged: 0, persistedDrift: 0,
    transitions: emptyTransitions(),
  };
  const sameTarget = (row: MemberRow, member: MemberResolution) =>
    row.resolution_outcome === member.outcome &&
    row.canonical_contact_identity_id === member.canonicalContactIdentityId &&
    row.canonical_contact_source_key === member.canonicalContactSourceKey;
  for (const [runId, { transition, effective }] of plans) {
    plan.transitions[transition]++;
    if (!effective) continue;
    const members = deriveMemberResolutions(effective, resolutions);
    const active = activeByRun.get(runId) ?? new Map<string, MemberRow>();
    const sourceChanges = transition === "inserted" || transition === "source_applied";
    for (const member of members) {
      const row = active.get(member.cedarRidgeUserId);
      if (!row) plan.wouldAdd++;
      else if (sameTarget(row, member)) plan.unchanged++;
      else plan.wouldRemap++;
    }
    if (sourceChanges) {
      const accepted = new Set(effective.peopleIds);
      for (const id of active.keys()) if (!accepted.has(id)) plan.wouldRetire++;
    }
    const current = snapshots.get(runId);
    if (current && !sourceChanges && current.resolution_digest !== resolutionDigest(members)) plan.persistedDrift++;
  }
  return { people, plan };
}

/**
 * Build the nested response diagnostics. Census counts are always reported;
 * people/plan comparisons run only on a complete census inside a READ ONLY
 * transaction and are reported unavailable if that read fails.
 */
export async function diagnoseRunIdentities(
  census: IdentityCensus,
  options: { mode: Exclude<RunIdentityMode, "off">; dryRun: boolean; pulledRunIds: ReadonlySet<string> },
): Promise<RunIdentityDiagnostics> {
  const started = Date.now();
  let people: PeopleDiagnostics = { status: "unavailable", reason: "census_incomplete" };
  let plan: PlanDiagnostics = { status: "unavailable", reason: "census_incomplete" };
  if (census.complete) {
    try {
      const compared = await withIngestScope(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return compareRunIdentities(tx, census, options.pulledRunIds);
      });
      people = compared.people;
      plan = compared.plan;
    } catch {
      people = { status: "unavailable", reason: "read_failed" };
      plan = { status: "unavailable", reason: "read_failed" };
    }
  }
  return {
    mode: options.mode,
    dryRun: options.dryRun,
    schemaStatus: census.schemaStatus,
    census: { complete: census.complete, reasons: census.reasons, pages: census.pages, total: census.total },
    runs: {
      observed: census.runs.observed,
      available: census.runs.available,
      unavailable: census.runs.unavailable,
      quarantined: census.runs.quarantined,
      unavailableBreakdown: {
        disabled: census.runs.unavailableDisabled,
        missing: census.runs.unavailableMissing,
        unsupported: census.runs.unavailableUnsupported,
      },
      linked: census.runs.linked,
      unlinked: census.runs.unlinked,
      unreviewed: census.runs.unreviewed,
    },
    people,
    plan,
    timingMs: Date.now() - started,
  };
}

/** The diagnostic equations every report must satisfy. */
export function diagnosticEquationsHold(d: RunIdentityDiagnostics): boolean {
  const runs = d.runs;
  const breakdown = runs.unavailableBreakdown;
  const runsOk = runs.observed === runs.available + runs.unavailable + runs.quarantined &&
    runs.available === runs.linked + runs.unlinked + runs.unreviewed &&
    runs.unavailable === breakdown.disabled + breakdown.missing + breakdown.unsupported;
  if (d.people.status === "unavailable") return runsOk;
  const p = d.people;
  return runsOk && p.accepted === p.resolved + p.missing + p.ambiguous + p.sourceConflict + p.crmConflict;
}
