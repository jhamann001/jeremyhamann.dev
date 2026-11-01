/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB,
 * the immutability triggers make every row written here permanent).
 *
 * Proves the whole of the B2 link and merge path against a real database and real transactions:
 *  - `addTicketLink` writes the row and `TICKET_LINK_ADDED` with `{toTicketNumber}`, refuses a
 *    duplicate of itself, refuses a second identical link, refuses a note pointing at a host that is
 *    not the firm's, and REVIVES a soft-removed link rather than inserting a second row;
 *  - `removeTicketLink` soft-removes (the table has no DELETE privilege) and writes the paired row;
 *    a second remove is accepted and writes nothing, because nothing transitioned;
 *  - `mergeTickets` sets `mergedIntoId` + `mergedAt` + `resolution: DUPLICATE` + RESOLVED + the
 *    `DUPLICATE_OF` link + `TICKET_MERGED`, ALL IN ONE transaction, and **never moves a STAFF comment**;
 *  - `mergeTickets` sends the client's resolved notice, exactly as every other path into RESOLVED does;
 *  - `links:write` is refused on BOTH tickets, and each refusal is in the ledger;
 *  - a stale version token conflicts rather than overwriting somebody else's work.
 *
 * Every assertion is scoped to rows this run created (`RUN`), because the test database is permanent
 * and files run concurrently.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OktaGroup, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;
// `src/lib/env.ts` parses ONCE at import, so this must be set before the dynamic imports below. It is
// what makes the resolved-notice assertion possible at all: with it unset `maybeSendResolvedNotice`
// returns null and "nothing was written" would prove nothing. Nothing transmits — the notice is a
// Comment plus a QUEUED MessageDelivery row, and no dispatcher runs in this process — and the flag is
// file-local.
process.env.RESOLVED_NOTICE_ENABLED = "true";

const RUN = randomUUID().slice(0, 8);
const OPS_ID = `it_links_ops_${RUN}`;
const A = `it_links_a_${RUN}`;
const B = `it_links_b_${RUN}`;
const C = `it_links_c_${RUN}`;
const ADVICE_T = `it_links_advice_${RUN}`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));
hoisted.viewer = {
  id: OPS_ID,
  email: `links.ops.${RUN}@wm-helpdesk.local`,
  name: "Otto Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.22",
  userAgent: `it-links/${RUN}`,
  requestId: `it-links-${RUN}`,
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
const actions = TEST_URL ? await import("@/server/ticket-links.actions") : null;
const reads = TEST_URL ? await import("@/server/ticket-links") : null;

function mods() {
  if (!dbModule || !actions || !reads) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...actions, ...reads };
}

async function asGroups<T>(groups: OktaGroup[], fn: () => Promise<T>): Promise<T> {
  const before = hoisted.viewer.groups;
  hoisted.viewer = { ...hoisted.viewer, groups };
  try {
    return await fn();
  } finally {
    hoisted.viewer = { ...hoisted.viewer, groups: before };
  }
}

/** Audit rows this run wrote, oldest first. Scoped by requestId — never the whole table. */
async function auditRows(action?: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: { requestId: hoisted.ctx.requestId, ...(action === undefined ? {} : { action: action as never }) },
    orderBy: { seq: "asc" },
    select: { action: true, entityType: true, entityId: true, ticketId: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true },
  });
}

async function ticketNumber(id: string): Promise<number> {
  const { prisma } = mods();
  return (await prisma.ticket.findUniqueOrThrow({ where: { id }, select: { number: true } })).number;
}

