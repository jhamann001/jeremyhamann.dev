// Deal → transfer sync reconciler (ticket Slice 4, blueprint §3 S4 + §1.5b).
// PURE — NO Prisma / Next imports — so the unit tests and the cron route consume
// it through the same signatures without touching the client (the transfer /
// deals contract-module idiom). The route reads app.deal via the deals seam and
// writes app.transfer via `withIngestScope`; ALL of the decision logic lives
// here, side-effect-free and exhaustively unit-tested.

import type { DealRow } from "./deal-types";
import type { FundingType, TransferInput, TransferStage } from "./transfer-types";

// The TRANSFER-side columns the sync may write/overwrite on re-sync — the
// deal-owned projection. NEVER checklist/funding/owner/acat workflow state:
// those belong to ops and the sync must never clobber them (idempotent
// re-sync = noop). EXCEPTION — `stage`: not in this set, but the sync DOES
// advance it forward-only from the deal stage (deal pipeline is the source of
// truth for deal-sourced transfers); see SyncUpdateChanges + reconcileAction. Each maps FROM a deal column; the ONLY rename is
// transfer.value ⟵ app.deal.amount (the deal has NO `value` column — its money
// column is `amount: number`, coerced at the deals seam). `deal_id` is the
// immutable sync KEY: set on CREATE only, never re-written, so it is
// deliberately ABSENT from this set.
//
//   transfer.value             ⟵ deal.amount            (the rename)
//   transfer.transferring_firm ⟵ deal.transferring_firm
//   transfer.deal_sf_id        ⟵ deal.sf_deal_id
//   transfer.client_*/household_* ⟵ same-named deal columns
export const DEAL_OWNED_FIELDS = [
  "client_first_name",
  "client_last_name",
  "client_sf_id",
  "household_name",
  "household_sf_id",
  "value",
  "transferring_firm",
  "deal_sf_id",
] as const;
export type DealOwnedField = (typeof DEAL_OWNED_FIELDS)[number];

// The subset of TransferInput the sync overwrites on `update` — deal-owned
// fields only. `changes` carries just the fields that actually differ.
export type DealOwnedChanges = Partial<Pick<TransferInput, DealOwnedField>>;

// ---------------------------------------------------------------------------
// Deal-driven transfer stage (ticket sync-stage-mapping).
// ---------------------------------------------------------------------------
// The deal pipeline is the SOURCE OF TRUTH for a deal-sourced transfer's stage.
// This maps the three create/advance-eligible deal stages to their transfer
// stage (labels in deal-types.STAGE_LABEL / transfer-types.STAGE_LABEL):
//   COMMITTED (Potential-Committed)  → DECISION     (create/advance)
//   FUNDING   (Potential-In Process) → IN_TRANSFER  (create/advance)
//   WON       (Funded)               → FUNDED       (create/advance)
// POTENTIAL is deliberately ABSENT (it never materializes a transfer — the
// uncommitted-guard owns it); LOST / archived deals archive their transfer.
// So the map covers ONLY the stages `buildSyncTransferInput` is called for and
// that the update path advances toward.
export const DEAL_STAGE_TO_TRANSFER_STAGE: Record<
  "COMMITTED" | "FUNDING" | "WON",
  TransferStage
> = {
  COMMITTED: "DECISION",
  FUNDING: "IN_TRANSFER",
  WON: "FUNDED",
};

// Narrowing predicate: which deal stages drive a transfer stage (create/advance
// eligible). `reconcileAction` and `buildSyncTransferInput` share ONE
// definition so they can never disagree on the mapped-stage set.
export function isSyncStageMapped(
  stage: DealRow["stage"],
): stage is keyof typeof DEAL_STAGE_TO_TRANSFER_STAGE {
  return stage === "COMMITTED" || stage === "FUNDING" || stage === "WON";
}

// Pipeline rank for the FORWARD-ONLY stage advance: DECISION < IN_TRANSFER <
// FUNDED. The sync advances a transfer's stage toward its deal's mapped stage
// but NEVER regresses it (an advisor who pushed a transfer ahead of its deal is
// never pulled back). `target` is always one of the three ranked stages (0/1/2),
// so the only invariant that matters is: advance strictly forward, never regress.
// Physically-inert enum values (DISCOVERY/ACCOUNTS_OPEN, see transfer-types) are
// unranked → `stageRank` returns -1; they're unreachable post-Slice-1 (those rows
// were remapped to DECISION), but note the direction if one ever appeared: since
// `target(0..2) > -1` is always true, such a stray row would be ADVANCED to its
// mapped stage (benign healing of a collapsed stage) — never regressed.
const TRANSFER_STAGE_RANK: Record<TransferStage, number> = {
  DECISION: 0,
  IN_TRANSFER: 1,
  FUNDED: 2,
};
export function stageRank(stage: TransferStage): number {
  return TRANSFER_STAGE_RANK[stage] ?? -1;
}

