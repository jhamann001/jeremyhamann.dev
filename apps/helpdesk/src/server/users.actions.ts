"use server";

/**
 * Staff-account mutations — `"use server"`, node, layer L4 (the build record, Decision
 * #68 `user:admin`, Decision #72; I3, I4, I5, I13).
 *
 * Offboarding was a `psql` UPDATE before this: no row in the ledger, no hand-back of the person's
 * open tickets, and nothing an examiner could date. Both exports go through `runAction` and do the
 * whole thing in ONE transaction, with the audit rows as the last statement (audit rule 2 — one
 * `writeAuditMany`, never two).
 *
 * What deactivation means here, in order:
 *   1. `User.isActive = false` — `getViewer()` makes the person's existing JWT inert on the very next
 *      request, and `src/auth.ts` `callbacks.signIn` refuses a NEW sign-in. That
 *      hook already exists; this file must not duplicate it.
 *   2. Every OPEN ticket assigned to them is unassigned, one `TICKET_ASSIGNED` row each with
 *      `newValue: null` — the same shape `moveTicketQueue` writes when a move clears an assignee, so
 *      the ticket timeline reads identically however the assignment ended.
 *   3. `USER_DEACTIVATED` last, carrying `{ clearedAssignments }`.
 *
 * RESOLVED and CLOSED assignments are deliberately left alone: they are the historical record of who
 * worked the ticket, nobody is waiting on them, and rewriting them would cost an audit row each for
 * no operational gain.
 */
import type { ActionResult, AuditEntry, SetUserActiveInput } from "@/types/domain";
import { OPEN_STATUSES } from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import type { DbTx } from "@/lib/db";
import { withTx } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { demoMode } from "@/lib/demo/mode";
import { isPersonaUserId } from "@/lib/dev-login";
import { sanitizePII } from "@/lib/pii";
import { assertCan, canAdminUsers } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import { MACHINE_ACTOR_EMAILS, setUserActiveSchema } from "@/server/users";

// ---------------------------------------------------------------------------
// Module-private helpers (a "use server" module exports async functions only — guardrail G4)
// ---------------------------------------------------------------------------

const TARGET_SELECT = { id: true, email: true, name: true, isActive: true } as const;

type Target = { id: string; email: string; name: string | null; isActive: boolean };

/**
 * Loads the account being changed and refuses the three targets that are never legitimate:
 * a missing row, a machine identity, and the caller themselves.
 *
 * Self-deactivation is refused rather than allowed-with-a-warning: `user:admin` is held by
 * `ops_team` alone, so the last ops admin locking themselves out would leave nobody able to
 * reactivate anyone — recoverable only by a `psql` UPDATE, which is the exact thing this action
 * exists to replace. Reactivating yourself is impossible anyway (a deactivated viewer has no
 * session), so the guard costs nothing on that side.
 */
async function loadTarget(tx: DbTx, userId: string, viewerId: string, isActive: boolean): Promise<Target> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: TARGET_SELECT });
  if (!user) throw new NotFoundError("user not found");
  if (MACHINE_ACTOR_EMAILS.includes(user.email)) {
    throw new ValidationError("machine identities cannot be deactivated", {
      userId: ["This is a system identity, not a staff account."],
    });
  }
  if (user.id === viewerId && !isActive) {
    throw new ValidationError("you cannot deactivate your own account", {
      userId: ["Ask another Operations administrator to deactivate your account."],
    });
  }
  return user;
}

/** Sanitized reason, or null — free text never reaches the ledger unredacted. */
function prepareReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  return sanitizePII(trimmed).text;
}

/**
 * Flips `isActive` with an optimistic guard: `updateMany({ where: { id, isActive: !next } })`.
 * A count of 0 means somebody else already made the change, which is not an error — the caller
 * asked for a state and the state holds — so the action returns successfully and writes NO audit
 * row, rather than logging a second deactivation that changed nothing (I13's spirit: the ledger
 * records changes, not intentions).
 */
/**
 * The public demo's four sign-in accounts are shared by every visitor, so none of them may be switched off
 * or on from the admin page (the persona fence, ids compared canonically). Other staff can be, and the
 * daily reset restores them.
 */
