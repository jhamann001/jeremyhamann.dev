/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB).
 *
 * Proves the durable-draft path of slice B3 against a real database:
 *
 *  - `saveDraft` upserts one row per (ticket, user, channel) and `loadComposerState` restores both.
 *  - An EMPTY body deletes the row rather than storing an empty draft the next load would restore.
 *  - The body is sanitized before it is persisted — `ComposerDraft` has no retention job and no
 *    immutability guard, so an unredacted account number must not settle there.
 *  - `deleteDraft` really deletes: `ComposerDraft` is one of exactly TWO Wave B tables a row can be
 *    removed from (guardrail G18), and "discard my draft" has to discard it.
 *  - Drafts are per USER and per CHANNEL: one operator never sees another's, and a note is not a reply.
 *  - **Submitting a comment clears that channel's draft in the comment's own transaction.**
 *  - **No audit row is ever written for a draft.** That is the contract, and the assertion is scoped to
 *    this run's requestId so it holds however many other files are writing rows concurrently.
 *
 * Every assertion is scoped to rows this run created (`RUN`-suffixed ids, this run's requestId): the
 * shared test database is permanent by design and files run concurrently.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionResult, OktaGroup, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const OPS_ID = `it_draft_ops_${RUN}`;
const OTHER_ID = `it_draft_other_${RUN}`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));

function viewerOf(id: string, groups: OktaGroup[]): Viewer {
  return { id, email: `${id}@wm-helpdesk.local`, name: `Draft ${id}`, image: null, groups, isDev: false };
}

hoisted.viewer = viewerOf(OPS_ID, ["ops_team"]);
hoisted.ctx = {
  ipAddress: "203.0.113.31",
  userAgent: `it-drafts/${RUN}`,
  requestId: `it-drafts-${RUN}`,
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
const draftActions = TEST_URL ? await import("@/server/drafts.actions") : null;
const draftReads = TEST_URL ? await import("@/server/drafts") : null;
const commentActions = TEST_URL ? await import("@/server/comments.actions") : null;

function mods() {
  if (!dbModule || !draftActions || !draftReads || !commentActions) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { prisma: dbModule.prisma, ...draftActions, ...draftReads, ...commentActions };
}

function ok<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.data;
}

let seq = 0;