// The sync's `update` payload: the deal-owned field diffs PLUS an OPTIONAL
// forward-only `stage` advance. `stage` is deliberately NOT a DEAL_OWNED_FIELD
// (it is not a field-diff — it follows the forward-only rank rule, never a
// symmetric compare), and `dealOwnedChanges` stays stage-free; the two are
// composed only here and in `reconcileAction`. This is the sync's INTENTIONAL
// departure from the prior "never write workflow columns" invariant — see
// reconcileAction's doc + the route's applyAction.
// `sync_flag` is the AUTO-HEAL leg (transfer-syncflag-surface): a transfer the
// sync flagged for review (uncommitted_review / orphan_review) whose deal is
// BACK in a driving stage (COMMITTED/FUNDING/WON) has a stale flag — the deal
// un-regressed, so the "deal regressed" marker clears. Only ever `null` here:
// the sync SETS a flag exclusively through the `flag` action, never via update.
export type SyncUpdateChanges = DealOwnedChanges & {
  stage?: TransferStage;
  sync_flag?: null;
};

// The minimal existing-transfer projection the reconciler needs: the deal-owned
// fields (for change detection on update) + the progressed-guard predicate
// inputs (§1.5b) + `archived_at` (don't re-archive / don't resurrect). The route
// builds this from the Prisma row (value coerced with Number() at that seam).
export type ExistingTransfer = {
  id: string;
  // The immutable sync KEY (nullable: legacy/manually-created transfers have no
  // deal). §4.1 orphan sweep matches this against the active-deal id set; the
  // route coerces it from the Prisma row. Not a deal-owned field — never written.
  deal_id: string | null;
  stage: TransferStage;
  funding_type: FundingType | null;
  client_first_name: string;
  client_last_name: string;
  client_sf_id: string | null;
  household_name: string | null;
  household_sf_id: string | null;
  value: number;
  transferring_firm: string | null;
  deal_sf_id: string | null;
  accounts_opened_at_apex: boolean;
  funding_plan_complete: boolean;
  funding_plan_version: number;
  funding_route_change_pending?: boolean;
  funding_initiated: boolean;
  cash_in_flight: boolean;
  acat_transfer_id: string | null;
  // The robust Transfer-Tracker key (#151): set precisely when acat_transfer_id may
  // be absent/"N/A". isPristine treats a set value as live linkage → NOT
  // pristine, so the orphan sweep flags (never auto-archives) such a transfer.
  acat_record_id: string | null;
  archived_at: Date | null;
  // The review marker the sync itself stamps (uncommitted_review /
  // orphan_review). Read on the update path ONLY for the auto-heal: a deal back
  // in a driving stage clears a stale flag (SyncUpdateChanges.sync_flag).
  sync_flag: string | null;
};

export type ReconcileAction =
  | { kind: "create"; input: TransferInput }
  | { kind: "update"; changes: SyncUpdateChanges }
  | { kind: "archive"; reason: "deal_lost" | "uncommitted" | "deal_gone" }
  | { kind: "flag"; sync_flag: "uncommitted_review" | "orphan_review" }
  | { kind: "noop" };

// The deal-owned projection as concrete values (both create and update read it,
// so the two can never disagree on the mapping — the seam-`coerce` idiom). All
// eight fields are present; `value` is the ONLY rename (⟵ deal.amount).
function dealOwnedProjection(
  deal: DealRow,
): Required<Pick<TransferInput, DealOwnedField>> {
  return {
    client_first_name: deal.client_first_name,
    client_last_name: deal.client_last_name,
    client_sf_id: deal.client_sf_id,
    household_name: deal.household_name,
    household_sf_id: deal.household_sf_id,
    value: deal.amount,
    transferring_firm: deal.transferring_firm,
    deal_sf_id: deal.sf_deal_id,
  };
}

/**
 * The transfer a create-eligible deal (COMMITTED/FUNDING/WON) with NO transfer
 * should be created as: source IMPORT (the reserved backfill producer, §1.5g),
 * owner CLIENT_SERVICE, the deal-owned projection (incl. value ⟵ amount), the
 * immutable create-only key `deal_id` ⟵ deal.id, and `stage` = the deal-mapped
 * transfer stage (DEAL_STAGE_TO_TRANSFER_STAGE) — NOT hardcoded DECISION, so a
 * deal already in-process/funded materializes at IN_TRANSFER/FUNDED. Only ever
 * called for a mapped stage; the `: "DECISION"` ternary branch is a defensive
 * fallback (the reconcile guard makes it unreachable).
 */
