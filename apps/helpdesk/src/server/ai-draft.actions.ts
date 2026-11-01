"use server";

/**
 * AI reply drafting — `"use server"`, node, layer L4.
 *
 * **Nothing here sends anything to a client.** The action returns text; the composer puts it in a
 * textarea; a human edits it and submits it through `addPublicReply`, with the same disclaimer
 * selection and the same acknowledgement checkbox as their own words. There is no auto-send, no
 * queue, no `MessageDelivery` and no comment row on this path — which is why the audit action is
 * `AI_DRAFT_REQUESTED` and not `COMMENT_ADDED_PUBLIC`.
 *
 * **The audit row carries a hash, never the text**. A draft is unreviewed generated
 * prose about a client's affairs; putting it in an append-only ledger would preserve forever a
 * paragraph nobody approved and that may be wrong about the client's money. The sha256 still answers
 * the question a reviewer actually asks — "is the reply that was sent the draft the model produced,
 * or did the operator change it?" — because the operator's submitted comment IS in the ledger and can
 * be hashed and compared. Alongside it: the provider, the model version that answered, and the token
 * counts, which are the operational facts.
 *
 * **The row is written AFTER the provider answers and outside a transaction**. It
 * records a completed call: writing it first would claim a draft that a timeout never produced, and
 * holding a transaction open across a 45-second generative call would hold the audit chain's advisory
 * lock — serialising every other write on the desk behind a model.
 *
 * **The capability is `comment:public`**, not something weaker. Drafting a client reply is the first
 * half of sending one; a viewer who cannot reply to this queue has no business generating text in its
 * voice, and a CLOSED or VOIDED ticket takes no reply at all.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActionResult, AiDraftInput, AiDraftResult, CommentDTO } from "@/types/domain";
import { AiProviderError } from "@/lib/ai/errors";
import { aiProvider } from "@/lib/ai/provider";
import { INSTRUCTION_MAX_CHARS } from "@/lib/ai/prompt";
import { checkAiDraftRateLimit } from "@/lib/ai/rate-limit";
import { actorFromViewer, writeAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { demoMode } from "@/lib/demo/mode";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { macroVarsFor, renderMacroTemplate } from "@/lib/macro-template";
import { sanitizePII } from "@/lib/pii";
import { assertCan, canComment } from "@/lib/rbac";
import { runAction } from "@/server/action-utils";
import { listComments } from "@/server/comments";
import { getDraft } from "@/server/drafts";
import { assertTicketNotClosed, getTicketDetail } from "@/server/tickets";

// ---------------------------------------------------------------------------
// Module-private helpers (a "use server" module exports async functions only — guardrail G4)
// ---------------------------------------------------------------------------

const aiDraftSchema: z.ZodType<AiDraftInput, unknown> = z.object({
  ticketId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
  instruction: z.string().trim().max(INSTRUCTION_MAX_CHARS).optional(),
});

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Asks the configured provider for a reply draft on one ticket.
 *
 * The thread handed to the provider is the ticket's comments filtered to PUBLIC and un-retracted by
 * `buildDraftPrompt`; `listComments` is used rather than a bespoke query so the rows are exactly the
 * DTOs the operator is looking at, and the RBAC re-check inside it is a second gate on the same
 * queue. The macro, when the operator has one selected in their draft, is rendered with the same
 * template function the composer used so the model sees what the operator sees.
 */