describe.skipIf(!TEST_URL)("ticket links and merge (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    for (const q of [
      { key: "OPERATIONS" as const, name: "Operations", sortOrder: 1 },
      { key: "ADVICE" as const, name: "Advice", sortOrder: 3 },
    ]) {
      await prisma.queue.upsert({
        where: { key: q.key },
        update: {},
        create: { key: q.key, name: q.name, description: "links fixture", sortOrder: q.sortOrder },
      });
    }
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    const advice = await prisma.queue.findUniqueOrThrow({ where: { key: "ADVICE" } });

    await prisma.user.upsert({
      where: { id: OPS_ID },
      update: { groups: ["ops_team"], isActive: true },
      create: { id: OPS_ID, email: hoisted.viewer.email, name: "Otto Ops", groups: ["ops_team"], isActive: true, emailVerified: new Date() },
    });

    const createdAt = new Date("2026-09-19T12:00:00.000Z");
    for (const t of [
      { id: A, queueId: ops.id },
      { id: B, queueId: ops.id },
      { id: C, queueId: ops.id },
      { id: ADVICE_T, queueId: advice.id },
    ]) {
      await prisma.ticket.upsert({
        where: { id: t.id },
        update: { status: "OPEN", mergedIntoId: null, mergedAt: null, resolution: "NONE" },
        create: {
          id: t.id,
          subject: `Link fixture ${t.id}`,
          description: "Link fixture description",
          requesterName: "Dana Requester",
          requesterEmail: `links.${RUN}@example.com`,
          category: "ACAT",
          priority: "STANDARD",
          status: "OPEN",
          queueId: t.queueId,
          createdById: OPS_ID,
          slaFirstResponseMinutes: 240,
          slaResolutionMinutes: 1440,
          firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
          resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
        },
      });
    }
  });

  it("links two tickets, audits it with the other ticket's NUMBER, and reads back from both ends", async () => {
    const { addTicketLink, listTicketLinks, prisma } = mods();
    const bNumber = await ticketNumber(B);

    const result = await addTicketLink({ ticketId: A, otherTicketNumber: bNumber, kind: "RELATED", note: "same client, same week" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await prisma.ticketLink.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(row.fromTicketId).toBe(A);
    expect(row.toTicketId).toBe(B);
    expect(row.removedAt).toBeNull();
    expect(row.createdById).toBe(OPS_ID);

    const added = (await auditRows()).filter((r) => r.action === "TICKET_LINK_ADDED" && r.entityId === result.data.id);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      entityType: "TICKET_LINK",
      ticketId: A,
      fieldChanged: "kind",
      oldValue: null,
      newValue: "RELATED",
    });
    expect((added[0]?.metadata as { toTicketNumber?: number } | null)?.toTicketNumber).toBe(bNumber);

    // One row, two correct sentences.
    const fromA = await listTicketLinks(hoisted.viewer, A);
    expect(fromA.find((l) => l.id === result.data.id)?.inbound).toBe(false);
    const fromB = await listTicketLinks(hoisted.viewer, B);
    expect(fromB.find((l) => l.id === result.data.id)?.inbound).toBe(true);
    expect(fromB.find((l) => l.id === result.data.id)?.otherTicketNumber).toBe(await ticketNumber(A));
  });

  it("refuses a second identical link, a self-link and a hand-made DUPLICATE_OF", async () => {
    const { addTicketLink } = mods();
    const bNumber = await ticketNumber(B);
    const aNumber = await ticketNumber(A);

    const again = await addTicketLink({ ticketId: A, otherTicketNumber: bNumber, kind: "RELATED" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("VALIDATION");

    const self = await addTicketLink({ ticketId: A, otherTicketNumber: aNumber, kind: "RELATED" });
    expect(self.ok).toBe(false);

    const dup = await addTicketLink({ ticketId: A, otherTicketNumber: bNumber, kind: "DUPLICATE_OF" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.fieldErrors?.kind?.join(" ")).toMatch(/duplicate/i);
  });

  it("refuses a note that links to a host outside the firm, and writes nothing", async () => {
    const { addTicketLink, prisma } = mods();
    const before = await prisma.ticketLink.count({ where: { fromTicketId: A } });

    const bad = await addTicketLink({
      ticketId: A,
      otherTicketNumber: await ticketNumber(C),
      kind: "RELATED",
      note: "details at https://pastebin.com/abc",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("VALIDATION");
    expect(await prisma.ticketLink.count({ where: { fromTicketId: A } })).toBe(before);
  });

  it("soft-removes, pairs the audit row, and accepts a second remove without writing again", async () => {
    const { addTicketLink, removeTicketLink, listTicketLinks, prisma } = mods();
    const cNumber = await ticketNumber(C);
    const created = await addTicketLink({ ticketId: A, otherTicketNumber: cNumber, kind: "BLOCKS" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const removed = await removeTicketLink({ linkId: created.data.id });
    expect(removed.ok).toBe(true);

    const row = await prisma.ticketLink.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.removedAt).not.toBeNull();
    expect(row.removedById).toBe(OPS_ID);

    expect((await listTicketLinks(hoisted.viewer, A)).map((l) => l.id)).not.toContain(created.data.id);

    const removals = (await auditRows()).filter((r) => r.action === "TICKET_LINK_REMOVED" && r.entityId === created.data.id);
    expect(removals).toHaveLength(1);
    expect(removals[0]).toMatchObject({ fieldChanged: "kind", oldValue: "BLOCKS", newValue: null });

    const secondRemove = await removeTicketLink({ linkId: created.data.id });
    expect(secondRemove.ok).toBe(true);
    const after = (await auditRows()).filter((r) => r.action === "TICKET_LINK_REMOVED" && r.entityId === created.data.id);
    expect(after).toHaveLength(1);

    // Re-linking revives the SAME row rather than inserting a second one (the unique index, and no
    // DELETE privilege, mean a second insert would fail).
    const revived = await addTicketLink({ ticketId: A, otherTicketNumber: cNumber, kind: "BLOCKS" });
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.data.id).toBe(created.data.id);
    expect(
      await prisma.ticketLink.count({ where: { fromTicketId: A, toTicketId: C, kind: "BLOCKS" } }),
    ).toBe(1);
  });

  it("refuses links:write on EITHER ticket and records the denial", async () => {
    const { addTicketLink, prisma } = mods();
    const adviceNumber = await ticketNumber(ADVICE_T);

    // client_services writes Client Service and Operations but not Advice: the far ticket fails.
    const denied = await asGroups(["client_services"], () =>
      addTicketLink({ ticketId: A, otherTicketNumber: adviceNumber, kind: "RELATED" }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(["FORBIDDEN", "NOT_FOUND"]).toContain(denied.code);

    // compliance writes nothing: the near ticket fails.
    const bNumber = await ticketNumber(B);
    const complianceDenied = await asGroups(["compliance_officers"], () =>
      addTicketLink({ ticketId: A, otherTicketNumber: bNumber, kind: "RELATED" }),
    );
    expect(complianceDenied.ok).toBe(false);
    if (!complianceDenied.ok) expect(complianceDenied.code).toBe("FORBIDDEN");

    const denials = await prisma.auditLog.count({
      where: { requestId: hoisted.ctx.requestId, action: "AUTHZ_DENIED" },
    });
    expect(denials).toBeGreaterThan(0);
  });

  it("merges in ONE transaction: fields, link, status, audit — and never moves a comment", async () => {
    const { mergeTickets, prisma } = mods();
    const loser = `it_links_loser_${RUN}`;
    const createdAt = new Date("2026-09-19T12:00:00.000Z");
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    await prisma.ticket.create({
      data: {
        id: loser,
        subject: "Merge fixture",
        description: "Merge fixture description",
        requesterName: "Dana Requester",
        requesterEmail: `links.${RUN}@example.com`,
        category: "ACAT",
        priority: "STANDARD",
        status: "OPEN",
        queueId: ops.id,
        createdById: OPS_ID,
        slaFirstResponseMinutes: 240,
        slaResolutionMinutes: 1440,
        firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
        resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
      },
    });
    await prisma.comment.create({
      data: { ticketId: loser, authorId: OPS_ID, authorKind: "STAFF", visibility: "INTERNAL", body: `stays put ${RUN}` },
    });

    const survivorNumber = await ticketNumber(B);
    const result = await mergeTickets({
      ticketId: loser,
      version: 1,
      intoTicketNumber: survivorNumber,
      reason: "same client asked twice in one morning",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.intoTicketId).toBe(B);

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: loser } });
    expect(after.mergedIntoId).toBe(B);
    expect(after.mergedAt).not.toBeNull();
    expect(after.resolution).toBe("DUPLICATE");
    expect(after.status).toBe("RESOLVED");
    expect(after.version).toBe(2);

    // The loser keeps its own record: the comment did not move. Counted by BODY rather than by a bare
    // total, because with `RESOLVED_NOTICE_ENABLED` set the loser also gains the SYSTEM-authored
    // resolved notice — a new comment written here, not one moved from anywhere.
    expect(await prisma.comment.count({ where: { ticketId: loser, body: `stays put ${RUN}` } })).toBe(1);
    expect(await prisma.comment.count({ where: { ticketId: B, body: `stays put ${RUN}` } })).toBe(0);
    expect(await prisma.comment.count({ where: { ticketId: loser, authorKind: "STAFF" } })).toBe(1);

    const link = await prisma.ticketLink.findFirstOrThrow({
      where: { fromTicketId: loser, toTicketId: B, kind: "DUPLICATE_OF" },
    });
    expect(link.removedAt).toBeNull();

    const rows = await auditRows();
    const merged = rows.filter((r) => r.action === "TICKET_MERGED" && r.ticketId === loser);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ entityType: "TICKET", fieldChanged: "mergedIntoId", oldValue: null, newValue: B });
    expect((merged[0]?.metadata as { intoTicketNumber?: number } | null)?.intoTicketNumber).toBe(survivorNumber);

    expect(rows.filter((r) => r.action === "TICKET_STATUS_CHANGED" && r.ticketId === loser && r.newValue === "RESOLVED")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "TICKET_FIELD_CHANGED" && r.ticketId === loser && r.fieldChanged === "resolution")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "TICKET_LINK_ADDED" && r.entityId === link.id)).toHaveLength(1);

    // Already merged: refused, and the row is untouched.
    const again = await mergeTickets({ ticketId: loser, version: 2, intoTicketNumber: survivorNumber, reason: "trying again for no reason" });
    expect(again.ok).toBe(false);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: loser } })).version).toBe(2);
  });

  /**
   * Fix round 2. `mergeTickets` was the ONE remaining path into RESOLVED that did not run
   * `maybeSendResolvedNotice` — `changeTicketStatus`, `applyBulkAction` and `applyMacroActions` all
   * do — so resolving HD-n from the ticket page emailed the client and resolving the identical HD-n+1
   * by merging it into a survivor did not, with nothing on either record to explain the difference.
   */
  it("sends the resolved notice on a merge-driven RESOLVED, like every other path", async () => {
    const { mergeTickets, prisma } = mods();
    const loser = `it_links_notice_${RUN}`;
    const createdAt = new Date("2026-09-19T12:00:00.000Z");
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    await prisma.ticket.create({
      data: {
        id: loser,
        subject: "Merge notice fixture",
        description: "Merge notice fixture description",
        requesterName: "Dana Requester",
        requesterEmail: `links.notice.${RUN}@example.com`,
        category: "ACAT",
        priority: "STANDARD",
        status: "OPEN",
        queueId: ops.id,
        createdById: OPS_ID,
        slaFirstResponseMinutes: 240,
        slaResolutionMinutes: 1440,
        firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
        resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
      },
    });

    const result = await mergeTickets({
      ticketId: loser,
      version: 1,
      intoTicketNumber: await ticketNumber(A),
      reason: "the same wire request, sent twice in one morning",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The notice itself: SYSTEM-authored, PUBLIC, with a delivery queued in the SAME transaction.
    const comments = await prisma.comment.findMany({
      where: { ticketId: loser },
      select: { id: true, authorKind: true, authorId: true, visibility: true },
    });
    expect(comments).toEqual([{ id: comments[0]?.id, authorKind: "SYSTEM", authorId: null, visibility: "PUBLIC" }]);
    expect(await prisma.messageDelivery.count({ where: { ticketId: loser } })).toBe(1);

    // And its audit rows rode along in the merge's own trailing `writeAuditMany`.
    const rows = (await auditRows()).filter((r) => r.ticketId === loser);
    const notice = rows.find(
      (r) =>
        r.action === "COMMENT_ADDED_PUBLIC" &&
        (r.metadata as { systemMessage?: string } | null)?.systemMessage === "RESOLVED_NOTICE",
    );
    expect(notice).toBeDefined();
    // A person clicked Merge, so the row must NOT claim a machine channel (CONTRACT §3 rule 1).
    expect((notice?.metadata as { via?: string } | null)?.via).toBeUndefined();
    expect(rows.some((r) => r.action === "MESSAGE_QUEUED")).toBe(true);
    // The first-response clock is never moved by a SYSTEM message.
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: loser } })).firstRespondedAt).toBeNull();
  });

  /**
   * The other half of the same rule: a ticket ALREADY in RESOLVED is not transitioning, so tidying up
   * the duplicate link afterwards must not re-send a notice about work that finished days ago.
   */
  it("sends no notice when the loser was already RESOLVED", async () => {
    const { mergeTickets, prisma } = mods();
    const loser = `it_links_noticeskip_${RUN}`;
    const createdAt = new Date("2026-09-19T12:00:00.000Z");
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    await prisma.ticket.create({
      data: {
        id: loser,
        subject: "Merge notice skip fixture",
        description: "Merge notice skip fixture description",
        requesterName: "Dana Requester",
        requesterEmail: `links.skip.${RUN}@example.com`,
        category: "ACAT",
        priority: "STANDARD",
        status: "RESOLVED",
        resolvedAt: createdAt,
        queueId: ops.id,
        createdById: OPS_ID,
        slaFirstResponseMinutes: 240,
        slaResolutionMinutes: 1440,
        firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
        resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
      },
    });

    const result = await mergeTickets({
      ticketId: loser,
      version: 1,
      intoTicketNumber: await ticketNumber(A),
      reason: "recording the duplicate long after it was answered",
    });
    expect(result.ok).toBe(true);

    expect(await prisma.comment.count({ where: { ticketId: loser } })).toBe(0);
    expect(await prisma.messageDelivery.count({ where: { ticketId: loser } })).toBe(0);
  });

  it("refuses a merge on a stale version rather than overwriting somebody else's work", async () => {
    const { mergeTickets, prisma } = mods();
    const stale = await mergeTickets({
      ticketId: C,
      version: 999,
      intoTicketNumber: await ticketNumber(B),
      reason: "this should never be written",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("CONFLICT");
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: C } })).mergedIntoId).toBeNull();
  });

  it("refuses a reason that is too short, before anything is written", async () => {
    const { mergeTickets, prisma } = mods();
    const short = await mergeTickets({ ticketId: C, version: 1, intoTicketNumber: await ticketNumber(B), reason: "dupe" });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.code).toBe("VALIDATION");
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: C } })).resolution).toBe("NONE");
  });
});
