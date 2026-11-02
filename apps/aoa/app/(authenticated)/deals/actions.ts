"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { withUserScope, type Identity } from "@/lib/rls";
import {
  writeAudit,
  DEAL_CREATE,
  DEAL_UPDATE,
  DEAL_STAGE_CHANGE,
  DEAL_ARCHIVE,
  DEAL_RESTORE,
} from "@/lib/audit";
import {
  ARCHIVE_REASONS,
  archivedReasonText,
  archiveNoteError,
  canSeeArchivedDeals,
} from "@/lib/data/deal-archive";
import {
  isValidIsoDate,
  validateDealInput,
  type DealValidationError,
} from "@/lib/data/deal-validate";
import { canViewCedarRidgeUserId } from "@/lib/data/client-field-authz";
import {
  DEAL_STAGES,
  type DealInput,
  type DealStage,
  type StageHistoryEntry,
} from "@/lib/data/deal-types";
import {
  applyGuardedStageWrite,
  STAGE_CONFLICT_MESSAGE,
} from "@/lib/data/deal-stage-write";
import {
  APP_CREATE_BASE,
  dealToFormValues,
  diffDealInput,
  isoDay,
  toDealInput,
  updatedDealName,
  type DealFormValues,
} from "@/components/deals/deal-form";

// D3 server actions (WO ticket) — AOA's first real write path.
//
// Posture (TDD ADR-4/ADR-5):
//  - identity ALWAYS comes from auth(), never from the client;
//  - every write runs inside ONE `withUserScope` transaction, so the Postgres
//    RLS write policies police the action — a VIEWER session cannot write even
//    if the UI misbehaves (the DB rejection surfaces as a clean form error);
//  - `writeAudit` runs in the SAME transaction as the row write: a failed
//    write leaves no orphan audit row, a failed audit rolls the write back;
//  - validation (the FROZEN validateDealInput — the one contract shared with
//    the D4 import) fails BEFORE any write: no row, no audit row;
//  - stage transitions additionally emit `deal.stage_change {from,to}` —
//    WON/LOST included, no terminal lock (locked with the owner).

export type DealActionResult = { ok: false; errors: DealValidationError[] };

// Form-level (non-field) error the DealForm renders as a banner. Deliberately
// generic: an RLS rejection and a vanished row look the same to the caller.
const WRITE_REJECTED: DealActionResult = {
  ok: false,
  errors: [
    {
      field: "form",
      message:
        "Save failed — the database rejected the change. The deal may not exist, or your role may not have permission to write deals.",
    },
  ],
};

