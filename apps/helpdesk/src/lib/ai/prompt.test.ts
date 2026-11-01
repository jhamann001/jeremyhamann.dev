/**
 * What the model is shown, asserted.
 *
 * These are the compliance tests of the AI seam, not style checks: the prompt is the boundary across
 * which client material leaves this system, so every rule CONTRACT §10 B3 states about it is asserted
 * against the bytes `buildDraftPrompt` actually produces.
 */
import { describe, expect, it } from "vitest";
import type { CommentDTO, TicketDetailDTO } from "@/types/domain";
import {
  FIRM_VOICE_RULES,
  INSTRUCTION_MAX_CHARS,
  PROMPT_MAX_CHARS,
  PROMPT_MESSAGE_MAX_CHARS,
  PROMPT_THREAD_LIMIT,
  buildDraftPrompt,
  threadForPrompt,
} from "@/lib/ai/prompt";

const INTERNAL_SECRET = "INTERNAL-ONLY: the client has threatened to complain, do not admit fault";
const REQUESTER_NAME = "Arabella Featherstonehaugh";
const REQUESTER_EMAIL = "arabella.featherstonehaugh@example.test";

function comment(over: Partial<CommentDTO> & Pick<CommentDTO, "id" | "visibility" | "body">): CommentDTO {
  return {
    ticketId: "t1",
    disclaimerKey: "NONE",
    authorKind: "STAFF",
    author: { id: "u1", name: "Olivia Ops", email: "olivia@wm-helpdesk.local", image: null },
    authorLabel: "",
    macroId: null,
    macroTitle: null,
    delivery: null,
    attachments: [],
    retraction: null,
    reviews: [],
    piiRedacted: false,
    piiRedactionCount: 0,
    createdAt: "2026-09-20T12:00:00.000Z",
    ...over,
  } as CommentDTO;
}

const ticket = {
  subject: "Where is my transfer?",
  category: "ACAT",
  status: "OPEN",
} as unknown as Pick<TicketDetailDTO, "category" | "status" | "subject">;

describe("buildDraftPrompt — what the model is never shown", () => {
  it("drops INTERNAL notes from both halves of the prompt", () => {
    const thread = [
      comment({ id: "c1", visibility: "PUBLIC", authorKind: "REQUESTER", author: null, body: "Any news on my ACAT?" }),
      comment({ id: "c2", visibility: "INTERNAL", body: INTERNAL_SECRET }),
    ];
    const prompt = buildDraftPrompt({ ticket, thread });
    expect(prompt.user).not.toContain(INTERNAL_SECRET);
    expect(prompt.system).not.toContain(INTERNAL_SECRET);
    expect(prompt.user).toContain("Any news on my ACAT?");
  });

  it("drops a WITHDRAWN reply — the desk has said it should not have been sent", () => {
    const withdrawn = "Your funds settled on Tuesday.";
    const thread = [
      comment({
        id: "c1",
        visibility: "PUBLIC",
        body: withdrawn,
        retraction: {
          id: "r1",
          reason: "the settlement date was wrong",
          retractedBy: { id: "u1", name: "Olivia Ops", email: "olivia@wm-helpdesk.local", image: null },
          createdAt: "2026-09-20T13:00:00.000Z",
        },
      }),
      comment({ id: "c2", visibility: "PUBLIC", authorKind: "REQUESTER", author: null, body: "Is that right?" }),
    ];
    const prompt = buildDraftPrompt({ ticket, thread });
    expect(prompt.user).not.toContain(withdrawn);
    expect(prompt.user).toContain("Is that right?");
  });

  it("names roles, never people — no requester name, address or staff identity", () => {
    const thread = [
      comment({
        id: "c1",
        visibility: "PUBLIC",
        authorKind: "REQUESTER",
        author: null,
        authorLabel: REQUESTER_NAME,
        body: "Please call me back.",
      }),
    ];
    const prompt = buildDraftPrompt({ ticket, thread });
    expect(prompt.user).not.toContain(REQUESTER_NAME);
    expect(prompt.user).not.toContain(REQUESTER_EMAIL);
    expect(prompt.user).not.toContain("Olivia Ops");
    expect(prompt.user).toContain("--- Client ---");
  });

  it("labels the desk's own replies as the desk, and system notices as automated", () => {
    const thread = [
      comment({ id: "c1", visibility: "PUBLIC", body: "We are looking into it." }),
      comment({ id: "c2", visibility: "PUBLIC", authorKind: "SYSTEM", author: null, body: "We have your request." }),
    ];
    const prompt = buildDraftPrompt({ ticket, thread });
    expect(prompt.user).toContain("--- Our desk ---");
    expect(prompt.user).toContain("--- Automated notice ---");
  });
});