async function newTicket(): Promise<string> {
  const { prisma } = mods();
  const id = `it_draft_ticket_${RUN}_${seq++}`;
  const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
  const createdAt = new Date("2026-09-19T09:00:00.000Z");
  await prisma.ticket.create({
    data: {
      id,
      subject: `Draft fixture ${id}`,
      description: "A ticket for the draft tests.",
      requesterName: "Margaret Thompson",
      requesterEmail: `drafts.${id}@example.com`,
      category: "ACAT",
      priority: "STANDARD",
      status: "OPEN",
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

/** Every audit row this run wrote, so "no audit row" is provable in a shared, concurrent database. */
async function auditRowsForRun() {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: { requestId: hoisted.ctx.requestId },
    orderBy: { seq: "asc" },
    select: { action: true, entityType: true, entityId: true },
  });
}

describe.skipIf(!TEST_URL)("composer drafts (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "drafts fixture", sortOrder: 1 },
    });
    for (const id of [OPS_ID, OTHER_ID]) {
      await prisma.user.upsert({
        where: { id },
        update: { groups: ["ops_team"], isActive: true },
        create: {
          id,
          email: `${id}@wm-helpdesk.local`,
          name: `Draft ${id}`,
          groups: ["ops_team"],
          emailVerified: new Date(),
          isActive: true,
        },
      });
    }
  });

  it("stores a draft per channel and restores both on load", async () => {
    const { saveDraft, loadComposerState } = mods();
    const ticketId = await newTicket();

    ok(await saveDraft({ ticketId, channel: "INTERNAL", body: "half a note" }));
    ok(await saveDraft({ ticketId, channel: "PUBLIC", body: "half a reply", disclaimerKey: "GENERAL_SERVICE" }));

    const state = ok(await loadComposerState({ ticketId }));
    expect(state.drafts).toHaveLength(2);
    expect(state.drafts.find((d) => d.channel === "INTERNAL")?.body).toBe("half a note");
    expect(state.drafts.find((d) => d.channel === "PUBLIC")?.body).toBe("half a reply");
    // The AI seam is unset in every environment this wave ships to.
    expect(state.aiEnabled).toBe(false);
  });

  it("upserts rather than accumulating — one row per (ticket, user, channel)", async () => {
    const { saveDraft, prisma } = mods();
    const ticketId = await newTicket();

    for (const body of ["one", "one two", "one two three"]) {
      ok(await saveDraft({ ticketId, channel: "PUBLIC", body }));
    }
    const rows = await prisma.composerDraft.findMany({ where: { ticketId, userId: OPS_ID } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("one two three");
  });

  it("deletes the row when the body goes empty, so nothing is restored later", async () => {
    const { saveDraft, getDraft, prisma } = mods();
    const ticketId = await newTicket();

    ok(await saveDraft({ ticketId, channel: "PUBLIC", body: "typed something" }));
    const cleared = ok(await saveDraft({ ticketId, channel: "PUBLIC", body: "   " }));
    expect(cleared.discarded).toBe(true);

    expect(await prisma.composerDraft.findMany({ where: { ticketId } })).toHaveLength(0);
    expect(await getDraft(hoisted.viewer, ticketId, "PUBLIC")).toBeNull();
  });

  it("sanitizes the body before it is persisted (I4) and says how many values it rewrote", async () => {
    const { saveDraft, prisma } = mods();
    const ticketId = await newTicket();

    const result = ok(
      await saveDraft({ ticketId, channel: "INTERNAL", body: "client gave SSN 123-45-6789 over the phone" }),
    );
    expect(result.redacted).toBe(true);
    expect(result.redactionCount).toBeGreaterThan(0);

    const row = await prisma.composerDraft.findFirstOrThrow({ where: { ticketId, userId: OPS_ID } });
    expect(row.body).not.toContain("123-45-6789");
    expect(row.body).toContain("REDACTED");
  });

  it("really deletes on discard — ComposerDraft is one of the two deletable Wave B tables", async () => {
    const { saveDraft, deleteDraft, prisma } = mods();
    const ticketId = await newTicket();

    ok(await saveDraft({ ticketId, channel: "PUBLIC", body: "abandoned" }));
    expect(ok(await deleteDraft({ ticketId, channel: "PUBLIC" })).deleted).toBe(true);
    expect(await prisma.composerDraft.count({ where: { ticketId } })).toBe(0);

    // A second discard is a successful no-op, not an error and not a fake confirmation.
    expect(ok(await deleteDraft({ ticketId, channel: "PUBLIC" })).deleted).toBe(false);
  });

  it("keeps one operator's draft out of another's composer", async () => {
    const { saveDraft, getDraft, prisma } = mods();
    const ticketId = await newTicket();

    ok(await saveDraft({ ticketId, channel: "PUBLIC", body: "mine" }));
    await prisma.composerDraft.create({
      data: { ticketId, userId: OTHER_ID, channel: "PUBLIC", body: "theirs" },
    });

    expect((await getDraft(hoisted.viewer, ticketId, "PUBLIC"))?.body).toBe("mine");
    expect((await getDraft(viewerOf(OTHER_ID, ["ops_team"]), ticketId, "PUBLIC"))?.body).toBe("theirs");
  });

  it("submitting an internal note clears THAT channel's draft, in the comment's own transaction", async () => {
    const { saveDraft, addInternalNote, prisma } = mods();
    const ticketId = await newTicket();

    ok(await saveDraft({ ticketId, channel: "INTERNAL", body: "the note, half written" }));
    ok(await saveDraft({ ticketId, channel: "PUBLIC", body: "the reply, untouched" }));

    ok(await addInternalNote({ ticketId, body: "the note, finished" }));

    const rows = await prisma.composerDraft.findMany({ where: { ticketId, userId: OPS_ID } });
    expect(rows.map((r) => r.channel)).toEqual(["PUBLIC"]);
    expect(rows[0]?.body).toBe("the reply, untouched");
  });

  it("submitting a public reply clears the public draft", async () => {
    const { saveDraft, addPublicReply, prisma } = mods();
    const ticketId = await newTicket();

    ok(await saveDraft({ ticketId, channel: "PUBLIC", body: "the reply, half written" }));
    ok(
      await addPublicReply({
        ticketId,
        body: "the reply, finished",
        disclaimerKey: "GENERAL_SERVICE",
        disclaimerAcknowledged: true,
      }),
    );

    expect(await prisma.composerDraft.count({ where: { ticketId, userId: OPS_ID, channel: "PUBLIC" } })).toBe(0);
  });

  it("writes NO audit row for any draft operation (CONTRACT §10 B3)", async () => {
    const { saveDraft, deleteDraft, loadComposerState } = mods();
    const before = await auditRowsForRun();
    const ticketId = await newTicket();

    ok(await saveDraft({ ticketId, channel: "INTERNAL", body: "no ledger row for this" }));
    ok(await saveDraft({ ticketId, channel: "INTERNAL", body: "nor this" }));
    ok(await loadComposerState({ ticketId }));
    ok(await deleteDraft({ ticketId, channel: "INTERNAL" }));

    expect(await auditRowsForRun()).toEqual(before);
  });

  it("refuses a public draft to a viewer who cannot reply to the queue, and records the denial", async () => {
    const { saveDraft, prisma } = mods();
    const ticketId = await newTicket();
    const before = hoisted.viewer;
    hoisted.viewer = viewerOf(OPS_ID, ["compliance_officers"]);
    try {
      const denied = await saveDraft({ ticketId, channel: "PUBLIC", body: "should never persist" });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.code).toBe("FORBIDDEN");
      expect(await prisma.composerDraft.count({ where: { ticketId } })).toBe(0);

      const denials = await prisma.auditLog.findMany({
        where: { requestId: hoisted.ctx.requestId, action: "AUTHZ_DENIED" },
        select: { newValue: true },
      });
      expect(denials.some((d) => (d.newValue ?? "").includes("comment:public draft"))).toBe(true);
    } finally {
      hoisted.viewer = before;
    }
  });

  it("404s for a ticket that does not exist rather than autosaving into nothing", async () => {
    const { saveDraft } = mods();
    const missing = await saveDraft({ ticketId: `it_draft_missing_${RUN}`, channel: "INTERNAL", body: "x" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("NOT_FOUND");
  });
});