function assertNotDemoPersona(userId: string): void {
  if (demoMode() && isPersonaUserId(userId)) {
    throw new ForbiddenError("Persona accounts can't be changed in this demo");
  }
}

async function flipActive(tx: DbTx, userId: string, next: boolean): Promise<boolean> {
  const r = await tx.user.updateMany({ where: { id: userId, isActive: !next }, data: { isActive: next } });
  return r.count === 1;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function deactivateUser(
  input: SetUserActiveInput,
): Promise<ActionResult<{ id: string; clearedAssignments: number }>> {
  return runAction("deactivateUser", async (viewer, ctx) => {
    const data = setUserActiveSchema.parse(input);
    if (data.isActive) {
      throw new ValidationError("deactivateUser requires isActive: false", {
        isActive: ["Use reactivateUser to restore an account."],
      });
    }
    assertCan(canAdminUsers(viewer.groups), "user:admin deactivate");
    assertNotDemoPersona(data.userId);
    const actor = actorFromViewer(viewer);
    const reason = prepareReason(data.reason);

    return withTx(async (tx) => {
      const target = await loadTarget(tx, data.userId, viewer.id, false);
      const changed = await flipActive(tx, target.id, false);
      if (!changed) return { id: target.id, clearedAssignments: 0 };

      // Read the ids BEFORE clearing them: the update is what makes them unrecoverable, and each
      // one needs its own audit row naming the ticket it came off.
      const assigned = await tx.ticket.findMany({
        where: { assigneeId: target.id, status: { in: [...OPEN_STATUSES] } },
        select: { id: true },
      });
      if (assigned.length > 0) {
        await tx.ticket.updateMany({
          where: { id: { in: assigned.map((t) => t.id) } },
          // `version` moves too, so any staff member holding one of these tickets open gets a
          // CONFLICT on their next write instead of silently re-assigning a departed colleague.
          data: { assigneeId: null, version: { increment: 1 } },
        });
      }

      const entries: AuditEntry[] = assigned.map((t) => ({
        action: "TICKET_ASSIGNED",
        entityType: "TICKET",
        entityId: t.id,
        ticketId: t.id,
        fieldChanged: "assigneeId",
        oldValue: target.id,
        newValue: null,
        metadata: { oldEmail: target.email, newEmail: null, reason: "user-deactivated" },
      }));
      entries.push({
        action: "USER_DEACTIVATED",
        entityType: "USER",
        entityId: target.id,
        fieldChanged: "isActive",
        oldValue: "true",
        newValue: "false",
        metadata: { clearedAssignments: assigned.length, email: target.email, ...(reason ? { reason } : {}) },
      });
      await writeAuditMany(tx, actor, ctx, entries);

      return { id: target.id, clearedAssignments: assigned.length };
    });
  });
}

export async function reactivateUser(input: SetUserActiveInput): Promise<ActionResult<{ id: string }>> {
  return runAction("reactivateUser", async (viewer, ctx) => {
    const data = setUserActiveSchema.parse(input);
    if (!data.isActive) {
      throw new ValidationError("reactivateUser requires isActive: true", {
        isActive: ["Use deactivateUser to disable an account."],
      });
    }
    assertCan(canAdminUsers(viewer.groups), "user:admin reactivate");
    assertNotDemoPersona(data.userId);
    const actor = actorFromViewer(viewer);
    const reason = prepareReason(data.reason);

    return withTx(async (tx) => {
      const target = await loadTarget(tx, data.userId, viewer.id, true);
      const changed = await flipActive(tx, target.id, true);
      if (!changed) return { id: target.id };

      // Reactivation restores the ACCOUNT, never the assignments: those tickets were handed back to
      // the queue and may already have new owners. Re-assigning them here would silently take work
      // off whoever picked it up.
      await writeAuditMany(tx, actor, ctx, [
        {
          action: "USER_REACTIVATED",
          entityType: "USER",
          entityId: target.id,
          fieldChanged: "isActive",
          oldValue: "false",
          newValue: "true",
          metadata: { email: target.email, ...(reason ? { reason } : {}) },
        },
      ]);

      return { id: target.id };
    });
  });
}
