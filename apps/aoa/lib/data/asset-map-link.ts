import "server-only";
import type { Prisma } from "@prisma/client";

// Asset-mapping person-link STORE seam — Phase 2 slice P2.0. The thin data
// primitives over mirror.acat_asset_map_link (migration 20260719000000). See
// docs/planning/asset-mapping/phase2-person-link-design.md (§4.1).
//
// DURABLE KEY: every primitive here is keyed on `source_folder_id` (the Google
// Drive folder id), the ONLY household identity stable across re-scans — NOT the
// per-version acat_asset_map_household UUID (design §1 / §4.1, D-a). One
// confirmation on a folder id survives every future version of that household.
//
// NO MATCHING LOGIC HERE (design §7, P2.0). This module is only the store's
// read/upsert seam — the record type, two RLS-scoped reads, and one upsert. The
// normalization + candidate generation (P2.1), the reconcile/scoring pass
// (P2.2), and the ops review UI + confirm write-back (P2.3) are LATER slices
// that CONSUME these primitives; none of that scoring/UI lives here.
//
// SCOPE SEAM: like lib/data/deal-stage-write.ts, every function takes the
// caller's `tx` (a Prisma.TransactionClient) and runs inside it, so the CALLER
// owns the RLS scope — ops reads run the queue under `withUserScope` (the
// acat_asset_map_link_ops_all policy effectively scopes current users to ADMIN/OPERATIONS);
// the reconcile pass and the confirm/reject write-back run under
// `withIngestScope` (acat_asset_map_link_ingest_all, GUC-less). Keeping scope out
// of this module keeps the primitives pure and unit-testable with a fake tx.
//
// DECIMAL TRAP (carried, cf. lib/data/account-aum.ts): `confidence` is a Postgres
// numeric → a Prisma Decimal at runtime, which does NOT serialize across the RSC
// boundary. The Number()-coercion lives HERE, at the seam — a raw Decimal never
// leaves this file — and a NULL (never scored) stays null, never 0.

/** The match_status tiers, verbatim from the design (§4.1). */
export type MatchStatus =
  | "UNMATCHED"
  | "AUTO_LINKED"
  | "NEEDS_REVIEW"
  | "CONFIRMED"
  | "REJECTED";

/** One durable link row (mirror.acat_asset_map_link). The resolved-link and
 *  confirmation fields are all nullable — a row is queued (UNMATCHED) long
 *  before anything/anyone resolves it. */
export type AssetMapLink = {
  sourceFolderId: string;
  clientSfId: string | null;
  cedarRidgeUserId: string | null;
  householdSfId: string | null;
  matchStatus: MatchStatus;
  // last computed score 0.000–1.000; null when never scored (distinct from 0).
  confidence: number | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  syncedAt: Date;
};

/** The P2.3 ops confirm/reject payload. A human decision only ever mutates an
 *  ALREADY-QUEUED row (a plain UPDATE, never an insert), so — unlike
 *  AssetMapLinkInput — `confirmedBy`/`confirmedAt` are REQUIRED (every human
 *  write is stamped) and there is no create path. `confidence` is intentionally
 *  absent: a human decision preserves the last machine-computed score for
 *  display (design §4.2), it does not recompute it. */
export type LinkDecisionInput = {
  sourceFolderId: string;
  /** The human tiers only — 'CONFIRMED' (ids bound) or 'REJECTED' (ids cleared). */
  matchStatus: Extract<MatchStatus, "CONFIRMED" | "REJECTED">;
  clientSfId?: string | null;
  cedarRidgeUserId?: string | null;
  householdSfId?: string | null;
  confirmedBy: string | null;
  confirmedAt: Date;
};

/** The upsert payload. Only `sourceFolderId` + `matchStatus` are required; the
 *  resolved-link / confirmation fields default to NULL (a freshly-queued row
 *  carries no link yet). All fields bind as tagged-template params — never
 *  string-interpolated. */
export type AssetMapLinkInput = {
  sourceFolderId: string;
  clientSfId?: string | null;
  cedarRidgeUserId?: string | null;
  householdSfId?: string | null;
  matchStatus: MatchStatus;
  confidence?: number | null;
  confirmedBy?: string | null;
  confirmedAt?: Date | null;
};

// Raw row as the DB returns it (snake_case; confidence is a Decimal at runtime).
type RawLinkRow = {
  source_folder_id: string;
  client_sf_id: string | null;
  cedar_ridge_user_id: string | null;
  household_sf_id: string | null;
  match_status: string;
  confidence: unknown; // Decimal | null at runtime
  confirmed_by: string | null;
  confirmed_at: Date | null;
  synced_at: Date;
};

/** Map a raw DB row to the typed record: Number()-coerce the Decimal
 *  `confidence` (preserving NULL as null, never 0) and carry match_status as the
 *  typed union (the store only ever writes the known tiers). */
function rowToLink(r: RawLinkRow): AssetMapLink {
  return {
    sourceFolderId: r.source_folder_id,
    clientSfId: r.client_sf_id,
    cedarRidgeUserId: r.cedar_ridge_user_id,
    householdSfId: r.household_sf_id,
    matchStatus: r.match_status as MatchStatus,
    confidence: r.confidence == null ? null : Number(r.confidence),
    confirmedBy: r.confirmed_by,
    confirmedAt: r.confirmed_at,
    syncedAt: r.synced_at,
  };
}

