import { describe, expect, it } from "vitest";
import { TICKET_CATEGORIES } from "@/types/domain";
import type { AiDraftRequest } from "@/lib/ai/provider";
import { DEMO_AI_MODEL, createDemoAiProvider, demoDraftText } from "./demo";

describe("the demo AI provider", () => {
  it("has a canned draft for every category, greeting the client by first name", () => {
    for (const c of TICKET_CATEGORIES) {
      const text = demoDraftText(c, "Grace Chen");
      expect(text.startsWith("Hello Grace,\n\n")).toBe(true);
      expect(text.length).toBeGreaterThan(40);
    }
    expect(demoDraftText("OTHER", null).startsWith("Hello,\n\n")).toBe(true);
  });

  it("drafts through the fake, so the prompt is built by the same function the real provider uses", async () => {
    const request = {
      ticket: { category: "PASSKEY_LOGIN", status: "NEW", subject: "Can't sign in", requesterName: "Grace Chen" },
      thread: [],
    } as unknown as AiDraftRequest;
    const result = await createDemoAiProvider().draft(request);
    expect(result.model).toBe(DEMO_AI_MODEL);
    expect(result.text).toBe(demoDraftText("PASSKEY_LOGIN", "Grace Chen"));
    expect(result.promptTokens).toBeGreaterThan(0);
  });
});