// Identity + display name from auth(), never from the client. The name feeds
// D6's silent owner attribution on create (owner_name = the signed-in user;
// hidden from all /deals UI but stored for future per-advisor scoping).
async function sessionContext(): Promise<{
  identity: Identity;
  userName: string | null;
}> {
  const session = await auth();
  if (!session?.user) redirect("/");
  const name = session.user.name?.trim();
  return {
    identity: {
      role: (session.user as { role?: string }).role ?? "VIEWER",
      email: session.user.email ?? null,
    },
    userName: name ? name : null,
  };
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

// D8 stage timeline (WO ticket): one entry on create and on EVERY stage
// change (form save and the inline table dropdown), written in the SAME
// transaction as the row write + audit rows. Stage transitions go through
// applyGuardedStageWrite (lib/data/deal-stage-write.ts, QC MEDIUM-1 on PR
// #80): the write is optimistically guarded on the expected `from` stage and
// the timeline append happens in SQL, so concurrent stage changes can neither
// drop an entry nor record a stale from/lost_from. The guarded write is
// always the transaction's FIRST write, so a lost race commits nothing — no
// field update, no audit rows — and surfaces this clear error instead.
// `by` = the acting user's display name (email fallback) — identity comes
// from auth(), never the client, like everything else here.
const STAGE_CONFLICT: DealActionResult = {
  ok: false,
  errors: [{ field: "stage", message: STAGE_CONFLICT_MESSAGE }],
};

const stageEntry = (
  stage: DealStage,
  from: DealStage | null,
  by: string | null,
): StageHistoryEntry => ({ stage, from, at: new Date().toISOString(), by });

// jsonb comes back from Prisma as JsonValue — narrow it once, defensively.
const asStageHistory = (v: unknown): StageHistoryEntry[] =>
  Array.isArray(v) ? (v as StageHistoryEntry[]) : [];

// DealInput carries YYYY-MM-DD strings; the Prisma `@db.Date` columns want
// Date objects — construct at UTC midnight (the same convention the seed and
// the D2 renderer use, avoiding the local-offset day shift).
const utcDate = (s: string | null | undefined): Date | null =>
  s == null || s === "" ? null : new Date(`${s}T00:00:00.000Z`);

/**
 * Create an APP-sourced deal (sf_deal_id null) — audited in the same tx.
 * owner_name is SILENTLY set to the signed-in user's name server-side (D6,
 * WO ticket): the form neither shows nor round-trips owner fields.
 */
export async function createDeal(
  values: DealFormValues,
): Promise<DealActionResult | void> {
  const { identity, userName } = await sessionContext();

  const input = toDealInput(values, APP_CREATE_BASE(todayIso(), userName));
  // A non-authorized creator has no real value to set — force null so a masked
  // placeholder can never be persisted as the id. ADMIN/OPERATIONS set it from
  // the form as today.
  if (!canViewCedarRidgeUserId(identity.role)) {
    input.cedar_ridge_user_id = null;
  }
  const result = validateDealInput(input);
  if (!result.ok) return { ok: false, errors: result.errors }; // no row, no audit

  try {
    await withUserScope(identity, async (tx) => {
      const deal = await tx.deal.create({
        data: {
          source: input.source,
          sf_deal_id: null,
          name: input.name,
          client_first_name: input.client_first_name,
          client_last_name: input.client_last_name,
          household_name: input.household_name,
          household_sf_id: input.household_sf_id,
          amount: input.amount,
          stage: input.stage,
          stage_raw: null,
          created_date: utcDate(input.created_date)!,
          close_date: utcDate(input.close_date),
          last_activity_date: null,
          owner_name: input.owner_name,
          owner_sf_user_id: null,
          secondary_owner: input.secondary_owner,
          person_aum: null,
          potential_aum: null,
          cedar_ridge_user_id: input.cedar_ridge_user_id,
          statements: input.statements ?? true,
          // plaid_linked: DB default (false) — removed from all UI (scope
          // change, the owner 2026-07-01); schema field kept for a future
          // Plaid integration.
          account_last4: input.account_last4,
          account_type: input.account_type,
          transferring_firm: input.transferring_firm,
          // D8: 401(k)-Rollover companions — toDealInput already nulled them
          // for every other funding type (server-side rule).
          employer: input.employer,
          rolling_into: input.rolling_into,
          // D8: the timeline starts at creation (from: null).
          stage_history: [
            stageEntry(input.stage, null, userName ?? identity.email ?? null),
          ],
          created_by: identity.email,
          updated_by: identity.email,
        },
      });
      await writeAudit(tx, identity, {
        action: DEAL_CREATE,
        entityType: "deal",
        entityId: deal.id,
        detail: {
          name: input.name,
          stage: input.stage,
          amount: input.amount,
          source: input.source,
        },
      });
    });
  } catch {
    // VIEWER (or any non-write role) hits the RLS INSERT policy here — the
    // DB polices the action; surface a clean form error, never a 500.
    return WRITE_REJECTED;
  }

  revalidatePath("/deals");
  redirect("/deals");
}

/**
 * Update a deal — read + write + audit inside ONE user-scoped transaction.
 * Emits deal.update with the field-level change map, plus deal.stage_change
 * {from,to} when the stage differs (WON/LOST restage included — no lock).
 * Owner fields are carried through from the current row (D6): an edit can
 * never change or null them, no matter what the client sends.
 */
export async function updateDeal(
  id: string,
  values: DealFormValues,
): Promise<DealActionResult | void> {
  const { identity, userName } = await sessionContext();

  let outcome: DealActionResult | undefined;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      // RLS read: every app role sees the row (locked posture). Absent row
      // (bad id / no GUC match) → clean error, nothing written.
      const current = await tx.deal.findUnique({ where: { id } });
      if (!current) return WRITE_REJECTED;

      const currentRow = {
        ...current,
        amount: Number(current.amount),
        person_aum: current.person_aum == null ? null : Number(current.person_aum),
        potential_aum:
          current.potential_aum == null ? null : Number(current.potential_aum),
        source: current.source as DealInput["source"],
        stage: current.stage as DealInput["stage"],
        stage_history: asStageHistory(current.stage_history),
        // Server context reads the real value directly (findUnique bypasses the
        // seam masker); the flag is unused here but required by the DealRow type
        // that dealToFormValues consumes.
        cedar_ridge_user_id_masked: false,
      };

      // Carry the server-owned fields through unchanged (IMPORT rows keep
      // their sf_deal_id upsert key, so the frozen validator holds; owners
      // are preserved verbatim — hidden from the UI since D6, never nulled).
      const base = {
        source: currentRow.source,
        sf_deal_id: current.sf_deal_id,
        created_date: isoDay(current.created_date),
        stage_raw: current.stage_raw,
        last_activity_date:
          current.last_activity_date == null
            ? null
            : isoDay(current.last_activity_date),
        owner_name: current.owner_name,
        secondary_owner: current.secondary_owner,
        person_aum: currentRow.person_aum,
        potential_aum: currentRow.potential_aum,
      };

      const before = toDealInput(dealToFormValues(currentRow), base);
      before.name = current.name; // diff against the STORED name
      const input = toDealInput(values, base);
      input.name = updatedDealName(current.name, before, input);

      // PRESERVE-ON-SAVE: a non-authorized caller can neither change nor wipe
      // the real cedar_ridge_user_id. Overwrite whatever the browser submitted
      // (masked dots / "") with the STORED value, so the diff sees no change,
      // no false audit entry is written, and the DB write is a no-op rewrite of
      // the same value. Authorized callers (ADMIN/OPERATIONS) edit it as before.
      if (!canViewCedarRidgeUserId(identity.role)) {
        input.cedar_ridge_user_id = current.cedar_ridge_user_id;
      }

      const result = validateDealInput(input);
      if (!result.ok) return { ok: false as const, errors: result.errors };

      const changes = diffDealInput(before, input);
      if (Object.keys(changes).length === 0) return undefined; // no-op: no write, no audit noise

      // D8: a stage change goes through the GUARDED write first (QC MEDIUM-1)
      // — expected-from guard + SQL-side timeline append + lost_from on LOST.
      // It is this transaction's first write, so a lost race commits nothing.
      const stageChanged = before.stage !== input.stage;
      if (stageChanged) {
        const stageWrite = await applyGuardedStageWrite(
          tx,
          id,
          before.stage,
          input.stage,
          stageEntry(input.stage, before.stage, userName ?? identity.email ?? null),
          identity.email ?? null,
        );
        if (stageWrite === "conflict") return STAGE_CONFLICT;
      }

      await tx.deal.update({
        where: { id },
        data: {
          name: input.name,
          client_first_name: input.client_first_name,
          client_last_name: input.client_last_name,
          household_name: input.household_name,
          household_sf_id: input.household_sf_id,
          amount: input.amount,
          // stage / stage_history / lost_from deliberately absent: the
          // guarded write above owns them (unchanged stage writes none).
          close_date: utcDate(input.close_date),
          // owner_name / secondary_owner deliberately absent (D6): preserved
          // by omission — an update can never touch the stored owners.
          cedar_ridge_user_id: input.cedar_ridge_user_id,
          statements: input.statements ?? true,
          account_last4: input.account_last4,
          account_type: input.account_type,
          transferring_firm: input.transferring_firm,
          employer: input.employer,
          rolling_into: input.rolling_into,
          updated_by: identity.email,
        },
      });

      await writeAudit(tx, identity, {
        action: DEAL_UPDATE,
        entityType: "deal",
        entityId: id,
        detail: { changes },
      });
      if (before.stage !== input.stage) {
        await writeAudit(tx, identity, {
          action: DEAL_STAGE_CHANGE,
          entityType: "deal",
          entityId: id,
          detail: { from: before.stage, to: input.stage },
        });
      }
      return undefined;
    });
  } catch {
    // VIEWER's UPDATE matches no row under the RLS write policy (P2025), and
    // any other DB rejection lands here too — clean form error, never a 500.
    return WRITE_REJECTED;
  }
  if (outcome) return outcome;

  revalidatePath("/deals");
  revalidatePath(`/deals/${id}`);
  redirect("/deals");
}

