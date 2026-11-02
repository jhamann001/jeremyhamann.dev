import "server-only";
import type { Prisma } from "@prisma/client";
import type { MatchStatus } from "@/lib/data/asset-map-link";

// Asset-mapping ACCOUNT-grain person-link STORE seam — Phase 2 slice P2.5. The
// thin data primitives over mirror.acat_asset_map_account_link (migration
// 20260722000000). This is the account analog of lib/data/asset-map-link.ts (the
// folder link): where the folder link is one row per durable folder, this table
// is one row per (durable account × person) — multi-owner native. See
// docs/planning/asset-mapping/phase2-person-link-design.md §8 (§8.4 store, §8.6
// review/atomicity).
//
// DURABLE, FOLDER-SCOPED ACCOUNT KEY (design §8.3, D-h safe default): every
// primitive here is keyed on (source_folder_id, custodian, account_number) — the
// folder-scoped key that is correct under BOTH raw and masked account numbers. The
// person is the 4th key column (cedar_ridge_user_id, NULL for an entity owner),
// resolved by the migration's NULLS-NOT-DISTINCT unique index so at most one entity
// (no-person) row exists per account.
//
// SCOPE SEAM (the asset-map-link.ts idiom): every function takes the caller's `tx`
// and runs inside it, so the CALLER owns the RLS scope — the reconcile pass writes
// under withIngestScope (ingest_rw, GUC-less, the *_ingest_all policy); the ops
// confirm/reject write-back runs under withUserScope (app_rw, the ops
// SELECT/UPDATE/INSERT policies). Keeping scope out of this module keeps the
// primitives pure and unit-testable with a fake tx. Tagged-template params ONLY —
// never string interpolation.
//
// DECIMAL TRAP (carried, cf. asset-map-link.ts): `confidence` is a Postgres numeric
// → a Prisma Decimal at runtime, which does NOT serialize across the RSC boundary.
// The Number()-coercion lives HERE, at the seam — a raw Decimal never leaves this
// file — and a NULL (never scored) stays null, never 0.

/** Ownership roles the store supports. P2.5 derives only PRIMARY | JOINT | ENTITY;
 *  CUSTODIAN | BENEFICIARY are valid CHECK values for forward-compat (§8.4) but are
 *  never produced by P2.5's matcher or actions. */
export type AccountOwnerRole =
  | "PRIMARY"
  | "JOINT"
  | "ENTITY"
  | "CUSTODIAN"
  | "BENEFICIARY";

/** One owner row (mirror.acat_asset_map_account_link). The person + confirmation
 *  fields are nullable — a row is queued (UNMATCHED/NEEDS_REVIEW/AUTO_LINKED) before
 *  a human decides, and an entity row carries no person at all. */
export type AccountLink = {
  sourceFolderId: string;
  custodian: string;
  accountNumber: string;
  cedarRidgeUserId: string | null;
  clientSfId: string | null;
  ownershipRole: AccountOwnerRole;
  isEntity: boolean;
  matchStatus: MatchStatus;
  // last computed score 0.000–1.000; null when never scored (distinct from 0).
  confidence: number | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  syncedAt: Date;
};

// Raw row as the DB returns it (snake_case; confidence is a Decimal at runtime).
type RawAccountLinkRow = {
  source_folder_id: string;
  custodian: string;
  account_number: string;
  cedar_ridge_user_id: string | null;
  client_sf_id: string | null;
  ownership_role: string;
  is_entity: boolean;
  match_status: string;
  confidence: unknown; // Decimal | null at runtime
  confirmed_by: string | null;
  confirmed_at: Date | null;
  synced_at: Date;
};

/** Map a raw DB row to the typed record: Number()-coerce the Decimal `confidence`
 *  (preserving NULL as null, never 0) and carry role/status as their typed unions
 *  (the store only ever writes the known values). */