export function buildSyncTransferInput(deal: DealRow): TransferInput {
  return {
    source: "IMPORT",
    stage: isSyncStageMapped(deal.stage)
      ? DEAL_STAGE_TO_TRANSFER_STAGE[deal.stage]
      : "DECISION",
    owner_kind: "CLIENT_SERVICE",
    ...dealOwnedProjection(deal),
    deal_id: deal.id, // create-only sync KEY — NOT in DEAL_OWNED_FIELDS
  };
}

/**
 * The deal-owned fields whose transfer value differs from the deal — the
 * `update` payload. Empty ⇒ nothing to write ⇒ `noop` (idempotent re-sync).
 * Explicit per-field comparison (no index-typed loop) keeps it fully type-safe.
 */
export function dealOwnedChanges(
  deal: DealRow,
  existing: ExistingTransfer,
): DealOwnedChanges {
  const desired = dealOwnedProjection(deal);
  const changes: DealOwnedChanges = {};
  if (desired.client_first_name !== existing.client_first_name)
    changes.client_first_name = desired.client_first_name;
  if (desired.client_last_name !== existing.client_last_name)
    changes.client_last_name = desired.client_last_name;
  if (desired.client_sf_id !== existing.client_sf_id)
    changes.client_sf_id = desired.client_sf_id;
  if (desired.household_name !== existing.household_name)
    changes.household_name = desired.household_name;
  if (desired.household_sf_id !== existing.household_sf_id)
    changes.household_sf_id = desired.household_sf_id;
  if (desired.value !== existing.value) changes.value = desired.value;
  if (desired.transferring_firm !== existing.transferring_firm)
    changes.transferring_firm = desired.transferring_firm;
  if (desired.deal_sf_id !== existing.deal_sf_id)
    changes.deal_sf_id = desired.deal_sf_id;
  return changes;
}

/**
 * §1.5b PRISTINE predicate: the transfer carries NO workflow state — still in
 * DECISION, all three checklist booleans false, cash NOT in flight, NO ACAT
 * linked, not archived. A pristine transfer for a withdrawn/uncommitted deal is
 * safe to soft-archive; a PROGRESSED one is left untouched and flagged for ops.
 */
export function isPristine(t: ExistingTransfer): boolean {
  return (
    t.funding_type !== "DRS" &&
    t.stage === "DECISION" &&
    !t.accounts_opened_at_apex &&
    !t.funding_plan_complete &&
    !t.funding_initiated &&
    !t.cash_in_flight &&
    t.acat_transfer_id == null &&
    t.acat_record_id == null &&
    t.archived_at == null
  );
}

/**
 * The reconcile decision for ONE deal against its existing transfer (matched by
 * `deal_id`, or null). Pure + total; the route just executes the returned
 * action. Rules (blueprint §3 S4 + §1.5b, ticket sync-stage-mapping):
 *  - deal archived (archived_at set) OR LOST → archive(deal_lost) if a transfer
 *    exists and isn't already archived, else noop. (The route feeds only
 *    non-archived deals, so the archived_at leg is defensive + unit-tested.)
 *  - COMMITTED / FUNDING / WON (create/advance-eligible — the deal PIPELINE
 *    DRIVES the transfer stage, DEAL_STAGE_TO_TRANSFER_STAGE):
 *      · no transfer → create at the deal-mapped stage (DECISION/IN_TRANSFER/
 *        FUNDED) — so a FUNDING deal materializes at IN_TRANSFER and a WON deal
 *        at FUNDED (they no longer noop/mis-archive; see the fixed bug below).
 *      · archived transfer → noop (never resurrect via an overwrite).
 *      · transfer exists → update: the deal-owned field diffs PLUS a FORWARD-
 *        ONLY stage advance. Entering FUNDED additionally requires a completed
 *        versioned funding approval. NEVER regress a transfer an advisor pushed
 *        ahead of its deal. If neither deal-owned fields NOR stage changed →
 *        noop (idempotent). This is the ONLY place the sync writes a workflow
 *        column (`stage`) — an INTENTIONAL, owner-decided departure from the
 *        prior "never write workflow columns" invariant: the deal pipeline is
 *        the source of truth for a deal-sourced transfer's stage, and this
 *        does not use manual readiness gates. Existing-record completion still
 *        honors the explicit funding approval requirement. No other workflow
 *        column is ever written by the sync.
 *  - POTENTIAL (un-committed) → progressed-guard: pristine ⇒
 *    archive(uncommitted); progressed ⇒ flag(uncommitted_review). A deal that
 *    REGRESSES to POTENTIAL thus flags its (progressed) transfer for review.
 *
 * FIXED LIVE BUG: FUNDING previously shared the POTENTIAL uncommitted branch, so
 * a FUNDING deal with a still-pristine transfer was mis-archived("uncommitted")
 * and a FUNDING deal with no transfer never got created. FUNDING (and WON) are
 * now first-class create/advance stages.
 */