/**
 * D7 soft delete (WO ticket): "Delete" ARCHIVES — sets archived_at/
 * archived_by inside one user-scoped transaction with a `deal.archive` audit
 * row (same-tx guarantee, ADR-5). The row always survives: hard DELETE stays
 * revoked at the grant level (D1). VIEWER's UPDATE matches no row under the
 * RLS write policy — the DB polices the action even if the UI misbehaves.
 * Already-archived → no-op success (double-click race: it is already gone;
 * no second write, no duplicate audit row).
 */
export async function archiveDeal(
  id: string,
  // D8 (WO ticket): the confirm step now captures WHY — a required reason
  // from the locked ARCHIVE_REASONS list plus an optional note, stored on the
  // row (archived_reason) and in the deal.archive audit payload.
  reason: string,
  note: string,
): Promise<DealActionResult | void> {
  const { identity } = await sessionContext();
  if (!(ARCHIVE_REASONS as readonly string[]).includes(reason)) {
    return {
      ok: false,
      errors: [{ field: "form", message: "Choose a removal reason." }],
    };
  }
  // QC LOW-2: cap the note server-side (the input's maxLength is UX only).
  const noteError = archiveNoteError(note);
  if (noteError) {
    return { ok: false, errors: [{ field: "form", message: noteError }] };
  }
  const trimmedNote = note.trim();

  let outcome: DealActionResult | undefined;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      const current = await tx.deal.findUnique({ where: { id } });
      if (!current) return WRITE_REJECTED;
      if (current.archived_at != null) return undefined; // already archived — no-op

      await tx.deal.update({
        where: { id },
        data: {
          archived_at: new Date(),
          archived_by: identity.email,
          archived_reason: archivedReasonText(reason, trimmedNote),
          updated_by: identity.email,
        },
      });
      await writeAudit(tx, identity, {
        action: DEAL_ARCHIVE,
        entityType: "deal",
        entityId: id,
        detail: {
          name: current.name,
          stage: current.stage,
          amount: Number(current.amount),
          reason,
          note: trimmedNote === "" ? null : trimmedNote,
        },
      });
      return undefined;
    });
  } catch {
    // VIEWER (or any non-write role) hits the RLS UPDATE policy here (P2025) —
    // clean form error, never a 500; nothing written, no audit row.
    return WRITE_REJECTED;
  }
  if (outcome) return outcome;

  revalidatePath("/deals");
  revalidatePath(`/deals/${id}`);
  redirect("/deals"); // closes the modal / leaves the detail page (create/update idiom)
}

