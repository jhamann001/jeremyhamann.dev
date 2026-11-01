/**
 * Prompt construction for the AI draft seam — pure, layer L1.
 *
 * Pure and dependency-light on purpose: what a model is shown is a compliance question, so it is
 * built by a function that takes exactly what it is allowed to see and can be asserted on in a unit
 * test without a database, a network or a provider.
 *
 * The isolation argument (restated for this surface): an INTERNAL note is the one place on a
 * ticket where staff write to each other about a client rather than to the client. Handing those to a
 * reply generator is how "she has called four times and is becoming abusive" ends up paraphrased into
 * an email. So the thread this module receives is filtered to PUBLIC by its caller, and this module
 * additionally drops anything that is not PUBLIC — a second gate on the same rule, because the cost
 * of the check is one predicate and the cost of missing it is a client reading an internal note.
 *
 * Requester IDENTITY is left out too, and that is a narrower rule than it looks: the model does not
 * need a name to write "Thank you for getting in touch", the desk's own macros fill names from
 * `{{requester.firstName}}` at insert time, and an address or phone number in a prompt is client PII
 * crossing a boundary for no benefit at all.
 *
 * WHAT THAT RULE DOES NOT COVER, said plainly because the subject and the bodies DO cross. This prompt
 * carries `ticket.subject` and every PUBLIC comment body verbatim, and `src/lib/ai/vertex.ts` POSTs it
 * to a Google endpoint. Those bodies are the STORED text — whatever `sanitizePII` recognised at write
 * time — so narrowing the rule set narrows what is scrubbed before it leaves the firm. Since Decision
 * #116 a date of birth, routing number, passport or licence number typed into a ticket is sent to
 * Vertex as written. By the argument above an address and a date of birth are the same class, so the
 * exclusion rule and the behaviour now disagree; the behaviour is the accepted consequence of #116 and
 * this note is the record of it, not a defect in the boundary rule.
 *
 * Note the asymmetry while reading this: `src/server/ai-draft.actions.ts` still sanitizes the model's
 * OUTPUT, so the desk scrubs what comes back harder than what it sends. `src/server/mcp/registry.ts`'s
 * `get_ticket` is the other outbound surface for the same stored text.
 */
import type { CommentDTO, TicketCategory, TicketDetailDTO } from "@/types/domain";
import { CATEGORY_LABELS } from "@/types/domain";

/** How many PUBLIC messages of history the prompt carries, newest last. */
export const PROMPT_THREAD_LIMIT = 12;

/** How much of one message the prompt carries. Long quoted mail is cut rather than dropped. */
export const PROMPT_MESSAGE_MAX_CHARS = 2_000;

/** Hard ceiling on the assembled user prompt. A pathological thread cannot grow the request forever. */
export const PROMPT_MAX_CHARS = 24_000;

/** Ceiling on the operator's own instruction. */
export const INSTRUCTION_MAX_CHARS = 1_000;

/**
 * The firm's voice, stated to the model as rules rather than as adjectives.
 *
 * Every line here exists because the opposite behaviour is a real risk on a wealth-management desk,
 * not because it reads well: a model that guesses at a balance, promises a settlement date or offers
 * an opinion on an investment has produced something that cannot be sent and may not be noticed as
 * unsendable by a busy operator skim-reading a draft that otherwise sounds right.
 */
export const FIRM_VOICE_RULES: readonly string[] = [
  "You are drafting a reply for a wealth-management client-service desk. A human reviews and edits every word before anything is sent.",
  "Write plainly and warmly, in British-neutral business English, at a sixth-form reading level. Short sentences. No marketing language.",
  "Never state a figure, date, balance, account number or transfer status that is not already written in the thread below. If a fact is needed and missing, write a bracketed gap like [confirm the settlement date] for the operator to fill in.",
  "Never give investment, tax or legal advice, never recommend a security or a course of action, and never comment on markets or performance.",
  "Never apologise on the firm's behalf for something the thread does not establish happened, and never admit fault or liability.",
  "Never promise a timescale, an outcome, a fee waiver or a payment.",
  "Do not invent a signature, a disclaimer or a footer: the system appends the approved disclaimer itself.",
  "Do not address the client by name — the desk's template inserts the correct name.",
  "Return the body of the reply only. No subject line, no greeting placeholders in braces, no markdown headings, no commentary about what you wrote.",
  "If the thread does not contain enough to answer, say so in one short paragraph the operator can replace, rather than guessing.",
];

