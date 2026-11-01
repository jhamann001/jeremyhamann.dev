/**
 * The AI draft seam — node, layer L2.
 *
 * One interface, one factory, and a hard boundary around what a model is ever shown.
 *
 * **What this seam is for.** An operator answering the fortieth "where is my transfer" of the week
 * writes the same four sentences every time. A model is good at those four sentences and bad at
 * deciding whether they are true. So the seam produces a DRAFT that lands in the composer, a human
 * reads it, edits it and submits it through the ordinary `addPublicReply` path with the ordinary
 * disclaimer acknowledgement. There is no code path on which model output reaches a client without a
 * person pressing the same button they press for their own words.
 *
 * **What the model is shown**, and nothing else:
 *   - the ticket's subject, category and status;
 *   - the PUBLIC thread — what the client wrote and what the desk already replied;
 *   - the macro the operator has selected, if any, as the firm-approved shape of the answer;
 *   - the firm voice rules below;
 *   - the operator's own instruction, if they typed one.
 *
 * **What it is never shown**: INTERNAL notes, attachments or their filenames, the requester's name,
 * email address or phone number, any other ticket, and anything from the audit ledger. Internal notes
 * are where an operator writes "client is threatening to complain, do not admit fault" and where a
 * supervisor writes about the client's account; putting that into a reply generator is how it comes
 * back out in a reply. The same argument I1 makes about the client API is the argument here, and
 * `buildDraftPrompt` enforces it by construction — it takes a filtered thread and never sees the rest.
 *
 * **What is configured.** `AI_DRAFTING_PROVIDER` plus the three `VERTEX_*` keys, all-or-nothing and
 * refused at boot as a group (`src/lib/env.ts`). Unset means `aiProvider()` returns null, the action
 * refuses, and the control renders nothing. There is no default provider and no API key: the Vertex
 * implementation authenticates as the Cloud Run service account.
 */
import type { CommentDTO, TicketDetailDTO } from "@/types/domain";
import { env, isAiDraftingEnabled } from "@/lib/env";
import { createVertexProvider } from "@/lib/ai/vertex";
import { createDemoAiProvider } from "@/lib/ai/demo";

export { AiProviderError } from "@/lib/ai/errors";

/**
 * What a provider is asked for and what it must return.
 *
 * `model` comes back from the provider rather than from configuration because a Vertex model alias
 * (`gemini-2.0-flash`) resolves to a concrete version at call time, and the audit row has to record
 * what actually answered — "which model wrote this" is a question a reviewer will ask about a reply
 * that went wrong, and the configured string is not always the answer.
 */
export type AiDraftRequest = {
  ticket: TicketDetailDTO;
  /** The thread as loaded, oldest first. `buildDraftPrompt` filters it to PUBLIC, un-retracted rows. */
  thread: CommentDTO[];
  instruction?: string;
  /**
   * The rendered body of the macro the operator has selected, when there is one.
   *
   * A WIDENING of the contract's `draft(input: { ticket, thread, instruction })`: the field is
   * optional, so a caller written to the contract's three fields still satisfies this type. It is
   * here because CONTRACT §10 B3 requires the prompt to be built from "PUBLIC thread text + category
   * + selected macro + firm voice rules" — and the provider is what builds the prompt, so the macro
   * has to reach it. Recorded in the build record.
   */
  macroBody?: string | null;
};

export type AiDraftProvider = {
  readonly name: string;
  draft(input: AiDraftRequest): Promise<{ text: string; model: string; promptTokens?: number; outputTokens?: number }>;
};

/**
 * The configured provider, or null when the seam is off.
 *
 * A factory rather than a module-level singleton so a test can drive the same code path with
 * `setAiProviderForTests` and so nothing touches the network at import time. `"vertex"` is the only
 * implemented value and `src/lib/env.ts` refuses any other at boot by key name, so the fallthrough
 * here is unreachable in a running process and is still written out rather than cast away.
 */
export function aiProvider(): AiDraftProvider | null {
  if (override !== undefined) return override;
  if (!isAiDraftingEnabled(env)) return null;
  switch (env.AI_DRAFTING_PROVIDER) {
    case "vertex":
      return createVertexProvider({
        project: env.VERTEX_PROJECT ?? "",
        location: env.VERTEX_LOCATION ?? "",
        model: env.VERTEX_MODEL ?? "",
      });
    case "demo":
      return createDemoAiProvider();
    default:
      return null;
  }
}

let override: AiDraftProvider | null | undefined = undefined;

/**
 * Test seam. `null` forces "unconfigured" even with the keys set; `undefined` restores the real
 * resolution. Exported from the L2 module rather than reached for with a module mock so the unit
 * tests exercise `requestAiDraft` through the same function production uses.
 */
export function setAiProviderForTests(provider: AiDraftProvider | null | undefined): void {
  override = provider;
}
