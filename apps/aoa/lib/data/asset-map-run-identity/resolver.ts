import "server-only";
import type { Prisma } from "@prisma/client";

import {
  MAX_PERSON_ID_LENGTH,
  RESOLUTION_OUTCOMES,
  type ResolutionOutcome,
} from "./contract";

// Exact CedarRidge-ID → canonical AoA CONTACT resolution through the checked
// SECURITY DEFINER function app.resolve_asset_map_run_people (EXECUTE: ingest_rw
// only). The function walks confirmed contact-duplicate chains with explicit
// branch/cycle/depth/type/lifecycle/compatibility checks; it never falls back
// to its input the way app.resolve_crm_canonical_contact_source_key does.

/** Mirrors the SQL function's explicit per-call bound. */
export const RESOLVER_BATCH_LIMIT = 1000;

export type RunPersonResolution = {
  cedarRidgeUserId: string;
  outcome: ResolutionOutcome;
  canonicalContactIdentityId: string | null;
  canonicalContactSourceKey: string | null;
};

/** The resolver could not produce a trustworthy answer; the identity phase must fail, not guess. */
export class RunIdentityResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunIdentityResolverError";
  }
}

type ResolverRow = {
  cedar_ridge_user_id: string;
  outcome: string;
  canonical_contact_identity_id: string | null;
  canonical_contact_source_key: string | null;
};

function assertRequest(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() === "" || Array.from(id).length > MAX_PERSON_ID_LENGTH) {
      throw new RunIdentityResolverError("resolver request contains an invalid Cedar Ridge id");
    }
    if (seen.has(id)) throw new RunIdentityResolverError("resolver request contains a duplicate Cedar Ridge id");
    seen.add(id);
  }
}

function toResolution(row: ResolverRow): RunPersonResolution {
  if (!(RESOLUTION_OUTCOMES as readonly string[]).includes(row.outcome)) {
    throw new RunIdentityResolverError("resolver returned an unknown outcome");
  }
  const hasTarget = row.canonical_contact_identity_id !== null && row.canonical_contact_source_key !== null;
  const hasPartialTarget = row.canonical_contact_identity_id !== null || row.canonical_contact_source_key !== null;
  if (row.outcome === "resolved" ? !hasTarget : hasPartialTarget) {
    throw new RunIdentityResolverError("resolver returned an inconsistent target");
  }
  return {
    cedarRidgeUserId: row.cedar_ridge_user_id,
    outcome: row.outcome as ResolutionOutcome,
    canonicalContactIdentityId: row.canonical_contact_identity_id,
    canonicalContactSourceKey: row.canonical_contact_source_key,
  };
}

/**
 * Resolve distinct exact Cedar Ridge ids inside the caller's ingest transaction.
 * Returns exactly one checked outcome per requested id.
 */
export async function resolveRunPeople(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
): Promise<Map<string, RunPersonResolution>> {
  assertRequest(ids);
  const result = new Map<string, RunPersonResolution>();
  for (let start = 0; start < ids.length; start += RESOLVER_BATCH_LIMIT) {
    const batch = ids.slice(start, start + RESOLVER_BATCH_LIMIT);
    const requested = new Set(batch);
    const rows = await tx.$queryRaw<ResolverRow[]>`
      SELECT cedar_ridge_user_id, outcome, canonical_contact_identity_id, canonical_contact_source_key
        FROM app.resolve_asset_map_run_people(${batch}::text[])`;
    for (const row of rows) {
      if (!requested.has(row.cedar_ridge_user_id) || result.has(row.cedar_ridge_user_id)) {
        throw new RunIdentityResolverError("resolver returned an unrequested or duplicate id");
      }
      result.set(row.cedar_ridge_user_id, toResolution(row));
    }
    if (batch.some((id) => !result.has(id))) {
      throw new RunIdentityResolverError("resolver omitted a requested id");
    }
  }
  return result;
}
