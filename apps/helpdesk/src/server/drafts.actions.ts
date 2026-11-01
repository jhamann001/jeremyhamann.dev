"use server";

/**
 * Composer draft mutations — `"use server"`, node, layer L4.
 *
 * Three actions, all of them about text that has not been sent to anybody:
 *
 *  - `saveDraft` — the autosave. Upserts the viewer's (ticket, channel) row; an EMPTY body deletes
 *    it instead, so "I selected all and deleted it" does not leave an empty row behind that the next
 *    page load restores as a draft.
 *  - `deleteDraft` — the explicit discard. Decision #95: the owner may delete their own row, and
 *    `ComposerDraft` is one of exactly two Wave B tables where that is physically possible.
 *  - `loadComposerState` — the mount-time read: both drafts plus the AI-seam flag, resolved on the
 *    server because a client component may not import `@/lib/env`.
 *
 * **No audit rows here, by contract**. Everything else in `src/server/*.actions.ts`
 * writes the ledger in the same transaction as its mutation; these three deliberately do not, because
 * a draft is not a record. What IS audited is the comment the draft becomes, and that row carries the
 * final text. Nothing in this module runs inside `withTx` either: with no audit row to keep as the
 * last statement of a transaction, a single-statement upsert needs no transaction around it.
 *
 * RBAC is the channel's own comment capability (`canComment`): an INTERNAL draft needs queue READ,
 * a PUBLIC draft needs queue WRITE. Drafting a client reply is the first half of sending one, so the
 * bar is the same bar. The row is scoped to `viewer.id` in the WHERE clause, so a viewer can never
 * name another operator's draft.
 */
import type {
  ActionResult,
  ComposerDraftDTO,
  DeleteDraftInput,
  SaveDraftInput,
  Viewer,
} from "@/types/domain";
import type { DbTx } from "@/lib/db";
import { prisma, withTx } from "@/lib/db";
import { enforceDemoDraftLimit } from "@/lib/demo/limits";
import { demoMode } from "@/lib/demo/mode";
import { env, isAiDraftingEnabled } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { assertCan, canComment, canReadQueue } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import type { ComposerBootstrap, SaveDraftResult } from "@/server/drafts";
import { deleteDraftSchema, getDrafts, saveDraftSchema } from "@/server/drafts";

// ---------------------------------------------------------------------------
// Module-private helpers (a "use server" module exports async functions only — guardrail G4)
// ---------------------------------------------------------------------------

/**
 * The ticket's queue key, for the capability check. A missing ticket is a 404 rather than a silent
 * no-op: the composer would otherwise autosave into nothing and report "saved".
 */
async function queueKeyForTicket(ticketId: string): Promise<{ id: string; queueKey: Parameters<typeof canReadQueue>[1] }> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, queue: { select: { key: true } } },
  });
  if (!ticket) throw new NotFoundError("Ticket not found");
  return { id: ticket.id, queueKey: ticket.queue.key };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Autosave. Debounced by the caller; idempotent here.
 *
 * The body is sanitized before it is stored. That matters more for this table than for most:
 * `ComposerDraft` carries no immutability trigger and no retention job, so it is precisely where a
 * pasted account number would sit unnoticed for a year. The submit path applies the same
 * `sanitizePII`, so the stored draft is what the comment would have stored anyway — and the result
 * says so (`redacted`, `redactionCount`) rather than letting the operator discover it on restore.
 *
 * An empty body DELETES the row. An autosave that fires after the operator cleared the textarea
 * means "there is no draft", and storing an empty row would make the next page load restore an empty
 * draft and light the "unsaved changes" state for a field nobody touched.
 */
export async function saveDraft(input: SaveDraftInput): Promise<ActionResult<SaveDraftResult>> {
  return runAction("saveDraft", async (viewer: Viewer) => {
    const data = saveDraftSchema.parse(input);
    const ticket = await queueKeyForTicket(data.ticketId);
    assertCan(
      canComment(viewer.groups, ticket.queueKey, data.channel),
      data.channel === "PUBLIC" ? "comment:public draft" : "comment:internal draft",
      ticket.id,
    );

    if (data.body.trim().length === 0) {
      await prisma.composerDraft.deleteMany({
        where: { ticketId: ticket.id, userId: viewer.id, channel: data.channel },
      });
      return { updatedAt: new Date().toISOString(), discarded: true, redacted: false, redactionCount: 0 };
    }

    const sanitized = sanitizePII(data.body);
    const macroId = data.macroId ?? null;
    const disclaimerKey = data.disclaimerKey ?? "NONE";

    const key = { ticketId: ticket.id, userId: viewer.id, channel: data.channel };
    const upsert = (db: DbTx) =>
      db.composerDraft.upsert({
        where: { ticketId_userId_channel: key },
        create: { ...key, body: sanitized.text, macroId, disclaimerKey },
        update: { body: sanitized.text, macroId, disclaimerKey },
        select: { updatedAt: true },
      });
    // The demo's drafts cap writes no ledger row, so it is checked here, under the limits lock.
    const row = demoMode()
      ? await withTx(async (tx) => {
          await enforceDemoDraftLimit(tx, key);
          return upsert(tx);
        })
      : await upsert(prisma);

    return {
      updatedAt: row.updatedAt.toISOString(),
      discarded: false,
      redacted: sanitized.redacted,
      redactionCount: sanitized.count,
    };
  });
}

/**
 * Explicit discard. Returns whether a row was actually removed, so the UI can say
 * "Draft discarded" only when there was one — a second click on a stale button is a successful no-op,
 * not an error and not a fake confirmation.
 */
export async function deleteDraft(input: DeleteDraftInput): Promise<ActionResult<{ deleted: boolean }>> {
  return runAction("deleteDraft", async (viewer: Viewer) => {
    const data = deleteDraftSchema.parse(input);
    const ticket = await queueKeyForTicket(data.ticketId);
    assertCan(
      canComment(viewer.groups, ticket.queueKey, data.channel),
      data.channel === "PUBLIC" ? "comment:public draft" : "comment:internal draft",
      ticket.id,
    );

    const removed = await prisma.composerDraft.deleteMany({
      where: { ticketId: ticket.id, userId: viewer.id, channel: data.channel },
    });
    return { deleted: removed.count > 0 };
  });
}

/**
 * Everything the composer needs on mount: this viewer's drafts for both channels, and whether the AI
 * draft seam is configured.
 *
 * Gated on queue READ, which is the floor for being on the ticket page at all. The AI flag is not
 * secret — it is "is a button visible" — but it is resolved here anyway, because the alternative is
 * an `@/lib/env` import inside a client component, which G1 forbids for a much better reason: the
 * whole parsed environment would be serialized into the page.
 */
export async function loadComposerState(input: { ticketId: string }): Promise<ActionResult<ComposerBootstrap>> {
  return runAction("loadComposerState", async (viewer: Viewer) => {
    const ticket = await queueKeyForTicket(input.ticketId);
    assertCan(canReadQueue(viewer.groups, ticket.queueKey), "queue:read composer", ticket.id);

    const drafts: ComposerDraftDTO[] = await getDrafts(viewer, ticket.id);
    return { drafts, aiEnabled: isAiDraftingEnabled(env) };
  });
}