export function reconcileAction(
  deal: DealRow,
  existing: ExistingTransfer | null,
): ReconcileAction {
  // Deal archived (any stage) or LOST → treat like LOST.
  if (deal.archived_at != null || deal.stage === "LOST") {
    if (!existing || existing.archived_at != null) return { kind: "noop" };
    // DRS stages and closure are Operations-owned; a lost/archived source deal
    // requests review instead of hiding outstanding manual transfer work.
    if (existing.funding_type === "DRS") return { kind: "flag", sync_flag: "orphan_review" };
    return { kind: "archive", reason: "deal_lost" };
  }

  // COMMITTED / FUNDING / WON: the deal drives the transfer stage.
  if (isSyncStageMapped(deal.stage)) {
    const target = DEAL_STAGE_TO_TRANSFER_STAGE[deal.stage];
    if (!existing) return { kind: "create", input: buildSyncTransferInput(deal) };
    if (existing.archived_at != null) return { kind: "noop" }; // never resurrect
    const changes: SyncUpdateChanges = dealOwnedChanges(deal, existing);
    // Existing records cannot become Funded merely because their source deal
    // did. Operations must have approved the current plan, including legacy
    // records whose old completion boolean has no versioned approval. Initial
    // source materialization above remains a separate create policy.
    const completionApproved = target !== "FUNDED" || (
      existing.funding_plan_complete && Number.isInteger(existing.funding_plan_version) &&
      existing.funding_plan_version > 0
    );
    // Forward-only: advance toward the deal's mapped stage, never regress.
    if (existing.funding_type !== "DRS" && !existing.funding_route_change_pending && completionApproved && stageRank(target) > stageRank(existing.stage)) {
      changes.stage = target;
    }
    // AUTO-HEAL (transfer-syncflag-surface): the flag means "the deal regressed
    // / vanished — review this transfer". A deal back in a driving stage
    // un-regressed, so a lingering flag is stale — clear it. This is the ONLY
    // reconcile rule that touches sync_flag on update; the pristine/progressed
    // POTENTIAL guard below is untouched (owner decision 2026-07-24).
    if (existing.sync_flag != null) changes.sync_flag = null;
    return Object.keys(changes).length === 0
      ? { kind: "noop" }
      : { kind: "update", changes };
  }

  if (deal.stage === "POTENTIAL") {
    if (!existing || existing.archived_at != null) return { kind: "noop" };
    return isPristine(existing)
      ? { kind: "archive", reason: "uncommitted" }
      : { kind: "flag", sync_flag: "uncommitted_review" };
  }

  return { kind: "noop" };
}

/**
 * §4.1 ORPHAN sweep decision for ONE still-active, deal-linked transfer whose
 * deal was directly archived (archived_at set) or deleted — so listDeals no
 * longer returns it and the per-deal reconcile pass never sees it. This closes
 * the #158 MEDIUM: without this pass the materialized transfer would stay active
 * forever. Pure + total; the route's second pass just executes the action.
 *  - deal_id null OR still in the active-deal set → noop (NOT orphaned). The set
 *    is the FULL listDeals result (before SYNC_STAGES filtering), so a transfer
 *    whose deal is merely in a non-synced stage is deliberately NOT swept.
 *  - orphaned + PRISTINE (reuse isPristine) → archive("deal_gone").
 *  - orphaned + PROGRESSED → flag("orphan_review"): an advisor has moved it
 *    forward / put cash in flight, so a human reviews it — NEVER an auto-teardown.
 * Idempotent: the route only feeds archived_at:null rows, so a swept (archived)
 * transfer is excluded on the next run; a flagged one re-flags to the same value.
 */
export function orphanAction(
  t: ExistingTransfer,
  activeDealIds: ReadonlySet<string>,
): ReconcileAction {
  if (t.deal_id == null || activeDealIds.has(t.deal_id)) return { kind: "noop" };
  return isPristine(t)
    ? { kind: "archive", reason: "deal_gone" }
    : { kind: "flag", sync_flag: "orphan_review" };
}
