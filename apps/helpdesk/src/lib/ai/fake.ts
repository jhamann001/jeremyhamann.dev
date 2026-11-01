/**
 * A deterministic in-process provider — pure, layer L1.
 *
 * Exists so `requestAiDraft` can be tested end to end without a network, a Google project or a model
 * whose output changes between runs. It is a TEST provider and says so in its name; `aiProvider()`
 * never returns it on its own — a test installs it with `setAiProviderForTests`.
 *
 * It is also the thing a reviewer reads to see exactly what the seam hands a model: the fake records
 * the prompt it was given, so `ai-draft.test.ts` can assert that an INTERNAL note never appears in
 * either half of it. That assertion is the point of the file.
 */
import type { AiDraftProvider, AiDraftRequest } from "@/lib/ai/provider";
import type { DraftPrompt } from "@/lib/ai/prompt";
import { buildDraftPrompt } from "@/lib/ai/prompt";

export type FakeAiProvider = AiDraftProvider & {
  /** Every prompt this provider has been asked to answer, oldest first. */
  readonly prompts: DraftPrompt[];
  /** Every request as the action passed it. */
  readonly requests: AiDraftRequest[];
  /** How many times `draft` has been called. */
  readonly calls: number;
};

export type FakeAiProviderOptions = {
  /** The text to return. A function receives the built prompt. Default: a short fixed paragraph. */
  text?: string | ((prompt: DraftPrompt) => string);
  model?: string;
  promptTokens?: number;
  outputTokens?: number;
  /** When set, `draft` rejects with this instead of answering. */
  failWith?: Error;
};

export const FAKE_DRAFT_TEXT =
  "Thank you for getting in touch. We have your request and are looking into it now. " +
  "We will come back to you as soon as we have confirmed the details.";

export function createFakeAiProvider(options: FakeAiProviderOptions = {}): FakeAiProvider {
  const prompts: DraftPrompt[] = [];
  const requests: AiDraftRequest[] = [];

  const provider: FakeAiProvider = {
    name: "fake",
    prompts,
    requests,
    get calls() {
      return prompts.length;
    },
    async draft(input) {
      // The prompt is built with the SAME function the Vertex provider uses, so a test asserting on
      // `prompts` is asserting on the bytes a real provider would have been sent.
      const prompt = buildDraftPrompt({
        ticket: input.ticket,
        thread: input.thread,
        instruction: input.instruction ?? null,
        macroBody: input.macroBody ?? null,
      });
      prompts.push(prompt);
      requests.push(input);
      if (options.failWith) throw options.failWith;
      const text = typeof options.text === "function" ? options.text(prompt) : (options.text ?? FAKE_DRAFT_TEXT);
      return {
        text,
        model: options.model ?? "fake-model-001",
        promptTokens: options.promptTokens ?? prompt.user.length,
        outputTokens: options.outputTokens ?? text.length,
      };
    },
  };
  return provider;
}