export type DraftPromptInput = {
  ticket: Pick<TicketDetailDTO, "category" | "status" | "subject">;
  /** The thread as the caller loaded it, oldest first. Non-PUBLIC rows are dropped here regardless. */
  thread: readonly CommentDTO[];
  /** The firm-approved template the operator selected, already rendered. Optional. */
  macroBody?: string | null;
  /** What the operator typed into the instruction box. Optional. */
  instruction?: string | null;
};

export type DraftPrompt = {
  /** The system instruction: the firm voice rules, and only those. */
  system: string;
  /** The task: ticket facts, the PUBLIC thread, the macro and the operator's instruction. */
  user: string;
};

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n[…truncated]`;
}

/** "Client" / "Our desk" — a role, never a person. The model gets the direction, not the identity. */
function speaker(comment: CommentDTO): string {
  switch (comment.authorKind) {
    case "REQUESTER":
      return "Client";
    case "SYSTEM":
      return "Automated notice";
    default:
      return "Our desk";
  }
}

/**
 * The PUBLIC thread, newest `PROMPT_THREAD_LIMIT` messages, oldest first, each labelled by ROLE.
 *
 * A withdrawn reply is excluded: the desk has said it should not have been sent, and it is exactly
 * the text a model would happily reuse. The retraction is data the DTO already carries
 * (`comment.retraction`), so no extra query is needed to honour it.
 */
export function threadForPrompt(thread: readonly CommentDTO[]): CommentDTO[] {
  const usable = thread.filter((c) => c.visibility === "PUBLIC" && c.retraction === null);
  return usable.slice(-PROMPT_THREAD_LIMIT);
}

function categoryLabel(category: TicketCategory): string {
  return CATEGORY_LABELS[category];
}

/**
 * Builds the two halves of the request. Deterministic: the same inputs always produce the same
 * strings, which is what lets a test assert that an internal note never appears in either half.
 */
export function buildDraftPrompt(input: DraftPromptInput): DraftPrompt {
  const messages = threadForPrompt(input.thread);
  const sections: string[] = [];

  sections.push(
    [
      "TICKET",
      `Subject: ${clamp(input.ticket.subject, 200)}`,
      `Category: ${categoryLabel(input.ticket.category)}`,
      `Status: ${input.ticket.status}`,
    ].join("\n"),
  );

  sections.push(
    messages.length === 0
      ? "CONVERSATION SO FAR\n(none — this ticket has no client-visible messages yet)"
      : [
          "CONVERSATION SO FAR (oldest first)",
          ...messages.map((c) => `--- ${speaker(c)} ---\n${clamp(c.body, PROMPT_MESSAGE_MAX_CHARS)}`),
        ].join("\n"),
  );

  const macroBody = input.macroBody?.trim();
  if (macroBody) {
    sections.push(
      [
        "FIRM-APPROVED TEMPLATE the operator selected. Follow its structure, keep its approved wording where it fits,",
        "and adapt only what the conversation requires. Leave any bracketed gap in place for the operator.",
        "---",
        clamp(macroBody, PROMPT_MESSAGE_MAX_CHARS),
      ].join("\n"),
    );
  }

  const instruction = input.instruction?.trim();
  if (instruction) {
    sections.push(`OPERATOR INSTRUCTION\n${clamp(instruction, INSTRUCTION_MAX_CHARS)}`);
  }

  sections.push("TASK\nDraft the body of the next reply from our desk to the client.");

  return { system: FIRM_VOICE_RULES.join("\n"), user: clamp(sections.join("\n\n"), PROMPT_MAX_CHARS) };
}