export async function requestAiDraft(input: AiDraftInput): Promise<ActionResult<AiDraftResult>> {
  return runAction("requestAiDraft", async (viewer, ctx) => {
    const data = aiDraftSchema.parse(input);

    const provider = aiProvider();
    if (provider === null) {
      // Not FORBIDDEN: nobody is being refused a capability. The feature is switched off, which is
      // the default in every environment.
      throw new ValidationError("AI drafting is not configured for this environment", {
        _form: ["Drafting is switched off here. No request was made and nothing was sent."],
      });
    }

    const ticketRow = await prisma.ticket.findUnique({
      where: { id: data.ticketId },
      select: { id: true, status: true, queue: { select: { key: true } } },
    });
    if (!ticketRow) throw new NotFoundError("Ticket not found");
    assertCan(canComment(viewer.groups, ticketRow.queue.key, "PUBLIC"), "comment:public ai-draft", ticketRow.id);
    assertTicketNotClosed(ticketRow);

    // Per person: in the demo every visitor shares a persona, so its limit is kept per persona and visitor.
    const limit = checkAiDraftRateLimit(demoMode() ? `${viewer.id}|${ctx.ipAddress}` : viewer.id);
    if (!limit.allowed) {
      throw new ValidationError("too many draft requests", {
        _form: [`You have asked for several drafts in the last minute. Try again after ${formatDateTime(limit.resetAt)}.`],
      });
    }

    // `getTicketDetail` writes the TICKET_VIEWED row this read of ticket content requires and
    // re-checks the queue; `listComments` records its own denial. Neither is skipped because the
    // model, not a person, is the immediate reader: the material left the record store either way.
    const ticket = await getTicketDetail(viewer, ticketRow.id, ctx, { view: "DETAIL" });
    if (!ticket) throw new NotFoundError("Ticket not found");
    const thread: CommentDTO[] = await listComments(viewer, ticket.id, ctx);

    // The macro the operator has selected in their PUBLIC draft, rendered exactly as the composer
    // rendered it. Absent when they have not picked one.
    const currentDraft = await getDraft(viewer, ticket.id, "PUBLIC");
    let macroBody: string | null = null;
    if (currentDraft?.macroId) {
      const macro = await prisma.macro.findUnique({
        where: { id: currentDraft.macroId },
        select: { body: true, isActive: true, channel: true },
      });
      if (macro && macro.isActive && macro.channel === "PUBLIC") {
        macroBody = renderMacroTemplate(
          macro.body,
          macroVarsFor({ number: ticket.number, requesterName: ticket.requesterName }, viewer.name),
        );
      }
    }

    let answer: Awaited<ReturnType<typeof provider.draft>>;
    try {
      answer = await provider.draft({
        ticket,
        thread,
        macroBody,
        ...(data.instruction ? { instruction: data.instruction } : {}),
      });
    } catch (e) {
      if (e instanceof AiProviderError) {
        // The provider's message is written for an operator and carries no response body. Surfaced
        // as VALIDATION so the composer renders it in place rather than as "Unexpected error".
        throw new ValidationError("the draft could not be generated", { _form: [e.message] });
      }
      throw e;
    }

    // I4: model output is persisted text the moment the operator saves the draft, and it is prose
    // about a client's affairs. A model that echoes an account number out of the thread must not be
    // the one path that puts an unredacted one back on screen.
    const sanitized = sanitizePII(answer.text);
    const draft = sanitized.text;
    const hash = sha256Hex(draft);

    // Outside a transaction and after the answer. `prisma` satisfies `DbTx`; the
    // chain trigger takes its advisory lock for this single insert and releases it immediately.
    await writeAudit(prisma, actorFromViewer(viewer), ctx, {
      action: "AI_DRAFT_REQUESTED",
      entityType: "TICKET",
      entityId: ticket.id,
      ticketId: ticket.id,
      fieldChanged: "draft",
      oldValue: null,
      // The hash, never the text.
      newValue: hash,
      metadata: {
        provider: provider.name,
        model: answer.model,
        promptTokens: answer.promptTokens ?? null,
        outputTokens: answer.outputTokens ?? null,
        draftChars: draft.length,
        usedMacro: macroBody !== null,
        hadInstruction: Boolean(data.instruction),
        piiRedactionCount: sanitized.count,
      },
    });

    return { draft, provider: provider.name, model: answer.model, hash };
  });
}