function rowToAccountLink(r: RawAccountLinkRow): AccountLink {
  return {
    sourceFolderId: r.source_folder_id,
    custodian: r.custodian,
    accountNumber: r.account_number,
    cedarRidgeUserId: r.cedar_ridge_user_id,
    clientSfId: r.client_sf_id,
    ownershipRole: r.ownership_role as AccountOwnerRole,
    isEntity: r.is_entity,
    matchStatus: r.match_status as MatchStatus,
    confidence: r.confidence == null ? null : Number(r.confidence),
    confirmedBy: r.confirmed_by,
    confirmedAt: r.confirmed_at,
    syncedAt: r.synced_at,
  };
}

/** All owner rows for one folder — the review-expand read (every account × person
 *  under the folder). Runs inside the caller's `tx` (RLS-scoped). Empty id → [].
 *  Ordered by account then person (NULLS FIRST → the entity row leads its account). */
export async function listAccountLinksByFolder(
  tx: Prisma.TransactionClient,
  sourceFolderId: string,
): Promise<AccountLink[]> {
  if (!sourceFolderId) return [];
  const rows = await tx.$queryRaw<RawAccountLinkRow[]>`
    SELECT source_folder_id, custodian, account_number, cedar_ridge_user_id,
           client_sf_id, ownership_role, is_entity, match_status, confidence,
           confirmed_by, confirmed_at, synced_at
    FROM mirror.acat_asset_map_account_link
    WHERE source_folder_id = ${sourceFolderId}
    ORDER BY custodian, account_number, cedar_ridge_user_id NULLS FIRST`;
  return rows.map(rowToAccountLink);
}

/** Every owner row in a given tier — the reconcile preserved-set read + the review
 *  queue sweep (NEEDS_REVIEW / AUTO_LINKED / CONFIRMED / REJECTED). Runs inside the
 *  caller's `tx` (RLS-scoped). Ordered most-recently-synced first (parity with
 *  listLinksByStatus). */
export async function listAccountLinksByStatus(
  tx: Prisma.TransactionClient,
  status: MatchStatus,
): Promise<AccountLink[]> {
  const rows = await tx.$queryRaw<RawAccountLinkRow[]>`
    SELECT source_folder_id, custodian, account_number, cedar_ridge_user_id,
           client_sf_id, ownership_role, is_entity, match_status, confidence,
           confirmed_by, confirmed_at, synced_at
    FROM mirror.acat_asset_map_account_link
    WHERE match_status = ${status}
    ORDER BY synced_at DESC`;
  return rows.map(rowToAccountLink);
}

/** One owner-row upsert payload. */
export type AccountLinkInput = {
  sourceFolderId: string;
  custodian: string;
  accountNumber: string;
  cedarRidgeUserId?: string | null;
  clientSfId?: string | null;
  ownershipRole: AccountOwnerRole;
  isEntity: boolean;
  matchStatus: MatchStatus;
  confidence?: number | null;
};

/** Per-owner blind upsert (INSERT ... ON CONFLICT (…4-col key…) DO UPDATE). The
 *  setLink idiom, keyed on the NULLS-NOT-DISTINCT natural key so an entity row
 *  (cedar_ridge_user_id = NULL) upserts to the single per-account entity slot. All
 *  values bind as tagged-template params; `synced_at` is stamped by the DB. Used
 *  ONLY under ingest scope (the machine reconcile write). */
