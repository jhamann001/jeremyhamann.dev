/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB).
 *
 * Proves the AI draft seam end to end against a real ticket, a real thread and a real ledger, with a
 * FAKE provider standing in for Vertex:
 *
 *  - **Disabled by default.** With no provider configured the action refuses and nothing is called.
 *  - **The prompt never contains an INTERNAL note**, an attachment filename, the requester's name or
 *    their address. This is the compliance assertion of the whole feature, made against the bytes the
 *    provider was actually handed.
 *  - **Nothing is sent.** No comment, no `MessageDelivery` — the draft is returned and that is all.
 *  - **`AI_DRAFT_REQUESTED` carries a sha256, never the text**, plus the provider, the model that
 *    answered and the token counts.
 *  - The output is sanitized before it is returned.
 *  - A provider failure is a VALIDATION result carrying the provider's own operator-facing message,
 *    and writes no audit row — the row records a completed call.
 *  - The per-user rate limit refuses the request after the allowance, without calling the provider.
 *  - `comment:public` is required; a CLOSED ticket is refused.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionResult, OktaGroup, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const OPS_ID = `it_ai_ops_${RUN}`;

const INTERNAL_SECRET = `INTERNAL ONLY ${RUN}: escalate quietly, the client is threatening to complain`;
const REQUESTER_NAME = `Arabella Featherstonehaugh ${RUN}`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));

function viewerOf(id: string, groups: OktaGroup[]): Viewer {
  return { id, email: `${id}@wm-helpdesk.local`, name: "Olivia Ops", image: null, groups, isDev: false };
}

hoisted.viewer = viewerOf(OPS_ID, ["ops_team"]);
hoisted.ctx = {
  ipAddress: "203.0.113.66",
  userAgent: `it-ai-draft/${RUN}`,
  requestId: `it-ai-draft-${RUN}`,
  isPrefetch: false,
};

vi.mock("@/lib/session", () => ({
  requireViewerOrThrow: vi.fn(async () => hoisted.viewer),
  getViewer: vi.fn(async () => hoisted.viewer),
  requireUser: vi.fn(async () => hoisted.viewer),
  requireGroup: vi.fn(async () => hoisted.viewer),
}));
vi.mock("@/lib/request-context", () => ({
  getRequestContext: vi.fn(async () => hoisted.ctx),
  getRequestContextFromRequest: vi.fn(() => hoisted.ctx),
}));

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const aiActions = TEST_URL ? await import("@/server/ai-draft.actions") : null;
const commentActions = TEST_URL ? await import("@/server/comments.actions") : null;
const draftActions = TEST_URL ? await import("@/server/drafts.actions") : null;
const providerModule = TEST_URL ? await import("@/lib/ai/provider") : null;
const fakeModule = TEST_URL ? await import("@/lib/ai/fake") : null;
const errorsModule = TEST_URL ? await import("@/lib/ai/errors") : null;
const rateLimitModule = TEST_URL ? await import("@/lib/ai/rate-limit") : null;

function mods() {
  if (
    !dbModule ||
    !aiActions ||
    !commentActions ||
    !draftActions ||
    !providerModule ||
    !fakeModule ||
    !errorsModule ||
    !rateLimitModule
  ) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return {
    prisma: dbModule.prisma,
    ...aiActions,
    ...commentActions,
    ...draftActions,
    ...providerModule,
    ...fakeModule,
    ...errorsModule,
    ...rateLimitModule,
  };
}

function ok<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.data;
}

let seq = 0;

async function newTicket(over: { status?: "OPEN" | "CLOSED" } = {}): Promise<string> {
  const { prisma } = mods();
  const id = `it_ai_ticket_${RUN}_${seq++}`;
  const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
  const createdAt = new Date("2026-09-19T09:00:00.000Z");
  await prisma.ticket.create({
    data: {
      id,
      subject: `Where is my transfer ${id}`,
      description: "The client is asking about an ACAT.",
      requesterName: REQUESTER_NAME,
      requesterEmail: `ai.${id}@example.com`,
      category: "ACAT",
      priority: "STANDARD",
      status: over.status ?? "OPEN",
      queue: { connect: { id: queue.id } },
      createdBy: { connect: { id: OPS_ID } },
      slaFirstResponseMinutes: 240,
      slaResolutionMinutes: 1440,
      firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
      resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
      createdAt,
    },
    select: { id: true },
  });
  return id;
}

async function aiAuditFor(ticketId: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: { requestId: hoisted.ctx.requestId, ticketId, action: "AI_DRAFT_REQUESTED" },
    orderBy: { seq: "asc" },
    select: { fieldChanged: true, oldValue: true, newValue: true, metadata: true },
  });
}

