/**
 * Composer drafts — node, layer L4.
 *
 * A draft is the half-written thing in an operator's composer, persisted so that closing a phone
 * sheet, following a link, losing a tab or dropping a train tunnel does not cost a reply that was
 * three paragraphs in. It is keyed per (ticket, user, channel): two people drafting on the same
 * ticket never see each other's words, and the internal note and the public reply are separate
 * drafts because they are separate acts.
 *
 * Three properties that are contract, not preference:
 *
 *  - **No audit rows.** A draft is not a record and has never been in front of anybody. Auditing
 *    keystrokes would put unreviewed half-sentences into an append-only ledger nobody can repair,
 *    at a volume that would bury the rows that matter. The SUBMITTED comment is the record, it is
 *    immutable, and it is fully audited.
 *  - **A row may be DELETED, by its owner.** `ComposerDraft` is one of exactly two Wave B tables
 *    without a no-delete trigger (guardrail G18). "Discard my draft" has to actually
 *    discard it; a soft-deleted draft table would quietly accumulate half-written client
 *    correspondence in every backup with nobody accountable for it.
 *  - **The body is sanitized before it is persisted.** This table has no retention job and no
 *    immutability guard, so it is the LAST place an unredacted account number should be allowed to
 *    settle. The submit path sanitizes with the same function, so a restored draft is byte-for-byte
 *    what the comment would have stored anyway — the redaction is not a surprise introduced at save
 *    time, it is the redaction the agent was already going to get.
 *
 * `clearDraft` is called by `addInternalNote` / `addPublicReply` INSIDE their transaction, so a
 * submitted draft cannot survive its own comment: either the comment and the deletion both commit,
 * or neither does and the operator still has their text.
 *
 * Reads and writes are scoped to `viewer.id` in the WHERE clause rather than checked after the fact,
 * so there is no code path on which one operator can name another's draft row.
 */
import { z } from "zod";
import type {
  CommentVisibility,
  ComposerDraftDTO,
  DeleteDraftInput,
  SaveDraftInput,
  Viewer,
} from "@/types/domain";
import { COMMENT_VISIBILITIES, DISCLAIMER_KEYS, WAVE_B_LIMITS } from "@/types/domain";
import type { DbTx } from "@/lib/db";
import { prisma } from "@/lib/db";
import { demoTextMax } from "@/lib/demo/mode";

// ---------------------------------------------------------------------------
// Validation
//
// These schemas live here rather than in `src/server/validation.ts` for the reason S9's do: that file
// is shared and B3 does not own it. Recorded in the build record.
// ---------------------------------------------------------------------------

const draftIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");
const draftChannelSchema = z.enum(COMMENT_VISIBILITIES);

/**
 * The body is NOT `.trim()`ed and NOT `.min(1)`ed.
 *
 * Trailing whitespace is meaningful while someone is mid-sentence — trimming it would move the caret
 * on every restore — and an empty body is a legitimate save: it is how "I deleted what I had written"
 * is expressed by an autosave that has not yet been told to discard. `saveDraft` turns an empty body
 * into a delete, so an empty row never actually persists.
 */
const draftBodySchema = z.string().max(demoTextMax(WAVE_B_LIMITS.draftMaxChars));

export const saveDraftSchema: z.ZodType<SaveDraftInput, unknown> = z.object({
  ticketId: draftIdSchema,
  channel: draftChannelSchema,
  body: draftBodySchema,
  macroId: z.union([draftIdSchema, z.null()]).optional(),
  disclaimerKey: z.enum(DISCLAIMER_KEYS).optional(),
});

export const deleteDraftSchema: z.ZodType<DeleteDraftInput, unknown> = z.object({
  ticketId: draftIdSchema,
  channel: draftChannelSchema,
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const DRAFT_SELECT = {
  ticketId: true,
  channel: true,
  body: true,
  macroId: true,
  disclaimerKey: true,
  updatedAt: true,
} as const;

type DraftRow = {
  ticketId: string;
  channel: CommentVisibility;
  body: string;
  macroId: string | null;
  disclaimerKey: ComposerDraftDTO["disclaimerKey"];
  updatedAt: Date;
};

function toDraftDTO(row: DraftRow): ComposerDraftDTO {
  return {
    ticketId: row.ticketId,
    channel: row.channel,
    body: row.body,
    macroId: row.macroId,
    disclaimerKey: row.disclaimerKey,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * This viewer's draft for one channel of one ticket, or null.
 *
 * Not a view (§e "What counts as a view"): the only content it returns is text this same viewer
 * typed. No audit row, deliberately and by contract.
 */
export async function getDraft(
  viewer: Viewer,
  ticketId: string,
  channel: CommentVisibility,
): Promise<ComposerDraftDTO | null> {
  const row = await prisma.composerDraft.findUnique({
    where: { ticketId_userId_channel: { ticketId, userId: viewer.id, channel } },
    select: DRAFT_SELECT,
  });
  return row === null ? null : toDraftDTO(row);
}

/** Both channels in one round trip — what the composer needs when it mounts. */
export async function getDrafts(viewer: Viewer, ticketId: string): Promise<ComposerDraftDTO[]> {
  const rows = await prisma.composerDraft.findMany({
    where: { ticketId, userId: viewer.id },
    select: DRAFT_SELECT,
  });
  return rows.map(toDraftDTO);
}

// ---------------------------------------------------------------------------
// Composer bootstrap
// ---------------------------------------------------------------------------

/**
 * What the composer needs the moment it mounts, in ONE round trip: the viewer's drafts for both
 * channels and whether the AI draft seam is configured.
 *
 * The flag rides along here because `src/components/**` may not import `@/lib/env` (guardrail G1,
 * CONTRACT §0: "resolve flags server-side and pass props"), and the composer's mount point on the
 * ticket page is foundation-owned, so there is no prop to pass it through. Resolving it on the
 * server and returning it with the drafts keeps the rule and costs no extra request.
 */
export type ComposerBootstrap = {
  /** At most two rows: one per channel. Absent channel = no draft. */
  drafts: ComposerDraftDTO[];
  /** `isAiDraftingEnabled(env)`. False ⇒ the AI control renders nothing at all. */
  aiEnabled: boolean;
};

/** What a save actually stored. A superset of the contract's `{ updatedAt }` (see integration notes). */
export type SaveDraftResult = {
  /** ISO-8601 of the stored row, or of the deletion when an empty body discarded it. */
  updatedAt: string;
  /** True when the draft was empty and the row was removed instead of written. */
  discarded: boolean;
  /** True when `sanitizePII` rewrote the body before it was stored. */
  redacted: boolean;
  redactionCount: number;
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Removes this author's draft for (ticket, channel), if any. Never throws on a missing row.
 *
 * Called inside the comment transaction, so the draft and the comment it became are one act. A
 * `deleteMany` rather than a `delete` precisely because "there was no draft" is the ordinary case —
 * a macro-only reply, an ingested comment, a second submit — and must not raise P2025.
 */
export async function clearDraft(
  tx: DbTx,
  input: { ticketId: string; userId: string; channel: CommentVisibility },
): Promise<void> {
  await tx.composerDraft.deleteMany({
    where: { ticketId: input.ticketId, userId: input.userId, channel: input.channel },
  });
}