describe("buildDraftPrompt — what the model IS shown", () => {
  it("carries the subject, the category LABEL and the status", () => {
    const prompt = buildDraftPrompt({ ticket, thread: [] });
    expect(prompt.user).toContain("Subject: Where is my transfer?");
    expect(prompt.user).toContain("Status: OPEN");
    // The human label, not the enum: the model writes prose, not code.
    expect(prompt.user).toMatch(/Category: [A-Z][^\n]*/);
    expect(prompt.user).toContain("Category: ACAT / account transfer");
  });

  it("says so plainly when there is no client-visible history yet", () => {
    expect(buildDraftPrompt({ ticket, thread: [] }).user).toContain("(none — this ticket has no client-visible messages yet)");
  });

  it("includes the selected macro as the approved template", () => {
    const prompt = buildDraftPrompt({ ticket, thread: [], macroBody: "Dear client, your transfer is in progress." });
    expect(prompt.user).toContain("FIRM-APPROVED TEMPLATE");
    expect(prompt.user).toContain("your transfer is in progress");
  });

  it("includes the operator's instruction, and omits the section when there is none", () => {
    expect(buildDraftPrompt({ ticket, thread: [], instruction: "two sentences only" }).user).toContain(
      "OPERATOR INSTRUCTION\ntwo sentences only",
    );
    expect(buildDraftPrompt({ ticket, thread: [] }).user).not.toContain("OPERATOR INSTRUCTION");
  });

  it("puts the firm voice rules in the SYSTEM half and nothing else", () => {
    const prompt = buildDraftPrompt({ ticket, thread: [] });
    expect(prompt.system).toBe(FIRM_VOICE_RULES.join("\n"));
    expect(prompt.system).not.toContain("Where is my transfer?");
  });

  it("states the rules that stop a model inventing facts about a client's money", () => {
    const rules = FIRM_VOICE_RULES.join(" ").toLowerCase();
    for (const must of ["never state a figure", "never give investment", "never promise a timescale", "never admit fault"]) {
      expect(rules, `the firm voice rules no longer say "${must}"`).toContain(must);
    }
  });
});

describe("buildDraftPrompt — bounds", () => {
  it("keeps only the newest PROMPT_THREAD_LIMIT public messages, oldest first", () => {
    const thread = Array.from({ length: PROMPT_THREAD_LIMIT + 5 }, (_, i) =>
      comment({ id: `c${i}`, visibility: "PUBLIC", body: `message ${i}` }),
    );
    const kept = threadForPrompt(thread);
    expect(kept).toHaveLength(PROMPT_THREAD_LIMIT);
    expect(kept[0]?.body).toBe("message 5");
    expect(kept.at(-1)?.body).toBe(`message ${PROMPT_THREAD_LIMIT + 4}`);
  });

  it("truncates one long message rather than dropping it", () => {
    const long = "x".repeat(PROMPT_MESSAGE_MAX_CHARS + 500);
    const prompt = buildDraftPrompt({ ticket, thread: [comment({ id: "c1", visibility: "PUBLIC", body: long })] });
    expect(prompt.user).toContain("[…truncated]");
    expect(prompt.user).not.toContain(long);
  });

  it("caps the assembled prompt", () => {
    const thread = Array.from({ length: PROMPT_THREAD_LIMIT }, (_, i) =>
      comment({ id: `c${i}`, visibility: "PUBLIC", body: "y".repeat(PROMPT_MESSAGE_MAX_CHARS) }),
    );
    const prompt = buildDraftPrompt({ ticket, thread, instruction: "z".repeat(INSTRUCTION_MAX_CHARS) });
    expect(prompt.user.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS + "\n[…truncated]".length);
  });

  it("is deterministic — the same inputs produce byte-identical prompts", () => {
    const thread = [comment({ id: "c1", visibility: "PUBLIC", body: "hello" })];
    expect(buildDraftPrompt({ ticket, thread })).toEqual(buildDraftPrompt({ ticket, thread }));
  });
});