/**
 * Restore an archived deal from the Removed view — clears archived_at/
 * archived_by + `deal.restore` audit row in the same transaction. Restore is
 * an ADMIN + OPERATIONS affordance (the Removed view's gate, WO ticket), so
 * the action carries the same app-side gate as listArchivedDeals — the RLS
 * write policy alone would admit any write role. No redirect: it's a row
 * action on /deals; revalidatePath re-renders the page in place.
 */
export async function restoreDeal(
  id: string,
): Promise<DealActionResult | void> {
  const { identity } = await sessionContext();
  if (!canSeeArchivedDeals(identity.role)) return WRITE_REJECTED; // fail closed

  let outcome: DealActionResult | undefined;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      const current = await tx.deal.findUnique({ where: { id } });
      if (!current) return WRITE_REJECTED;
      if (current.archived_at == null) return undefined; // already active — no-op

      await tx.deal.update({
        where: { id },
        data: {
          archived_at: null,
          archived_by: null,
          archived_reason: null, // a restored deal is no longer removed (D8)
          updated_by: identity.email,
        },
      });
      await writeAudit(tx, identity, {
        action: DEAL_RESTORE,
        entityType: "deal",
        entityId: id,
        detail: {
          name: current.name,
          stage: current.stage,
          amount: Number(current.amount),
        },
      });
      return undefined;
    });
  } catch {
    return WRITE_REJECTED;
  }
  if (outcome) return outcome;

  revalidatePath("/deals");
  revalidatePath(`/deals/${id}`);
}

// ---------------------------------------------------------------------------
// D8 inline row actions (WO ticket): stage dropdown, expected-close date and
// statements checkbox, edited straight from the pipeline table. Row actions
// like restoreDeal — no redirect; revalidatePath re-renders /deals in place.
// Same posture as everything above: identity from auth(), ONE withUserScope
// transaction per write, audit row(s) in that same transaction, archived rows
// rejected (they are off the pipeline — only Restore touches them), and the
// RLS write policies police VIEWER regardless of what the UI renders.
// ---------------------------------------------------------------------------