export async function upsertAccountLink(
  tx: Prisma.TransactionClient,
  input: AccountLinkInput,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO mirror.acat_asset_map_account_link
      (source_folder_id, custodian, account_number, cedar_ridge_user_id, client_sf_id,
       ownership_role, is_entity, match_status, confidence)
    VALUES
      (${input.sourceFolderId}, ${input.custodian}, ${input.accountNumber},
       ${input.cedarRidgeUserId ?? null}, ${input.clientSfId ?? null},
       ${input.ownershipRole}, ${input.isEntity}, ${input.matchStatus},
       ${input.confidence ?? null})
    ON CONFLICT (source_folder_id, custodian, account_number, cedar_ridge_user_id) DO UPDATE SET
      client_sf_id   = EXCLUDED.client_sf_id,
      ownership_role = EXCLUDED.ownership_role,
      is_entity      = EXCLUDED.is_entity,
      match_status   = EXCLUDED.match_status,
      confidence     = EXCLUDED.confidence,
      synced_at      = now()`;
}

/** One resolved owner for a write (machine candidate or human decision). */
export type AccountOwner = {
  cedarRidgeUserId: string | null;
  clientSfId: string | null;
  ownershipRole: AccountOwnerRole;
};

/** Machine reconcile write for ONE account. */
export type ReplaceAccountOwnerCandidatesParams = {
  sourceFolderId: string;
  custodian: string;
  accountNumber: string;
  isEntity: boolean;
  matchStatus: MatchStatus;
  confidence: number | null;
  owners: AccountOwner[];
};

// NULL-aware "row is NOT one of the chosen owners" predicate, spelled with the
// `<> ALL(...)` idiom the design calls for but made correct for the entity NULL
// owner (a plain `cedar_ridge_user_id <> ALL(array)` is UNKNOWN when either side is
// NULL, which would wrongly (a) never demote a stale entity row and (b) demote the
// freshly-written entity row itself). `chosenPersonIds` carries only the NON-NULL
// chosen persons; `isEntity` says whether the NULL (entity) owner is among the
// chosen set:
//   • a person row (cedar_ridge_user_id NOT NULL): unchosen ⇔ <> ALL(chosenPersonIds)
//     — correct on a real DB even when chosenPersonIds is empty (`x <> ALL('{}')` = TRUE).
//   • the entity row (cedar_ridge_user_id NULL): unchosen ⇔ NOT isEntity.
// Verified against PG16 (see the migration-rehearsal probe).

/**
 * Atomically rewrite ONE account's MACHINE owner set within the caller's tx (design
 * §8.5). (1) upsert every chosen owner at the tiered match_status (an entity account
 * → one owner with cedarRidgeUserId=null, ownershipRole='ENTITY'); (2) demote every
 * STALE machine row for the account (a person the current scan no longer resolves)
 * to UNMATCHED — re-scoreable, NOT REJECTED. The demote guard restricts to
 * non-terminal rows (match_status IN NEEDS_REVIEW/AUTO_LINKED/UNMATCHED) so a human
 * CONFIRMED/REJECTED owner is NEVER touched — the updateLinkDecision guard idiom,
 * extended to the multi-row account grain. Used ONLY under ingest scope.
 */
export async function replaceAccountOwnerCandidates(
  tx: Prisma.TransactionClient,
  params: ReplaceAccountOwnerCandidatesParams,
): Promise<void> {
  const { sourceFolderId, custodian, accountNumber, isEntity, matchStatus, confidence, owners } =
    params;

  // 1. Upsert each chosen owner at the tiered status. Entity → the single NULL-person
  //    ENTITY row; else one row per resolved person.
  for (const o of owners) {
    await upsertAccountLink(tx, {
      sourceFolderId,
      custodian,
      accountNumber,
      cedarRidgeUserId: o.cedarRidgeUserId,
      clientSfId: o.clientSfId,
      ownershipRole: o.ownershipRole,
      isEntity,
      matchStatus,
      confidence,
    });
  }

  // 2. Demote stale machine rows (non-terminal, not one of the chosen owners) to
  //    UNMATCHED. Terminal (human) rows are untouched by the match_status guard.
  const chosenPersonIds = owners
    .map((o) => o.cedarRidgeUserId)
    .filter((id): id is string => id != null);
  await tx.$executeRaw`
    UPDATE mirror.acat_asset_map_account_link SET
      match_status = 'UNMATCHED',
      client_sf_id = NULL,
      synced_at    = now()
    WHERE source_folder_id = ${sourceFolderId}
      AND custodian        = ${custodian}
      AND account_number   = ${accountNumber}
      AND match_status IN ('NEEDS_REVIEW', 'AUTO_LINKED', 'UNMATCHED')
      AND (
        (cedar_ridge_user_id IS NOT NULL AND cedar_ridge_user_id <> ALL(${chosenPersonIds}::text[]))
        OR (cedar_ridge_user_id IS NULL AND ${isEntity} = false)
      )`;
}

/** Human confirm write for ONE account (the FULL chosen owner set). */
export type ReplaceAccountOwnerDecisionParams = {
  sourceFolderId: string;
  custodian: string;
  accountNumber: string;
  owners: AccountOwner[];
  isEntity: boolean;
  confirmedBy: string | null;
  confirmedAt: Date;
};

/**
 * Write the FULL owner set for one account, ALL-OR-NOTHING (design §8.6). The
 * caller's withUserScope tx gives atomicity — a throw or a false return rolls the
 * whole account back, so an account is never half-saved. Steps (all parameterized):
 *
 *  1. CONFIRM each chosen owner — INSERT … (match_status='CONFIRMED', confirmed_by/at)
 *     ON CONFLICT (…4-col key…) DO UPDATE SET … match_status='CONFIRMED' …
 *     **WHERE acat_asset_map_account_link.match_status IN ('NEEDS_REVIEW','AUTO_LINKED')**.
 *     The DO UPDATE … WHERE is the queued-rows-only RE-DECISION guard: a conflict onto
 *     an already-terminal (CONFIRMED/REJECTED) row updates 0 rows. The INSERT handles
 *     the "reviewer added an owner the matcher didn't queue" case (needs the ops INSERT
 *     grant, §3.3). An ENTITY account has empty `owners` → write ONE row
 *     cedar_ridge_user_id=NULL, client_sf_id=NULL, ownership_role='ENTITY', is_entity=true.
 *  2. SOFT-REJECT the unchosen queued owners — UPDATE … SET match_status='REJECTED',
 *     client_sf_id=NULL, confirmed_by/at … WHERE … match_status IN ('NEEDS_REVIEW',
 *     'AUTO_LINKED') AND <unchosen> (soft-remove, no DELETE — ADR-7). The chosen owners
 *     are already CONFIRMED from step 1, so the status guard excludes them.
 *  3. RETURN the count of CONFIRMED owner rows actually written (the sum of the
 *     per-owner affected counts). The caller treats 0, or a count < owners.length (a
 *     chosen owner collided with a terminal row), as failure → returns FAILURE and the
 *     tx rolls back. `confidence` is NOT written by the human path (preserve the machine
 *     score, the updateLinkDecision rule).
 */
export async function replaceAccountOwnerDecision(
  tx: Prisma.TransactionClient,
  params: ReplaceAccountOwnerDecisionParams,
): Promise<number> {
  const { sourceFolderId, custodian, accountNumber, owners, isEntity, confirmedBy, confirmedAt } =
    params;

  // The rows to CONFIRM: the chosen persons, or the single entity (NULL-person) row.
  const confirmRows: AccountOwner[] = isEntity
    ? [{ cedarRidgeUserId: null, clientSfId: null, ownershipRole: "ENTITY" }]
    : owners;

  // 1. Confirm each chosen owner; sum the affected counts (0 or 1 each). A conflict
  //    onto a terminal row → the DO UPDATE WHERE fails → 0 affected → count short.
  let confirmed = 0;
  for (const o of confirmRows) {
    const n = await tx.$executeRaw`
      INSERT INTO mirror.acat_asset_map_account_link
        (source_folder_id, custodian, account_number, cedar_ridge_user_id, client_sf_id,
         ownership_role, is_entity, match_status, confirmed_by, confirmed_at)
      VALUES
        (${sourceFolderId}, ${custodian}, ${accountNumber}, ${o.cedarRidgeUserId ?? null},
         ${o.clientSfId ?? null}, ${o.ownershipRole}, ${isEntity}, 'CONFIRMED',
         ${confirmedBy}, ${confirmedAt})
      ON CONFLICT (source_folder_id, custodian, account_number, cedar_ridge_user_id) DO UPDATE SET
        match_status   = 'CONFIRMED',
        client_sf_id   = EXCLUDED.client_sf_id,
        ownership_role = EXCLUDED.ownership_role,
        is_entity      = EXCLUDED.is_entity,
        confirmed_by   = EXCLUDED.confirmed_by,
        confirmed_at   = EXCLUDED.confirmed_at,
        synced_at      = now()
      WHERE acat_asset_map_account_link.match_status IN ('NEEDS_REVIEW', 'AUTO_LINKED')`;
    confirmed += Number(n);
  }

  // 2. Soft-reject the unchosen queued owners for this account (chosen rows are now
  //    CONFIRMED, so the status guard already excludes them; the <> ALL clause is the
  //    belt-and-suspenders, NULL-aware for the entity owner).
  const chosenPersonIds = confirmRows
    .map((o) => o.cedarRidgeUserId)
    .filter((id): id is string => id != null);
  await tx.$executeRaw`
    UPDATE mirror.acat_asset_map_account_link SET
      match_status = 'REJECTED',
      client_sf_id = NULL,
      confirmed_by = ${confirmedBy},
      confirmed_at = ${confirmedAt},
      synced_at    = now()
    WHERE source_folder_id = ${sourceFolderId}
      AND custodian        = ${custodian}
      AND account_number   = ${accountNumber}
      AND match_status IN ('NEEDS_REVIEW', 'AUTO_LINKED')
      AND (
        (cedar_ridge_user_id IS NOT NULL AND cedar_ridge_user_id <> ALL(${chosenPersonIds}::text[]))
        OR (cedar_ridge_user_id IS NULL AND ${isEntity} = false)
      )`;

  return confirmed;
}

/** Whole-account reject payload. */
export type RejectAccountOwnersParams = {
  sourceFolderId: string;
  custodian: string;
  accountNumber: string;
  confirmedBy: string | null;
  confirmedAt: Date;
};

/**
 * Whole-account reject — a human declares no owner is right. Marks EVERY queued owner
 * row for the account REJECTED and clears its resolved client id (soft-remove, no
 * DELETE — ADR-7); leaves cedar_ridge_user_id in place so the row's identity (which
 * person it was) is preserved. The match_status guard means a terminal row is never
 * re-touched. Returns the affected count (0 → the caller reports failure). Mirrors
 * rejectLink.
 */
export async function rejectAccountOwners(
  tx: Prisma.TransactionClient,
  params: RejectAccountOwnersParams,
): Promise<number> {
  const { sourceFolderId, custodian, accountNumber, confirmedBy, confirmedAt } = params;
  if (!sourceFolderId || !custodian || !accountNumber) return 0;
  return tx.$executeRaw`
    UPDATE mirror.acat_asset_map_account_link SET
      match_status      = 'REJECTED',
      client_sf_id      = NULL,
      cedar_ridge_user_id = cedar_ridge_user_id,
      confirmed_by      = ${confirmedBy},
      confirmed_at      = ${confirmedAt},
      synced_at         = now()
    WHERE source_folder_id = ${sourceFolderId}
      AND custodian        = ${custodian}
      AND account_number   = ${accountNumber}
      AND match_status IN ('NEEDS_REVIEW', 'AUTO_LINKED')`;
}

/**
 * DETERMINISTIC owner resolver (design §8.2 / §8.5 step 1) — a STRUCTURED NO-OP in
 * P2.5. Returns [] today because a pre-transfer mapping account has no Apex/DriveWealth
 * DESTINATION account yet, so there is nothing to resolve deterministically. The exact
 * future path is documented below; it is deliberately NOT wired live in P2.5 (no
 * mapping account is post-funding). When transfers complete, this will resolve owners
 * from mirror.account_holder on the resolved destination account:
 *
 *   SELECT ah.cedar_ridge_user_id
 *   FROM mirror.account a
 *   JOIN mirror.account_holder ah ON ah.custodian_account_id = a.custodian_account_id
 *   WHERE a.<links back to this mapping account's completed transfer's Apex acct>
 *
 * (mirror.account_holder(custodian_account_id → cedar_ridge_user_id),
 * 20260703180639_mirror_account_ingest/migration.sql:33-38) — an EXACT, CONFIRMED-grade
 * person key. Structured-first now (like §4.2), real once D-g's transfer join exists.
 */
export async function resolveDeterministicOwners(
  _tx: Prisma.TransactionClient,
  _params: { custodian: string; accountNumber: string },
): Promise<{ cedarRidgeUserId: string }[]> {
  return [];
}
