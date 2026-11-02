import { createHash } from "node:crypto";

// Consumer side of the frozen `client_link` v1 contract (acat-run-identity-export).
//
// The source app owns who a run belongs to; this module only validates the
// optional household `client_link` object and projects it into a typed
// observation. It never falls back to the legacy top-level scalar or people
// labels, never coerces a malformed value, and never echoes person ids in its
// failure details (they are opaque client identifiers).

export const RUN_IDENTITY_SCHEMA_VERSION = 1;

export const DECISION_STATES = ["linked", "unlinked", "unreviewed"] as const;
export const COVERAGE_VALUES = ["complete", "partial"] as const;
export const REVIEW_STATES = ["complete", "partial", "unresolved", "conflict"] as const;
export const AVAILABILITY_VALUES = ["available", "unavailable"] as const;
export const UNAVAILABLE_REASONS = ["client_linking_disabled"] as const;
export const RESOLUTION_OUTCOMES = ["resolved", "missing", "ambiguous", "conflict"] as const;

export type DecisionState = (typeof DECISION_STATES)[number];
export type Coverage = (typeof COVERAGE_VALUES)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];
export type Availability = (typeof AVAILABILITY_VALUES)[number];
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

// Explicit safety limits, mirrored by the migration's CHECK constraints. A run
// exceeding one is rejected as malformed (never truncated).
export const MAX_PEOPLE_PER_RUN = 100;
export const MAX_PERSON_ID_LENGTH = 512;
export const MAX_CONFLICT_FLAGS = 32;
export const MAX_CONFLICT_FLAG_LENGTH = 64;

export type AvailableRunIdentity = {
  runId: string;
  schemaVersion: typeof RUN_IDENTITY_SCHEMA_VERSION;
  availability: "available";
  identityVersion: number;
  decisionId: string | null;
  decisionState: DecisionState;
  peopleIds: string[];
  coverage: Coverage;
  primaryUserId: string | null;
  cedarRidgeUserId: string | null;
  reviewState: ReviewState;
  conflictFlags: string[];
};

export type UnavailableRunIdentity = {
  runId: string;
  schemaVersion: typeof RUN_IDENTITY_SCHEMA_VERSION;
  availability: "unavailable";
  reason: UnavailableReason;
};

export type RunIdentityObservation = AvailableRunIdentity | UnavailableRunIdentity;

export type RunIdentityParseFailure = {
  ok: false;
  reason: "missing" | "unsupported_schema_version" | "malformed";
  detail: string;
};

export type RunIdentityParseResult = { ok: true; value: RunIdentityObservation } | RunIdentityParseFailure;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AVAILABLE_KEYS = [
  "availability", "conflict_flags", "coverage", "decision_id", "decision_state", "cedar_ridge_user_id",
  "identity_version", "people_ids", "primary_user_id", "review_state", "schema_version",
].sort();
const UNAVAILABLE_KEYS = ["availability", "reason", "schema_version"].sort();

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Unicode code-point order — the producer's `sorted()` order, and PostgreSQL COLLATE "C" on UTF-8. */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

function isStrictlySortedSet(values: string[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (compareCodePoints(values[i - 1], values[i]) >= 0) return false;
  }
  return true;
}

function isOpaqueString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim() !== "" && Array.from(value).length <= maxLength;
}

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function malformed(detail: string): RunIdentityParseFailure {
  return { ok: false, reason: "malformed", detail };
}

function hasExactKeys(object: Record<string, unknown>, keys: string[]): boolean {
  const present = Object.keys(object).filter((k) => object[k] !== undefined).sort();
  return present.length === keys.length && present.every((k, i) => k === keys[i]);
}

/** Expected scalar projection: explicit primary, else the sole person of a complete singleton. */
export function expectedCedarRidgeUserId(
  identity: Pick<AvailableRunIdentity, "primaryUserId" | "coverage" | "peopleIds">,
): string | null {
  if (identity.primaryUserId !== null) return identity.primaryUserId;
  return identity.coverage === "complete" && identity.peopleIds.length === 1 ? identity.peopleIds[0] : null;
}

/** Expected review state derived from conflicts, coverage and the accepted set. */
export function expectedReviewState(
  identity: Pick<AvailableRunIdentity, "conflictFlags" | "coverage" | "peopleIds">,
): ReviewState {
  if (identity.conflictFlags.length > 0) return "conflict";
  return identity.peopleIds.length > 0 ? identity.coverage : "unresolved";
}