/** Inline stage change — appends to stage_history exactly like a form save. */
export async function setDealStage(
  id: string,
  stage: DealStage,
): Promise<DealActionResult | void> {
  const { identity, userName } = await sessionContext();
  if (!DEAL_STAGES.includes(stage)) return WRITE_REJECTED;

  let outcome: DealActionResult | undefined;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      const current = await tx.deal.findUnique({ where: { id } });
      if (!current || current.archived_at != null) return WRITE_REJECTED;
      const from = current.stage as DealStage;
      if (from === stage) return undefined; // no-op — no write, no audit noise

      // Guarded transition + SQL-side timeline append (QC MEDIUM-1): a
      // concurrent stage change makes the guard match zero rows → clear
      // conflict error, nothing written (this is the tx's first write).
      const stageWrite = await applyGuardedStageWrite(
        tx,
        id,
        from,
        stage,
        stageEntry(stage, from, userName ?? identity.email ?? null),
        identity.email ?? null,
      );
      if (stageWrite === "conflict") return STAGE_CONFLICT;
      // Same audit pair as a form-save stage change (one vocabulary).
      await writeAudit(tx, identity, {
        action: DEAL_UPDATE,
        entityType: "deal",
        entityId: id,
        detail: { changes: { stage: { from, to: stage } } },
      });
      await writeAudit(tx, identity, {
        action: DEAL_STAGE_CHANGE,
        entityType: "deal",
        entityId: id,
        detail: { from, to: stage },
      });
      return undefined;
    });
  } catch {
    return WRITE_REJECTED;
  }
  if (outcome) return outcome;

  revalidatePath("/deals");
  revalidatePath(`/deals/${id}`);
}

/** Inline expected-close edit; empty string clears the date. */
export async function setDealCloseDate(
  id: string,
  closeDate: string,
): Promise<DealActionResult | void> {
  const { identity } = await sessionContext();
  const next = closeDate.trim() === "" ? null : closeDate.trim();
  if (next != null && !isValidIsoDate(next)) {
    return {
      ok: false,
      errors: [{ field: "close_date", message: "Must be a valid YYYY-MM-DD date." }],
    };
  }

  let outcome: DealActionResult | undefined;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      const current = await tx.deal.findUnique({ where: { id } });
      if (!current || current.archived_at != null) return WRITE_REJECTED;
      const from = isoDay(current.close_date) || null;
      if (from === next) return undefined; // no-op

      await tx.deal.update({
        where: { id },
        data: { close_date: utcDate(next), updated_by: identity.email },
      });
      await writeAudit(tx, identity, {
        action: DEAL_UPDATE,
        entityType: "deal",
        entityId: id,
        detail: { changes: { close_date: { from, to: next } } },
      });
      return undefined;
    });
  } catch {
    return WRITE_REJECTED;
  }
  if (outcome) return outcome;

  revalidatePath("/deals");
  revalidatePath(`/deals/${id}`);
}

/** Inline statements-on-file toggle (the table checkbox). */
export async function setDealStatements(
  id: string,
  statements: boolean,
): Promise<DealActionResult | void> {
  const { identity } = await sessionContext();

  let outcome: DealActionResult | undefined;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      const current = await tx.deal.findUnique({ where: { id } });
      if (!current || current.archived_at != null) return WRITE_REJECTED;
      if (current.statements === statements) return undefined; // no-op

      await tx.deal.update({
        where: { id },
        data: { statements, updated_by: identity.email },
      });
      await writeAudit(tx, identity, {
        action: DEAL_UPDATE,
        entityType: "deal",
        entityId: id,
        detail: { changes: { statements: { from: current.statements, to: statements } } },
      });
      return undefined;
    });
  } catch {
    return WRITE_REJECTED;
  }
  if (outcome) return outcome;

  revalidatePath("/deals");
  revalidatePath(`/deals/${id}`);
}

/** Inline asset-mapper-run toggle (the table checkbox). Ops-owned + write-
 *  isolated (deal-card-mirror S1): this action is the ONLY writer of
 *  asset_mapped — deliberately absent from createDeal/updateDeal data, the deal
 *  form, and the ingest mapper, so a form save or a sync never touches it.
 *  Mirrors setDealStatements exactly. */
export async function setDealAssetMapped(
  id: string,
  asset_mapped: boolean,
): Promise<DealActionResult | void> {
  const { identity } = await sessionContext();

  let outcome: DealActionResult | undefined;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      const current = await tx.deal.findUnique({ where: { id } });
      if (!current || current.archived_at != null) return WRITE_REJECTED;
      if (current.asset_mapped === asset_mapped) return undefined; // no-op

      await tx.deal.update({
        where: { id },
        data: { asset_mapped, updated_by: identity.email },
      });
      await writeAudit(tx, identity, {
        action: DEAL_UPDATE,
        entityType: "deal",
        entityId: id,
        detail: {
          changes: { asset_mapped: { from: current.asset_mapped, to: asset_mapped } },
        },
      });
      return undefined;
    });
  } catch {
    return WRITE_REJECTED;
  }
  if (outcome) return outcome;

  revalidatePath("/deals");
  revalidatePath(`/deals/${id}`);
}
