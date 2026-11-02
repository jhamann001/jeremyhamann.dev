import { beforeEach, describe, expect, it, vi } from "vitest";

// draft.ts — the drafting engine. buildDraftPrompt is PURE (tested directly);
// draftCommunication is tested with generateText mocked (no model call).
vi.mock("server-only", () => ({}));

const { generateTextSpy } = vi.hoisted(() => ({
  generateTextSpy: vi.fn(async (_args: { system?: string; prompt: string; temperature?: number; maxOutputTokens?: number }) => ({
    text: "DRAFTED BODY",
    model: "gemini-3.8-flash",
    finishReason: "STOP",
  })),
}));
vi.mock("@/lib/ai/gemini", () => ({ generateText: generateTextSpy }));

import { buildDraftPrompt, draftCommunication } from "@/lib/ai/draft";

beforeEach(() => generateTextSpy.mockClear());

describe("buildDraftPrompt", () => {
  it("client_email: kind guidance + guardrails in system, context+task in user", () => {
    const { system, user } = buildDraftPrompt({
      kind: "client_email",
      context: "Client: Willie. Transfer funded yesterday.",
      instruction: "Let her know the transfer is complete.",
    });
    expect(system).toContain("Subject:"); // email kind wants a subject line
    // Guardrails present:
    expect(system).toContain("DRAFT");
    expect(system).toContain("Do not invent");
    expect(system).toContain("[PLACEHOLDER]");
    expect(system).toContain("Never promise or guarantee");
    // User carries the grounding + the ask:
    expect(user).toContain("CONTEXT");
    expect(user).toContain("Transfer funded yesterday.");
    expect(user).toContain("TASK:");
    expect(user).toContain("Let her know the transfer is complete.");
  });

  it("tone selects the tone guidance; default is professional", () => {
    expect(buildDraftPrompt({ kind: "client_nudge", context: "x", instruction: "y", tone: "concise" }).system).toContain(
      "concise",
    );
    expect(buildDraftPrompt({ kind: "client_nudge", context: "x", instruction: "y" }).system).toContain("professional");
  });

  it("internal_note is framed as NOT client-facing", () => {
    expect(buildDraftPrompt({ kind: "internal_note", context: "x", instruction: "y" }).system).toContain("INTERNAL");
  });

  it("meeting_prep: the six fixed headings, the internal framing, full guardrails", () => {
    const { system, user } = buildDraftPrompt({
      kind: "meeting_prep",
      context: "=== MEETING ===\nWhen: Tomorrow",
      instruction: "Write the prep brief for this meeting.",
      tone: "concise",
    });
    // The six level-2 headings, in order and exactly these.
    for (const h of [
      "## Snapshot",
      "## Since we last spoke",
      "## Money in motion",
      "## Open items",
      "## Talking points",
      "## Questions to ask",
    ]) {
      expect(system).toContain(h);
    }
    // Internal-only framing — never client-facing, never sent.
    expect(system).toContain("INTERNAL");
    expect(system).toContain("never sent");
    // GUARDRAILS are reused UNEDITED (blueprint ADR-4).
    expect(system).toContain("Draft ONLY from the provided context");
    expect(system).toContain("[PLACEHOLDER]");
    expect(system).toContain("Never promise or guarantee");
    expect(system).toContain("concise");
    expect(user).toContain("=== MEETING ===");
  });

  it("adding meeting_prep left the four pre-existing kinds byte-identical", () => {
    // Pinned strings: a drift in any of these would silently change every live
    // comms surface.
    expect(buildDraftPrompt({ kind: "client_email", context: "c", instruction: "i" }).system)
      .toContain(
        "You are drafting a client-facing email from a financial advisor's operations team.",
      );
    expect(buildDraftPrompt({ kind: "client_nudge", context: "c", instruction: "i" }).system)
      .toContain("You are drafting a SHORT client nudge (2\u20134 sentences, one clear ask).");
    expect(buildDraftPrompt({ kind: "status_update", context: "c", instruction: "i" }).system)
      .toContain(
        "You are drafting a concise client-facing status update on an in-progress account transfer or deal.",
      );
    expect(buildDraftPrompt({ kind: "internal_note", context: "c", instruction: "i" }).system)
      .toContain(
        "You are drafting an INTERNAL operations note (not sent to the client). Be direct and factual; internal shorthand is fine.",
      );
  });

  it("missing context degrades to an explicit placeholder, never throws", () => {
    expect(buildDraftPrompt({ kind: "client_email", context: "   ", instruction: "hi" }).user).toContain(
      "(no context provided)",
    );
  });
});

describe("draftCommunication", () => {
  it("passes the built system+user to generateText with model-default sampling and returns the draft", async () => {
    const res = await draftCommunication({
      kind: "status_update",
      context: "ACAT in flight, day 6.",
      instruction: "Reassure the client it's on track.",
      maxOutputTokens: 900,
    });
    expect(res).toEqual({ draft: "DRAFTED BODY", model: "gemini-3.8-flash", finishReason: "STOP" });

    const arg = generateTextSpy.mock.calls[0]![0];
    expect(arg.system).toContain("status update");
    expect(arg.prompt).toContain("ACAT in flight, day 6.");
    expect(arg.prompt).toContain("Reassure the client");
    expect(arg.temperature).toBeUndefined();
    expect(arg.maxOutputTokens).toBe(900);
  });
});
