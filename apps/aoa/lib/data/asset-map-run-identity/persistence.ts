import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

import {
  compareCodePoints,
  identityInvariantViolation,
  identityPayloadDigest,
  isCanonicalUuid,
  isDerivedUseBlocked,
  type AvailableRunIdentity,
  type Coverage,
  type DecisionState,
  type ResolutionOutcome,
  type ReviewState,
  type RunIdentityObservation,
} from "./contract";
import { resolveRunPeople, type RunPersonResolution } from "./resolver";

// Locked compare-and-apply of accepted run identities into
// mirror.acat_asset_map_run_identity / _run_person / _run_identity_history.
//
// Runs entirely inside the CALLER's ingest_rw transaction so the caller can
// commit its counts-only audit atomically with these writes. Order inside the
// transaction is fixed: identity sync lock → re-read persisted snapshots and
// members (FOR UPDATE) → read current CRM state through the checked resolver →
// write. Nothing derived before the lock is ever persisted, so a stale worker
// that waited on the lock re-plans against the newer committed state.
//
// Writes only the three identity tables. Folder/account links, legacy household
// scalars, transfers, financial rows and CRM identities are never touched.

/** Transaction-scoped advisory lock serializing identity writers. */
export const RUN_IDENTITY_SYNC_LOCK_KEY = "2026093012000270";

export type SourceTransition =
  | "inserted"
  | "source_applied"
  | "unchanged"
  | "stale_rejected"
  | "quarantined_equal_version"
  | "quarantined_unreviewed"
  | "unavailable_preserved";

export type RunIdentityRunResult = {
  runId: string;
  source: SourceTransition | "missing_parent";
  consumerRevision: number | null;
  resolutionChanged: boolean;
  historyWritten: boolean;
};

export type RunIdentityPersistCounts = {
  observed: number;
  inserted: number;
  sourceApplied: number;
  unchanged: number;
  staleRejected: number;
  quarantinedEqualVersion: number;
  quarantinedUnreviewed: number;
  unavailablePreserved: number;
  missingParent: number;
  resolutionRefreshed: number;
  historyRows: number;
  membersActivated: number;
  membersRetired: number;
  resolved: number;
  missing: number;
  ambiguous: number;
  conflict: number;
};

export type RunIdentityPersistResult = { runs: RunIdentityRunResult[]; counts: RunIdentityPersistCounts };

export class RunIdentityPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunIdentityPersistenceError";
  }
}

type CurrentSource = Pick<AvailableRunIdentity, "identityVersion" | "decisionState"> & { payloadDigest: string };

/** Pure source-state decision for one observation against the persisted snapshot. */
export function planSourceTransition(current: CurrentSource | null, observation: RunIdentityObservation): SourceTransition {
  if (observation.availability === "unavailable") return "unavailable_preserved";
  if (current === null) return "inserted";
  if (observation.identityVersion < current.identityVersion) return "stale_rejected";
  if (observation.identityVersion === current.identityVersion) {
    return identityPayloadDigest(observation) === current.payloadDigest ? "unchanged" : "quarantined_equal_version";
  }
  if (observation.decisionState === "unreviewed" && current.decisionState !== "unreviewed") {
    return "quarantined_unreviewed";
  }
  return "source_applied";
}

export type MemberResolution = RunPersonResolution;

/** One checked outcome per accepted person; a source conflict blocks every derived target. */
export function deriveMemberResolutions(
  identity: Pick<AvailableRunIdentity, "peopleIds" | "reviewState">,
  resolutions: ReadonlyMap<string, RunPersonResolution>,
): MemberResolution[] {
  const blocked = isDerivedUseBlocked(identity);
  return identity.peopleIds.map((id) => {
    if (blocked) {
      return { cedarRidgeUserId: id, outcome: "conflict", canonicalContactIdentityId: null, canonicalContactSourceKey: null };
    }
    const resolution = resolutions.get(id);
    if (!resolution) throw new RunIdentityPersistenceError("missing resolution for an accepted person");
    return resolution;
  });
}

/** Consumer-side fingerprint of a run's derived targets, independent of order. */
export function resolutionDigest(members: readonly MemberResolution[]): string {
  const canonical = [...members]
    .sort((a, b) => compareCodePoints(a.cedarRidgeUserId, b.cedarRidgeUserId))
    .map((m) => [m.cedarRidgeUserId, m.outcome, m.canonicalContactIdentityId, m.canonicalContactSourceKey]);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

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
  consumer_revision: number;
  resolution_digest: string;
};