/** Contract invariants for an already-typed identity. Returns a static reason or null. */
export function identityInvariantViolation(identity: AvailableRunIdentity): string | null {
  const people = identity.peopleIds;
  if (!isCanonicalUuid(identity.runId)) return "run id must be a lowercase UUID";
  if (!Number.isSafeInteger(identity.identityVersion) || identity.identityVersion < 0) return "identity_version invalid";
  if (identity.decisionId !== null && !isCanonicalUuid(identity.decisionId)) return "decision_id invalid";
  if (people.length > MAX_PEOPLE_PER_RUN) return "people_ids exceeds the safety cap";
  if (!people.every((p) => isOpaqueString(p, MAX_PERSON_ID_LENGTH))) return "people_ids contains an invalid id";
  if (!isStrictlySortedSet(people)) return "people_ids must be sorted and distinct";
  if (identity.conflictFlags.length > MAX_CONFLICT_FLAGS) return "conflict_flags exceeds the safety cap";
  if (!identity.conflictFlags.every((f) => isOpaqueString(f, MAX_CONFLICT_FLAG_LENGTH))) return "conflict flag invalid";
  if (!isStrictlySortedSet(identity.conflictFlags)) return "conflict_flags must be sorted and distinct";
  switch (identity.decisionState) {
    case "linked":
      if (people.length === 0) return "linked requires accepted people";
      if (identity.decisionId === null) return "linked requires a decision id";
      break;
    case "unlinked":
      if (people.length !== 0) return "unlinked requires an empty set";
      break;
    case "unreviewed":
      if (people.length !== 0) return "unreviewed requires an empty set";
      if (identity.decisionId !== null) return "unreviewed has no decision id";
      break;
  }
  if (people.length === 0 && identity.coverage !== "partial") return "an empty set is partial coverage";
  if (identity.primaryUserId !== null && !people.includes(identity.primaryUserId)) return "primary must be accepted";
  if (identity.cedarRidgeUserId !== expectedCedarRidgeUserId(identity)) return "cedar_ridge_user_id projection mismatch";
  if (identity.reviewState !== expectedReviewState(identity)) return "review_state mismatch";
  return null;
}

/**
 * Validate one household's optional `client_link` object. `runId` is the
 * containing household `id` (the immutable source run UUID).
 */
export function parseRunIdentity(runId: unknown, clientLink: unknown): RunIdentityParseResult {
  if (clientLink === undefined || clientLink === null) {
    return { ok: false, reason: "missing", detail: "client_link absent" };
  }
  if (!isCanonicalUuid(runId)) return malformed("run id must be a lowercase UUID");
  if (typeof clientLink !== "object" || Array.isArray(clientLink)) return malformed("client_link must be an object");
  const raw = clientLink as Record<string, unknown>;

  const version = raw.schema_version;
  if (typeof version !== "number" || !Number.isInteger(version)) return malformed("schema_version invalid");
  if (version !== RUN_IDENTITY_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema_version", detail: "schema_version unsupported" };
  }
  if (!isMember(AVAILABILITY_VALUES, raw.availability)) return malformed("availability invalid");

  if (raw.availability === "unavailable") {
    if (!hasExactKeys(raw, UNAVAILABLE_KEYS)) return malformed("unavailable object has unexpected fields");
    if (!isMember(UNAVAILABLE_REASONS, raw.reason)) return malformed("unavailable reason invalid");
    return { ok: true, value: { runId, schemaVersion: 1, availability: "unavailable", reason: raw.reason } };
  }

  if (!hasExactKeys(raw, AVAILABLE_KEYS)) return malformed("available object has unexpected or missing fields");
  if (typeof raw.identity_version !== "number") return malformed("identity_version invalid");
  if (raw.decision_id !== null && typeof raw.decision_id !== "string") return malformed("decision_id invalid");
  if (!isMember(DECISION_STATES, raw.decision_state)) return malformed("decision_state invalid");
  if (!isMember(COVERAGE_VALUES, raw.coverage)) return malformed("coverage invalid");
  if (!isMember(REVIEW_STATES, raw.review_state)) return malformed("review_state invalid");
  if (!Array.isArray(raw.people_ids) || !raw.people_ids.every((p) => typeof p === "string")) {
    return malformed("people_ids must be strings");
  }
  if (!Array.isArray(raw.conflict_flags) || !raw.conflict_flags.every((f) => typeof f === "string")) {
    return malformed("conflict_flags must be strings");
  }
  for (const field of ["primary_user_id", "cedar_ridge_user_id"] as const) {
    if (raw[field] !== null && typeof raw[field] !== "string") return malformed(`${field} invalid`);
  }

  const identity: AvailableRunIdentity = {
    runId,
    schemaVersion: 1,
    availability: "available",
    identityVersion: raw.identity_version,
    decisionId: raw.decision_id as string | null,
    decisionState: raw.decision_state,
    peopleIds: [...(raw.people_ids as string[])],
    coverage: raw.coverage,
    primaryUserId: raw.primary_user_id as string | null,
    cedarRidgeUserId: raw.cedar_ridge_user_id as string | null,
    reviewState: raw.review_state,
    conflictFlags: [...(raw.conflict_flags as string[])],
  };
  const violation = identityInvariantViolation(identity);
  return violation ? malformed(violation) : { ok: true, value: identity };
}

/** A current source conflict keeps accepted people but blocks any derived target. */
export function isDerivedUseBlocked(identity: Pick<AvailableRunIdentity, "reviewState">): boolean {
  return identity.reviewState === "conflict";
}

/** Canonical identity equality form: excludes version, schema, availability and the run id. */
export function canonicalIdentityJson(identity: AvailableRunIdentity): string {
  return JSON.stringify({
    conflict_flags: identity.conflictFlags,
    coverage: identity.coverage,
    decision_id: identity.decisionId,
    decision_state: identity.decisionState,
    cedar_ridge_user_id: identity.cedarRidgeUserId,
    people_ids: identity.peopleIds,
    primary_user_id: identity.primaryUserId,
    review_state: identity.reviewState,
  });
}

export function identityPayloadDigest(identity: AvailableRunIdentity): string {
  return createHash("sha256").update(canonicalIdentityJson(identity), "utf8").digest("hex");
}