describe.skipIf(!TEST_URL)("requestAiDraft (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "ai-draft fixture", sortOrder: 1 },
    });
    await prisma.user.upsert({
      where: { id: OPS_ID },
      update: { groups: ["ops_team"], isActive: true },
      create: {
        id: OPS_ID,
        email: `${OPS_ID}@wm-helpdesk.local`,
        name: "Olivia Ops",
        groups: ["ops_team"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
  });

  afterEach(() => {
    const { setAiProviderForTests, resetAiDraftRateLimitForTests } = mods();
    setAiProviderForTests(undefined);
    resetAiDraftRateLimitForTests();
  });

  it("refuses when no provider is configured — the default in every environment", async () => {
    const { requestAiDraft, setAiProviderForTests } = mods();
    setAiProviderForTests(null);
    const ticketId = await newTicket();

    const refused = await requestAiDraft({ ticketId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("VALIDATION");
      expect(refused.fieldErrors?._form?.[0] ?? "").toContain("switched off");
    }
    expect(await aiAuditFor(ticketId)).toHaveLength(0);
  });

  it("never shows the model an internal note, an attachment name or the requester's identity", async () => {
    const { requestAiDraft, setAiProviderForTests, createFakeAiProvider, addInternalNote, addPublicReply, prisma } =
      mods();
    const ticketId = await newTicket();

    ok(await addPublicReply({
      ticketId,
      body: "We have asked the delivering firm for an update.",
      disclaimerKey: "GENERAL_SERVICE",
      disclaimerAcknowledged: true,
    }));
    const note = ok(await addInternalNote({ ticketId, body: INTERNAL_SECRET }));
    await prisma.attachment.create({
      data: {
        ticketId,
        commentId: note.id,
        kind: "UPLOAD",
        filename: `statement-${RUN}.pdf`,
        mime: "application/pdf",
        size: 1024,
        state: "READY",
        objectKey: `itai/${RUN}`,
        sha256: createHash("sha256").update(RUN).digest("hex"),
        uploaderId: OPS_ID,
      },
    });

    const fake = createFakeAiProvider();
    setAiProviderForTests(fake);

    ok(await requestAiDraft({ ticketId }));

    expect(fake.calls).toBe(1);
    const prompt = `${fake.prompts[0]?.system ?? ""}\n${fake.prompts[0]?.user ?? ""}`;
    expect(prompt).not.toContain(INTERNAL_SECRET);
    expect(prompt).not.toContain(REQUESTER_NAME);
    expect(prompt).not.toContain(`ai.${ticketId}@example.com`);
    expect(prompt).not.toContain(`statement-${RUN}.pdf`);
    // What it DOES carry: the public thread and the ticket's own facts.
    expect(prompt).toContain("We have asked the delivering firm for an update.");
    expect(prompt).toContain("Category: ACAT / account transfer");
  });

  it("returns a draft and sends nothing — no comment, no delivery", async () => {
    const { requestAiDraft, setAiProviderForTests, createFakeAiProvider, prisma } = mods();
    const ticketId = await newTicket();
    setAiProviderForTests(createFakeAiProvider({ text: "Thank you for your patience." }));

    const before = await prisma.comment.count({ where: { ticketId } });
    const result = ok(await requestAiDraft({ ticketId }));

    expect(result.draft).toBe("Thank you for your patience.");
    expect(result.provider).toBe("fake");
    expect(result.model).toBe("fake-model-001");
    expect(await prisma.comment.count({ where: { ticketId } })).toBe(before);
    expect(await prisma.messageDelivery.count({ where: { ticketId } })).toBe(0);
  });

  it("audits a sha256 of the draft, never the draft, with the model and the token counts", async () => {
    const { requestAiDraft, setAiProviderForTests, createFakeAiProvider } = mods();
    const ticketId = await newTicket();
    const text = `A draft about nothing in particular ${RUN}.`;
    setAiProviderForTests(createFakeAiProvider({ text, model: "gemini-test-9", promptTokens: 321, outputTokens: 45 }));

    const result = ok(await requestAiDraft({ ticketId }));
    const expected = createHash("sha256").update(text, "utf8").digest("hex");
    expect(result.hash).toBe(expected);

    const rows = await aiAuditFor(ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fieldChanged: "draft", oldValue: null, newValue: expected });
    expect(rows[0]?.newValue).not.toContain(RUN);
    expect(rows[0]?.metadata).toMatchObject({
      provider: "fake",
      model: "gemini-test-9",
      promptTokens: 321,
      outputTokens: 45,
    });
  });

  it("sanitizes the model's output before returning it (I4)", async () => {
    const { requestAiDraft, setAiProviderForTests, createFakeAiProvider } = mods();
    const ticketId = await newTicket();
    setAiProviderForTests(createFakeAiProvider({ text: "Your account 123-45-6789 is fine." }));

    const result = ok(await requestAiDraft({ ticketId }));
    expect(result.draft).not.toContain("123-45-6789");
    expect(result.draft).toContain("REDACTED");
  });

  it("uses the macro selected in the operator's own draft as the approved template", async () => {
    const { requestAiDraft, setAiProviderForTests, createFakeAiProvider, saveDraft, prisma } = mods();
    const ticketId = await newTicket();
    const macro = await prisma.macro.create({
      data: {
        key: `it-ai-macro-${RUN}`,
        title: "ACAT status",
        body: `Your transfer is in progress. Reference {{ticket.number}}. ${RUN}`,
        channel: "PUBLIC",
        disclaimerKey: "GENERAL_SERVICE",
        isActive: true,
        sortOrder: 0,
      },
      select: { id: true },
    });
    ok(await saveDraft({ ticketId, channel: "PUBLIC", body: "half typed", macroId: macro.id }));

    const fake = createFakeAiProvider();
    setAiProviderForTests(fake);
    ok(await requestAiDraft({ ticketId }));

    const prompt = fake.prompts[0]?.user ?? "";
    expect(prompt).toContain("FIRM-APPROVED TEMPLATE");
    expect(prompt).toContain("Your transfer is in progress.");
    // The placeholder was rendered, not shipped raw.
    expect(prompt).not.toContain("{{ticket.number}}");
    expect((fake.requests[0]?.macroBody ?? "")).toContain(RUN);
  });

  it("passes the operator's instruction through", async () => {
    const { requestAiDraft, setAiProviderForTests, createFakeAiProvider } = mods();
    const ticketId = await newTicket();
    const fake = createFakeAiProvider();
    setAiProviderForTests(fake);

    ok(await requestAiDraft({ ticketId, instruction: "two sentences, ask for the account number" }));
    expect(fake.prompts[0]?.user).toContain("two sentences, ask for the account number");

    const rows = await aiAuditFor(ticketId);
    expect((rows[0]?.metadata as { hadInstruction?: boolean })?.hadInstruction).toBe(true);
  });

  it("surfaces a provider failure as VALIDATION and writes NO audit row", async () => {
    const { requestAiDraft, setAiProviderForTests, createFakeAiProvider, AiProviderError } = mods();
    const ticketId = await newTicket();
    setAiProviderForTests(
      createFakeAiProvider({ failWith: new AiProviderError("fake", "the model returned no text (SAFETY)") }),
    );

    const failed = await requestAiDraft({ ticketId });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("VALIDATION");
      expect(failed.fieldErrors?._form?.[0]).toBe("the model returned no text (SAFETY)");
    }
    // The row records a COMPLETED call; a timeout must not claim a draft that never existed.
    expect(await aiAuditFor(ticketId)).toHaveLength(0);
  });

  it("refuses past the per-user allowance without calling the provider", async () => {
    const { requestAiDraft, setAiProviderForTests, createFakeAiProvider, AI_DRAFT_LIMIT_PER_WINDOW } = mods();
    const ticketId = await newTicket();
    const fake = createFakeAiProvider();
    setAiProviderForTests(fake);

    for (let i = 0; i < AI_DRAFT_LIMIT_PER_WINDOW; i += 1) {
      ok(await requestAiDraft({ ticketId }));
    }
    const refused = await requestAiDraft({ ticketId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("VALIDATION");
    expect(fake.calls).toBe(AI_DRAFT_LIMIT_PER_WINDOW);
  });

  it("requires comment:public and records the denial", async () => {
    const { requestAiDraft, setAiProviderForTests, createFakeAiProvider, prisma } = mods();
    const ticketId = await newTicket();
    const fake = createFakeAiProvider();
    setAiProviderForTests(fake);

    const before = hoisted.viewer;
    hoisted.viewer = viewerOf(OPS_ID, ["compliance_officers"]);
    try {
      const denied = await requestAiDraft({ ticketId });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.code).toBe("FORBIDDEN");
      expect(fake.calls).toBe(0);

      const denials = await prisma.auditLog.findMany({
        where: { requestId: hoisted.ctx.requestId, action: "AUTHZ_DENIED" },
        select: { newValue: true },
      });
      expect(denials.some((d) => (d.newValue ?? "").includes("comment:public ai-draft"))).toBe(true);
    } finally {
      hoisted.viewer = before;
    }
  });

  it("refuses on a CLOSED ticket, which takes no reply at all", async () => {
    const { requestAiDraft, setAiProviderForTests, createFakeAiProvider } = mods();
    const ticketId = await newTicket({ status: "CLOSED" });
    const fake = createFakeAiProvider();
    setAiProviderForTests(fake);

    const refused = await requestAiDraft({ ticketId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("VALIDATION");
    expect(fake.calls).toBe(0);
  });
});
