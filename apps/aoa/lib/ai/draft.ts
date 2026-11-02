import "server-only";
import { generateText, type GenerateResult } from "./gemini";

// The communication-drafting engine — the ONE seam every comms surface (Smart
// Nudges, client email reply, transfer/deal next-step, …) will call. This slice
// ships the engine + a health probe only; no UI surface is wired yet (owner
// decision 2026-07-21: "just the engine first").
//
// GUARDRAILS baked into the system instruction (RIA client comms):
//   • DRAFT ONLY — the output is a suggestion a human edits and sends through the
//     existing channel (which archives it, SEC 17a-4/204-2). The engine never
//     sends anything.
//   • No performance guarantees, no misleading/promissory claims, no invented
//     facts — draft only from the supplied context; if a needed detail is
//     missing, leave a clearly-bracketed [PLACEHOLDER] for the human.
//   • Compliance + the send path stay on the existing human-reviewed rails.
// The engine returns text; the CALLER audits the generation (writeAudit) and
// renders it into an editable field. Nothing here is logged (client PII).

/** The kind of communication being drafted — selects the framing guidance. */
export type DraftKind =
  | "client_email" // a client-facing email (or reply)
  | "client_nudge" // a short Smart-Nudge message
  | "status_update" // a transfer/deal status/next-step note to the client
  | "internal_note" // an internal ops note (not client-facing)
  | "meeting_prep"; // an internal pre-meeting brief (never sent, never shared)

export type DraftTone = "warm" | "professional" | "concise";

export type DraftRequest = {
  kind: DraftKind;
  /** The real, caller-assembled context the draft must be grounded in (client
   *  facts, the email thread, transfer/deal state, …). Plain text. */
  context: string;
  /** What the message needs to accomplish (the ask / intent). */
  instruction: string;
  tone?: DraftTone;
  /** Optional extra output-token headroom for longer copy. */
  maxOutputTokens?: number;
};

export type DraftResult = {
  draft: string;
  /** The model that actually answered (may be the fallback). */
  model: string;
  finishReason: string | null;
};

const KIND_GUIDANCE: Record<DraftKind, string> = {
  client_email:
    "You are drafting a client-facing email from a financial advisor's operations team. Include a brief subject line as the first line prefixed 'Subject: '. Keep it clear and personable.",
  client_nudge:
    "You are drafting a SHORT client nudge (2–4 sentences, one clear ask). No subject line. Friendly and low-pressure.",
  status_update:
    "You are drafting a concise client-facing status update on an in-progress account transfer or deal. State where things stand and the next step. No subject line unless it reads as an email.",
  internal_note:
    "You are drafting an INTERNAL operations note (not sent to the client). Be direct and factual; internal shorthand is fine.",
  // AI meeting prep (blueprint ADR-4). A DISTINCT kind rather than a reuse of
  // internal_note: that guidance produces a *message* ("Output only the drafted
  // message itself"), and a prep brief needs fixed, scannable headed sections.
  // Adding a kind is additive and total — DraftKind is a union and KIND_GUIDANCE
  // is a Record over it, so no existing kind changes.
  meeting_prep:
    "You are writing an INTERNAL meeting-prep brief for a financial advisor about " +
    "to meet a client. Not client-facing; never sent. Output MARKDOWN with exactly " +
    "these level-2 headings, in this order and no others: '## Snapshot', " +
    "'## Since we last spoke', '## Money in motion', '## Open items', " +
    "'## Talking points', '## Questions to ask'. Under each, terse bullets — facts " +
    "first, each bullet standing on its own. Where the context says a block has " +
    "nothing on file, say so in one bullet rather than inferring. Keep the whole " +
    "brief under roughly 500 words so it can be read in the two minutes before the " +
    "call.",
};

const TONE_GUIDANCE: Record<DraftTone, string> = {
  warm: "Tone: warm and relationship-first, while remaining professional.",
  professional: "Tone: professional, measured, and precise.",
  concise: "Tone: concise and to the point; no filler.",
};

const GUARDRAILS = [
  "This is a DRAFT for a human to review, edit, and send — you never send anything.",
  "Draft ONLY from the provided context. Do not invent facts, figures, dates, or account details.",
  "If a needed detail is missing, insert a clearly bracketed [PLACEHOLDER] for the human to fill — never guess.",
  "Never promise or guarantee investment performance, returns, or outcomes; avoid misleading or promissory language.",
  "Do not include internal system identifiers, request numbers, or vendor names in client-facing copy.",
  "Output only the drafted message itself — no preamble, no explanation, no options.",
].join(" ");

/** PURE: assemble the {system, user} prompt for a draft request. Exposed for
 *  unit testing so the framing/guardrails are asserted without a model call. */
export function buildDraftPrompt(req: DraftRequest): { system: string; user: string } {
  const tone = TONE_GUIDANCE[req.tone ?? "professional"];
  const system = `${KIND_GUIDANCE[req.kind]} ${tone} ${GUARDRAILS}`;
  const user = [
    "CONTEXT (the only facts you may rely on):",
    req.context.trim() || "(no context provided)",
    "",
    "TASK:",
    req.instruction.trim(),
  ].join("\n");
  return { system, user };
}

/**
 * Draft a communication. Grounds the model in the caller-supplied context under
 * the drafting guardrails and returns the draft text. Never sends, never logs.
 * The caller owns auditing + rendering into an editable field.
 */
export async function draftCommunication(req: DraftRequest): Promise<DraftResult> {
  const { system, user } = buildDraftPrompt(req);
  const result: GenerateResult = await generateText({
    system,
    prompt: user,
    maxOutputTokens: req.maxOutputTokens,
  });
  return { draft: result.text, model: result.model, finishReason: result.finishReason };
}