type MemberRow = {
  run_id: string;
  cedar_ridge_user_id: string;
  membership_state: "active" | "retired";
  resolution_outcome: ResolutionOutcome | null;
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

function emptyCounts(observed: number): RunIdentityPersistCounts {
  return {
    observed, inserted: 0, sourceApplied: 0, unchanged: 0, staleRejected: 0, quarantinedEqualVersion: 0,
    quarantinedUnreviewed: 0, unavailablePreserved: 0, missingParent: 0, resolutionRefreshed: 0, historyRows: 0,
    membersActivated: 0, membersRetired: 0, resolved: 0, missing: 0, ambiguous: 0, conflict: 0,
  };
}

const TRANSITION_COUNT: Record<SourceTransition | "missing_parent", keyof RunIdentityPersistCounts> = {
  inserted: "inserted",
  source_applied: "sourceApplied",
  unchanged: "unchanged",
  stale_rejected: "staleRejected",
  quarantined_equal_version: "quarantinedEqualVersion",
  quarantined_unreviewed: "quarantinedUnreviewed",
  unavailable_preserved: "unavailablePreserved",
  missing_parent: "missingParent",
};

function validateObservations(observations: readonly RunIdentityObservation[]): void {
  const seen = new Set<string>();
  for (const observation of observations) {
    if (!isCanonicalUuid(observation.runId)) throw new RunIdentityPersistenceError("observation run id invalid");
    if (seen.has(observation.runId)) throw new RunIdentityPersistenceError("duplicate run in one identity batch");
    seen.add(observation.runId);
    if (observation.schemaVersion !== 1) throw new RunIdentityPersistenceError("unsupported schema version");
    if (observation.availability === "available" && identityInvariantViolation(observation) !== null) {
      throw new RunIdentityPersistenceError("observation violates the run identity contract");
    }
  }
}

const sameTarget = (row: MemberRow, member: MemberResolution) =>
  row.resolution_outcome === member.outcome &&
  row.canonical_contact_identity_id === member.canonicalContactIdentityId &&
  row.canonical_contact_source_key === member.canonicalContactSourceKey;

/**
 * Apply validated observations inside the caller's ingest_rw transaction.
 * Runs that are stale, quarantined or unavailable keep their accepted source
 * state but are still re-resolved against current CRM state.
 */
export async function persistRunIdentities(
  tx: Prisma.TransactionClient,
  observations: readonly RunIdentityObservation[],
): Promise<RunIdentityPersistResult> {
  validateObservations(observations);
  const counts = emptyCounts(observations.length);
  if (observations.length === 0) return { runs: [], counts };
  const runIds = observations.map((o) => o.runId);

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_IDENTITY_SYNC_LOCK_KEY}::bigint)`;

  const parents = new Set((await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM mirror.acat_asset_map_household WHERE id = ANY(${runIds}::text[])`).map((r) => r.id));
  const snapshots = new Map((await tx.$queryRaw<SnapshotRow[]>`
    SELECT run_id, identity_version::text AS identity_version, payload_digest, decision_id, decision_state, coverage,
           people_ids, primary_user_id, cedar_ridge_user_id, review_state, conflict_flags, consumer_revision,
           resolution_digest
      FROM mirror.acat_asset_map_run_identity
     WHERE run_id = ANY(${runIds}::text[])
     ORDER BY run_id
       FOR UPDATE`).map((r) => [r.run_id, r]));
  const memberRows = await tx.$queryRaw<MemberRow[]>`
    SELECT run_id, cedar_ridge_user_id, membership_state, resolution_outcome,
           canonical_contact_identity_id, canonical_contact_source_key
      FROM mirror.acat_asset_map_run_person
     WHERE run_id = ANY(${runIds}::text[])
     ORDER BY run_id, cedar_ridge_user_id
       FOR UPDATE`;
  const membersByRun = new Map<string, Map<string, MemberRow>>();
  for (const row of memberRows) {
    if (!membersByRun.has(row.run_id)) membersByRun.set(row.run_id, new Map());
    membersByRun.get(row.run_id)!.set(row.cedar_ridge_user_id, row);
  }

  type Plan = { observation: RunIdentityObservation; transition: SourceTransition | "missing_parent"; effective: AvailableRunIdentity | null };
  const plans: Plan[] = observations.map((observation) => {
    const current = snapshots.get(observation.runId);
    const currentSource = current
      ? { identityVersion: Number(current.identity_version), decisionState: current.decision_state, payloadDigest: current.payload_digest }
      : null;
    const transition = planSourceTransition(currentSource, observation);
    if (transition === "inserted" && !parents.has(observation.runId)) {
      return { observation, transition: "missing_parent", effective: null };
    }
    const applies = transition === "inserted" || transition === "source_applied";
    const effective = applies ? (observation as AvailableRunIdentity) : current ? storedIdentity(current) : null;
    return { observation, transition, effective };
  });

  const toResolve = new Set<string>();
  for (const plan of plans) {
    if (plan.effective && !isDerivedUseBlocked(plan.effective)) plan.effective.peopleIds.forEach((id) => toResolve.add(id));
  }
  const resolutions = await resolveRunPeople(tx, [...toResolve].sort(compareCodePoints));

  const runs: RunIdentityRunResult[] = [];
  for (const plan of plans) {
    const { observation, transition, effective } = plan;
    counts[TRANSITION_COUNT[transition]]++;
    if (!effective) {
      runs.push({ runId: observation.runId, source: transition, consumerRevision: null, resolutionChanged: false, historyWritten: false });
      continue;
    }
    const current = snapshots.get(observation.runId) ?? null;
    const members = deriveMemberResolutions(effective, resolutions);
    const digest = resolutionDigest(members);
    const sourceChanged = transition === "inserted" || transition === "source_applied";
    const resolutionChanged = current === null || current.resolution_digest !== digest;
    const revision = sourceChanged || resolutionChanged ? (current?.consumer_revision ?? 0) + 1 : current!.consumer_revision;
    const version = String(effective.identityVersion);
    const payloadDigest = identityPayloadDigest(effective);
    const observedAvailability = observation.availability;
    const quarantine = transition === "quarantined_equal_version" ? "equal_version_mutation"
      : transition === "quarantined_unreviewed" ? "unreviewed_after_accepted" : null;
    const quarantinedVersion = quarantine && observation.availability === "available" ? String(observation.identityVersion) : null;
    const quarantinedDigest = quarantine && observation.availability === "available" ? identityPayloadDigest(observation) : null;
    const observes = transition !== "stale_rejected";

    if (current === null) {
      await tx.$executeRaw`
        INSERT INTO mirror.acat_asset_map_run_identity
          (run_id, schema_version, identity_version, payload_digest, decision_id, decision_state, coverage,
           people_ids, primary_user_id, cedar_ridge_user_id, review_state, conflict_flags, consumer_revision,
           resolution_digest, last_observed_availability)
        VALUES (${effective.runId}, 1, ${version}::bigint, ${payloadDigest}, ${effective.decisionId},
                ${effective.decisionState}, ${effective.coverage}, ${effective.peopleIds}::text[],
                ${effective.primaryUserId}, ${effective.cedarRidgeUserId}, ${effective.reviewState},
                ${effective.conflictFlags}::text[], ${revision}, ${digest}, 'available')`;
    } else {
      await tx.$executeRaw`
        UPDATE mirror.acat_asset_map_run_identity SET
          identity_version = ${version}::bigint,
          payload_digest = ${payloadDigest},
          decision_id = ${effective.decisionId},
          decision_state = ${effective.decisionState},
          coverage = ${effective.coverage},
          people_ids = ${effective.peopleIds}::text[],
          primary_user_id = ${effective.primaryUserId},
          cedar_ridge_user_id = ${effective.cedarRidgeUserId},
          review_state = ${effective.reviewState},
          conflict_flags = ${effective.conflictFlags}::text[],
          consumer_revision = ${revision},
          resolution_digest = ${digest},
          resolution_evaluated_at = now(),
          source_applied_at = CASE WHEN ${sourceChanged}::boolean THEN now() ELSE source_applied_at END,
          last_observed_availability = CASE WHEN ${observes}::boolean THEN ${observedAvailability} ELSE last_observed_availability END,
          last_observed_at = CASE WHEN ${observes}::boolean THEN now() ELSE last_observed_at END,
          quarantine_reason = CASE WHEN ${sourceChanged}::boolean THEN NULL WHEN ${quarantine}::text IS NOT NULL THEN ${quarantine} ELSE quarantine_reason END,
          quarantined_identity_version = CASE WHEN ${sourceChanged}::boolean THEN NULL WHEN ${quarantine}::text IS NOT NULL THEN ${quarantinedVersion}::bigint ELSE quarantined_identity_version END,
          quarantined_payload_digest = CASE WHEN ${sourceChanged}::boolean THEN NULL WHEN ${quarantine}::text IS NOT NULL THEN ${quarantinedDigest} ELSE quarantined_payload_digest END,
          quarantined_at = CASE WHEN ${sourceChanged}::boolean THEN NULL WHEN ${quarantine}::text IS NOT NULL THEN now() ELSE quarantined_at END,
          updated_at = now()
        WHERE run_id = ${effective.runId}`;
    }

    const existing = membersByRun.get(effective.runId) ?? new Map<string, MemberRow>();
    const accepted = new Set(effective.peopleIds);
    for (const member of members) {
      const row = existing.get(member.cedarRidgeUserId);
      if (!row) {
        counts.membersActivated++;
        await tx.$executeRaw`
          INSERT INTO mirror.acat_asset_map_run_person
            (run_id, cedar_ridge_user_id, membership_state, first_identity_version, active_since_identity_version,
             last_confirmed_identity_version, resolution_outcome, canonical_contact_identity_id,
             canonical_contact_source_key, resolution_evaluated_at)
          VALUES (${effective.runId}, ${member.cedarRidgeUserId}, 'active', ${version}::bigint, ${version}::bigint,
                  ${version}::bigint, ${member.outcome}, ${member.canonicalContactIdentityId},
                  ${member.canonicalContactSourceKey}, now())`;
      } else if (row.membership_state === "retired") {
        counts.membersActivated++;
        await tx.$executeRaw`
          UPDATE mirror.acat_asset_map_run_person SET
            membership_state = 'active', active_since_identity_version = ${version}::bigint,
            last_confirmed_identity_version = ${version}::bigint, retired_identity_version = NULL, retired_at = NULL,
            resolution_outcome = ${member.outcome}, canonical_contact_identity_id = ${member.canonicalContactIdentityId},
            canonical_contact_source_key = ${member.canonicalContactSourceKey}, resolution_evaluated_at = now(),
            updated_at = now()
          WHERE run_id = ${effective.runId} AND cedar_ridge_user_id = ${member.cedarRidgeUserId}`;
      } else if (sourceChanged || !sameTarget(row, member)) {
        await tx.$executeRaw`
          UPDATE mirror.acat_asset_map_run_person SET
            last_confirmed_identity_version = CASE WHEN ${sourceChanged}::boolean THEN ${version}::bigint ELSE last_confirmed_identity_version END,
            resolution_outcome = ${member.outcome}, canonical_contact_identity_id = ${member.canonicalContactIdentityId},
            canonical_contact_source_key = ${member.canonicalContactSourceKey},
            resolution_evaluated_at = CASE WHEN ${!sameTarget(row, member)}::boolean THEN now() ELSE resolution_evaluated_at END,
            updated_at = now()
          WHERE run_id = ${effective.runId} AND cedar_ridge_user_id = ${member.cedarRidgeUserId}`;
      }
      counts[member.outcome]++;
    }
    if (sourceChanged) {
      for (const row of existing.values()) {
        if (row.membership_state !== "active" || accepted.has(row.cedar_ridge_user_id)) continue;
        counts.membersRetired++;
        await tx.$executeRaw`
          UPDATE mirror.acat_asset_map_run_person SET
            membership_state = 'retired', retired_identity_version = ${version}::bigint, retired_at = now(),
            resolution_outcome = NULL, canonical_contact_identity_id = NULL, canonical_contact_source_key = NULL,
            resolution_evaluated_at = NULL, updated_at = now()
          WHERE run_id = ${effective.runId} AND cedar_ridge_user_id = ${row.cedar_ridge_user_id}`;
      }
    }

    const historyWritten = revision !== current?.consumer_revision;
    if (historyWritten) {
      counts.historyRows++;
      if (!sourceChanged) counts.resolutionRefreshed++;
      const resolutionsJson = JSON.stringify(members.map((m) => ({
        canonical_contact_identity_id: m.canonicalContactIdentityId,
        canonical_contact_source_key: m.canonicalContactSourceKey,
        cedar_ridge_user_id: m.cedarRidgeUserId,
        outcome: m.outcome,
      })));
      await tx.$executeRaw`
        INSERT INTO mirror.acat_asset_map_run_identity_history
          (run_id, consumer_revision, identity_version, payload_digest, decision_id, decision_state, coverage,
           people_ids, primary_user_id, cedar_ridge_user_id, review_state, conflict_flags, resolution_digest,
           resolutions, source_changed, resolution_changed)
        VALUES (${effective.runId}, ${revision}, ${version}::bigint, ${payloadDigest}, ${effective.decisionId},
                ${effective.decisionState}, ${effective.coverage}, ${effective.peopleIds}::text[],
                ${effective.primaryUserId}, ${effective.cedarRidgeUserId}, ${effective.reviewState},
                ${effective.conflictFlags}::text[], ${digest}, ${resolutionsJson}::jsonb, ${sourceChanged},
                ${resolutionChanged})`;
    }
    runs.push({ runId: effective.runId, source: transition, consumerRevision: revision, resolutionChanged, historyWritten });
  }
  return { runs, counts };
}