/** The one link for a durable household folder, or null if none is stored yet.
 *  Runs inside the caller's `tx` (RLS-scoped by the caller). Empty id → null. */
export async function getLink(
  tx: Prisma.TransactionClient,
  sourceFolderId: string,
): Promise<AssetMapLink | null> {
  if (!sourceFolderId) return null;
  const rows = await tx.$queryRaw<RawLinkRow[]>`
    SELECT source_folder_id, client_sf_id, cedar_ridge_user_id, household_sf_id,
           match_status, confidence, confirmed_by, confirmed_at, synced_at
    FROM mirror.acat_asset_map_link
    WHERE source_folder_id = ${sourceFolderId}
    LIMIT 1`;
  const r = rows[0];
  return r ? rowToLink(r) : null;
}

/** Every link in a given tier — the review-queue read primitive (P2.3), which
 *  filters on NEEDS_REVIEW / UNMATCHED / AUTO_LINKED. Runs inside the caller's
 *  `tx` (RLS-scoped). Ordered most-recently-synced first so the freshest
 *  scoring surfaces at the top of the queue. */
export async function listLinksByStatus(
  tx: Prisma.TransactionClient,
  status: MatchStatus,
): Promise<AssetMapLink[]> {
  const rows = await tx.$queryRaw<RawLinkRow[]>`
    SELECT source_folder_id, client_sf_id, cedar_ridge_user_id, household_sf_id,
           match_status, confidence, confirmed_by, confirmed_at, synced_at
    FROM mirror.acat_asset_map_link
    WHERE match_status = ${status}
    ORDER BY synced_at DESC`;
  return rows.map(rowToLink);
}

/** Upsert the link for a durable folder id (INSERT ... ON CONFLICT
 *  (source_folder_id) DO UPDATE). All values bind as tagged-template params —
 *  NO string interpolation. `synced_at` is stamped by the DB (now()) on every
 *  write, matching the mirror idiom. Runs inside the caller's `tx` (writes under
 *  ingest scope per design §4.1). The absent optional fields resolve to NULL. */
export async function setLink(
  tx: Prisma.TransactionClient,
  input: AssetMapLinkInput,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO mirror.acat_asset_map_link
      (source_folder_id, client_sf_id, cedar_ridge_user_id, household_sf_id,
       match_status, confidence, confirmed_by, confirmed_at)
    VALUES
      (${input.sourceFolderId}, ${input.clientSfId ?? null}, ${input.cedarRidgeUserId ?? null},
       ${input.householdSfId ?? null}, ${input.matchStatus}, ${input.confidence ?? null},
       ${input.confirmedBy ?? null}, ${input.confirmedAt ?? null})
    ON CONFLICT (source_folder_id) DO UPDATE SET
      client_sf_id      = EXCLUDED.client_sf_id,
      cedar_ridge_user_id = EXCLUDED.cedar_ridge_user_id,
      household_sf_id   = EXCLUDED.household_sf_id,
      match_status      = EXCLUDED.match_status,
      confidence        = EXCLUDED.confidence,
      confirmed_by      = EXCLUDED.confirmed_by,
      confirmed_at      = EXCLUDED.confirmed_at,
      synced_at         = now()`;
}

/** P2.3 ops confirm/reject write-back. A HUMAN decision on an ALREADY-QUEUED
 *  row — a plain, parameterized UPDATE keyed on the durable folder id, NOT an
 *  INSERT ... ON CONFLICT. This is deliberate: the P2.3 grant gives app_rw
 *  UPDATE ONLY (migration 20260720000000), never INSERT, so the human path can
 *  only act on a row the machine already queued — it can never mint one. Under
 *  the caller's `withUserScope` tx, the app_rw ops UPDATE RLS policy
 *  (acat_asset_map_link_ops_update) polices it: a non-ops role matches no policy
 *  and the UPDATE touches ZERO rows (fails closed).
 *
 *  Returns the affected row count. The caller treats 0 as a rejection — the
 *  folder was not a real queued row OR RLS denied the write (a VIEWER, an
 *  advisor). `confidence` is NOT written (a human decision keeps the last
 *  machine score for display, design §4.2); `synced_at` is stamped by the DB.
 *  CONFIRM binds the resolved ids; REJECT passes them as null to clear them. */
export async function updateLinkDecision(
  tx: Prisma.TransactionClient,
  input: LinkDecisionInput,
): Promise<number> {
  if (!input.sourceFolderId) return 0;
  return tx.$executeRaw`
    UPDATE mirror.acat_asset_map_link SET
      client_sf_id      = ${input.clientSfId ?? null},
      cedar_ridge_user_id = ${input.cedarRidgeUserId ?? null},
      household_sf_id   = ${input.householdSfId ?? null},
      match_status      = ${input.matchStatus},
      confirmed_by      = ${input.confirmedBy},
      confirmed_at      = ${input.confirmedAt},
      synced_at         = now()
    WHERE source_folder_id = ${input.sourceFolderId}
      -- Queued rows only: a human decision applies to a machine-tier row, never
      -- clobbers an already-terminal one. Re-deciding a CONFIRMED/REJECTED link
      -- (stale tab, crafted request) matches 0 rows → the action reports failure
      -- rather than silently overwriting confirmed_by. (AUTO_LINKED→CONFIRMED
      -- graduation is preserved.)
      AND match_status IN ('NEEDS_REVIEW', 'AUTO_LINKED')`;
}
