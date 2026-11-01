/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; `TEST_DATABASE_URL` only — never the dev
 * database, because the immutability triggers make every row written here permanent).
 *
 * EVERY assertion is scoped to rows this run created, by a per-run marker in the ids and in
 * `requestId`: the test database is shared and permanent, and files run concurrently.
 *
 * What it proves against a real database and a real transaction:
 *  - `notifyFromEvent` notifies followers and the assignee, never the actor, and returns its
 *    `TICKET_FOLLOWED` entries instead of writing them (CONTRACT §3 rule 2).
 *  - `@mentions` are parsed from INTERNAL notes only, resolve against ACTIVE users only, produce
 *    `MENTION` rows with a snippet, auto-follow with `source: MENTION`, and suppress the
 *    `FOLLOWED_UPDATE` row that person would otherwise also get.
 *  - the mention-candidate read runs on the CALLER'S transaction, so a user reinstated earlier in the
 *    same transaction is already mentionable (it would be invisible on a second pooled connection).
 *  - A `dedupeKey` collapses a repeat instead of aborting the caller's transaction with a P2002.
 *  - `followTicket` is audited both ways, soft-removes rather than deleting, and writes nothing when
 *    asked for the state that already holds.
 *  - `markNotificationsRead` is scoped to the caller's own rows and writes NO audit row (§3 rule 3).
 *  - `setNotificationPrefs` writes exactly one `NOTIFICATION_PREFS_CHANGED` row carrying a SUMMARY.
 *  - `listInbox` pages by cursor and withholds the subject, the number AND the preview of a ticket
 *    the viewer may no longer read, while still returning the row.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AuditEntry, OktaGroup, RequestContext, Viewer } from "@/types/domain";
import { NOTIFICATION_KIND_LABELS } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL: repoint it BEFORE the first import of @/lib/db.
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const OPS_ID = `it_ntf_ops_${RUN}`;
const CS_ID = `it_ntf_cs_${RUN}`;
const COMPL_ID = `it_ntf_compl_${RUN}`;
const GONE_ID = `it_ntf_gone_${RUN}`;
const TICKET_ID = `it_ntf_ticket_${RUN}`;
const CS_TICKET_ID = `it_ntf_cs_ticket_${RUN}`;
/** In ADVICE, the one queue `client_services` cannot read — that is what it is for. */
const ADVICE_TICKET_ID = `it_ntf_adv_ticket_${RUN}`;

const OPS_EMAIL = `ntf.ops.${RUN}@wm-helpdesk.local`;
const CS_EMAIL = `ntf.cs.${RUN}@wm-helpdesk.local`;
const COMPL_EMAIL = `ntf.compl.${RUN}@wm-helpdesk.local`;
const GONE_EMAIL = `ntf.gone.${RUN}@wm-helpdesk.local`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));
hoisted.viewer = {
  id: OPS_ID,
  email: OPS_EMAIL,
  name: "Ollie Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.42",
  userAgent: `it-notifications/${RUN}`,
  requestId: `it-notifications-${RUN}`,
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
const auditModule = TEST_URL ? await import("@/lib/audit") : null;
const coreModule = TEST_URL ? await import("@/server/notifications") : null;
const actionsModule = TEST_URL ? await import("@/server/notifications.actions") : null;
const dispatchModule = TEST_URL ? await import("@/server/notifications-dispatch") : null;

function mods() {
  if (!dbModule || !auditModule || !coreModule || !actionsModule || !dispatchModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...auditModule, ...coreModule, ...actionsModule, ...dispatchModule };
}

/** Audit rows this run wrote, oldest first. Scoped by requestId — never the whole ledger. */
async function auditRows(action?: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: { requestId: hoisted.ctx.requestId, ...(action === undefined ? {} : { action: action as never }) },
    orderBy: { seq: "asc" },
    select: {
      action: true,
      entityType: true,
      entityId: true,
      ticketId: true,
      fieldChanged: true,
      oldValue: true,
      newValue: true,
      metadata: true,
    },
  });
}

/** Notifications for a person, restricted to the tickets this run created. */
async function notificationsFor(userId: string) {
  const { prisma } = mods();
  return prisma.notification.findMany({
    where: { userId, ticketId: { in: [TICKET_ID, CS_TICKET_ID, ADVICE_TICKET_ID] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, preview: true, actorId: true, commentId: true, dedupeKey: true, channels: true, readAt: true },
  });
}

/** Drives `notifyFromEvent` exactly as a call site does: inside a transaction, entries written last. */
async function notify(event: Parameters<ReturnType<typeof mods>["notifyFromEvent"]>[1]) {
  const { withTx, notifyFromEvent, writeAuditMany, actorFromViewer } = mods();
  return withTx(async (tx) => {
    const result = await notifyFromEvent(tx, event);
    const entries: AuditEntry[] = result.auditEntries;
    await writeAuditMany(tx, actorFromViewer(hoisted.viewer), hoisted.ctx, entries);
    return result;
  });
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

async function asUser<T>(id: string, email: string, groups: OktaGroup[], fn: () => Promise<T>): Promise<T> {
  const before = hoisted.viewer;
  hoisted.viewer = { ...before, id, email, groups };
  try {
    return await fn();
  } finally {
    hoisted.viewer = before;
  }
}

describe.skipIf(!TEST_URL)("notifications (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    const QUEUE_ORDER = { OPERATIONS: 1, CLIENT_SERVICE: 2, ADVICE: 3 } as const;
    for (const key of ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"] as const) {
      await prisma.queue.upsert({
        where: { key },
        update: {},
        create: { key, name: key, description: "notifications fixture", sortOrder: QUEUE_ORDER[key] },
      });
    }
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    const cs = await prisma.queue.findUniqueOrThrow({ where: { key: "CLIENT_SERVICE" } });
    const advice = await prisma.queue.findUniqueOrThrow({ where: { key: "ADVICE" } });

    const people: Array<{ id: string; email: string; name: string; groups: OktaGroup[]; isActive: boolean }> = [
      { id: OPS_ID, email: OPS_EMAIL, name: "Ollie Ops", groups: ["ops_team"], isActive: true },
      { id: CS_ID, email: CS_EMAIL, name: "Cara Service", groups: ["client_services"], isActive: true },
      { id: COMPL_ID, email: COMPL_EMAIL, name: "Cleo Compliance", groups: ["compliance_officers"], isActive: true },
      { id: GONE_ID, email: GONE_EMAIL, name: "Gus Gone", groups: ["ops_team"], isActive: false },
    ];
    for (const p of people) {
      await prisma.user.upsert({
        where: { id: p.id },
        update: { groups: p.groups, isActive: p.isActive, name: p.name },
        create: {
          id: p.id,
          email: p.email,
          name: p.name,
          groups: p.groups,
          emailVerified: new Date(),
          isActive: p.isActive,
        },
      });
    }

    const createdAt = new Date("2026-09-18T12:00:00.000Z");
    for (const t of [
      { id: TICKET_ID, queueId: ops.id, assigneeId: CS_ID },
      { id: CS_TICKET_ID, queueId: cs.id, assigneeId: null as string | null },
      { id: ADVICE_TICKET_ID, queueId: advice.id, assigneeId: null as string | null },
    ]) {
      await prisma.ticket.upsert({
        where: { id: t.id },
        update: { assigneeId: t.assigneeId },
        create: {
          id: t.id,
          subject: `Notification fixture ${t.id}`,
          description: "Notification fixture description",
          requesterName: "Fixture Requester",
          requesterEmail: `ntf.${RUN}@example.com`,
          category: "TRADE_CORRECTION",
          priority: "STANDARD",
          status: "OPEN",
          queue: { connect: { id: t.queueId } },
          createdBy: { connect: { id: OPS_ID } },
          ...(t.assigneeId === null ? {} : { assignee: { connect: { id: t.assigneeId } } }),
          slaFirstResponseMinutes: 240,
          slaResolutionMinutes: 1440,
          firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
          resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
        },
      });
    }
  });

  it("notifies the assignee and NOT the actor, and writes no Notification audit row", async () => {
    const { prisma } = mods();
    const before = (await auditRows()).length;

    const result = await notify({
      kind: "FOLLOWED_UPDATE",
      ticketId: TICKET_ID,
      preview: "Status OPEN → PENDING_CLIENT",
      actorId: OPS_ID,
    });

    expect(result.created).toBe(1);
    const cs = await notificationsFor(CS_ID);
    expect(cs.map((n) => n.kind)).toEqual(["FOLLOWED_UPDATE"]);
    expect(cs[0].channels).toEqual(["IN_APP"]);
    expect(cs[0].actorId).toBe(OPS_ID);
    expect(await notificationsFor(OPS_ID)).toEqual([]);

    // A notification is DERIVED from an audited event: creating one writes nothing to the ledger.
    expect((await auditRows()).length).toBe(before);
    await prisma.notification.updateMany({ where: { id: cs[0].id }, data: { readAt: new Date() } });
  });

  it("an explicit recipient is still never the actor — 'assign to me' stays silent", async () => {
    const result = await notify({
      kind: "ASSIGNED",
      ticketId: TICKET_ID,
      preview: `Assigned to you: HD-x`,
      actorId: OPS_ID,
      recipientIds: [OPS_ID],
    });
    expect(result.created).toBe(0);
    expect(result.auditEntries).toEqual([]);
  });

  it("auto-follows the assignee on ASSIGNED and returns the TICKET_FOLLOWED entry for the caller to write", async () => {
    const { prisma } = mods();
    const result = await notify({
      kind: "ASSIGNED",
      ticketId: TICKET_ID,
      preview: "Assigned to you",
      actorId: OPS_ID,
      recipientIds: [COMPL_ID],
    });
    expect(result.created).toBe(1);
    expect(result.auditEntries).toHaveLength(1);
    expect(result.auditEntries[0]).toMatchObject({
      action: "TICKET_FOLLOWED",
      entityType: "TICKET",
      ticketId: TICKET_ID,
      fieldChanged: "follower",
      oldValue: null,
      newValue: COMPL_EMAIL,
    });

    const follower = await prisma.ticketFollower.findUniqueOrThrow({
      where: { ticketId_userId: { ticketId: TICKET_ID, userId: COMPL_ID } },
      select: { source: true, removedAt: true },
    });
    expect(follower).toEqual({ source: "ASSIGNEE", removedAt: null });

    // Re-running writes no second follow row: the ledger records CHANGES, not intentions.
    const again = await notify({
      kind: "ASSIGNED",
      ticketId: TICKET_ID,
      preview: "Assigned to you",
      actorId: OPS_ID,
      recipientIds: [COMPL_ID],
    });
    expect(again.auditEntries).toEqual([]);
  });

  it("parses @mentions from an INTERNAL note, snippets them, auto-follows, and suppresses the duplicate", async () => {
    const { prisma } = mods();
    const comment = await prisma.comment.create({
      data: {
        ticketId: TICKET_ID,
        authorId: OPS_ID,
        authorKind: "STAFF",
        visibility: "INTERNAL",
        body: `Confirming the callback — @${CS_EMAIL} please check before the cutoff, thanks.`,
      },
      select: { id: true },
    });

    const result = await notify({
      kind: "FOLLOWED_UPDATE",
      ticketId: TICKET_ID,
      commentId: comment.id,
      preview: "Internal note added",
      actorId: OPS_ID,
    });

    const cs = (await notificationsFor(CS_ID)).filter((n) => n.commentId === comment.id);
    expect(cs).toHaveLength(1);
    // MENTION beats FOLLOWED_UPDATE: one comment, one row per person.
    expect(cs[0].kind).toBe("MENTION");
    expect(cs[0].preview).toContain("please check before the cutoff");
    expect(cs[0].dedupeKey).toBe(`mention:${comment.id}`);

    const follower = await prisma.ticketFollower.findUniqueOrThrow({
      where: { ticketId_userId: { ticketId: TICKET_ID, userId: CS_ID } },
      select: { source: true, removedAt: true },
    });
    expect(follower).toEqual({ source: "MENTION", removedAt: null });

    // The author follows their own note.
    const authorFollow = await prisma.ticketFollower.findUniqueOrThrow({
      where: { ticketId_userId: { ticketId: TICKET_ID, userId: OPS_ID } },
      select: { source: true, removedAt: true },
    });
    expect(authorFollow).toEqual({ source: "AUTHOR", removedAt: null });
    expect(result.created).toBeGreaterThanOrEqual(1);

    // Re-notifying the same comment collapses on the dedupe key instead of throwing P2002.
    const repeat = await notify({
      kind: "FOLLOWED_UPDATE",
      ticketId: TICKET_ID,
      commentId: comment.id,
      preview: "Internal note added",
      actorId: OPS_ID,
    });
    const afterRepeat = (await notificationsFor(CS_ID)).filter((n) => n.commentId === comment.id);
    expect(afterRepeat).toHaveLength(1);
    expect(repeat.created).toBeLessThanOrEqual(1);
  });

  it("never parses mentions out of a PUBLIC reply", async () => {
    const { prisma } = mods();
    const comment = await prisma.comment.create({
      data: {
        ticketId: CS_TICKET_ID,
        authorId: OPS_ID,
        authorKind: "STAFF",
        visibility: "PUBLIC",
        disclaimerKey: "GENERAL_SERVICE",
        body: `Thank you — copying @${COMPL_EMAIL} on our side.`,
      },
      select: { id: true },
    });

    await notify({
      kind: "FOLLOWED_UPDATE",
      ticketId: CS_TICKET_ID,
      commentId: comment.id,
      preview: "Public reply added",
      actorId: OPS_ID,
    });

    const mentions = (await notificationsFor(COMPL_ID)).filter((n) => n.commentId === comment.id);
    expect(mentions).toEqual([]);
  });

  it("resolves mention candidates on the CALLER'S transaction, not a second connection", async () => {
    const { prisma, withTx, notifyFromEvent, writeAuditMany, actorFromViewer } = mods();

    // Someone reinstated earlier in the SAME request. The global client cannot see that write until
    // the transaction commits, so resolving candidates off `prisma` would silently drop the mention;
    // resolving them off `tx` — which is what the fix does — sees the row this transaction just wrote.
    const BACK_ID = `it_ntf_back_${RUN}`;
    const BACK_EMAIL = `ntf.back.${RUN}@wm-helpdesk.local`;
    await prisma.user.upsert({
      where: { id: BACK_ID },
      update: { isActive: false, groups: ["ops_team"], name: "Bea Back" },
      create: {
        id: BACK_ID,
        email: BACK_EMAIL,
        name: "Bea Back",
        groups: ["ops_team"],
        emailVerified: new Date(),
        isActive: false,
      },
    });

    const comment = await prisma.comment.create({
      data: {
        ticketId: TICKET_ID,
        authorId: OPS_ID,
        authorKind: "STAFF",
        visibility: "INTERNAL",
        body: `Back from leave — @${BACK_EMAIL} please pick up the residual credit.`,
      },
      select: { id: true },
    });

    await withTx(async (tx) => {
      await tx.user.update({ where: { id: BACK_ID }, data: { isActive: true } });
      const result = await notifyFromEvent(tx, {
        kind: "FOLLOWED_UPDATE",
        ticketId: TICKET_ID,
        commentId: comment.id,
        preview: "Internal note added",
        actorId: OPS_ID,
      });
      await writeAuditMany(tx, actorFromViewer(hoisted.viewer), hoisted.ctx, result.auditEntries);
    });

    const rows = (await notificationsFor(BACK_ID)).filter((n) => n.commentId === comment.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("MENTION");
    expect(rows[0].dedupeKey).toBe(`mention:${comment.id}`);

    const follower = await prisma.ticketFollower.findUniqueOrThrow({
      where: { ticketId_userId: { ticketId: TICKET_ID, userId: BACK_ID } },
      select: { source: true, removedAt: true },
    });
    expect(follower).toEqual({ source: "MENTION", removedAt: null });
  });

  it("does not notify a deactivated account", async () => {
    const { prisma } = mods();
    await prisma.ticketFollower.upsert({
      where: { ticketId_userId: { ticketId: CS_TICKET_ID, userId: GONE_ID } },
      update: { removedAt: null },
      create: { ticketId: CS_TICKET_ID, userId: GONE_ID, source: "MANUAL" },
    });

    const result = await notify({
      kind: "FOLLOWED_UPDATE",
      ticketId: CS_TICKET_ID,
      preview: "Status changed",
      actorId: OPS_ID,
    });
    expect(result.created).toBe(0);
    expect(await notificationsFor(GONE_ID)).toEqual([]);
  });

  it("swallows a bad event rather than taking the caller's write down with it", async () => {
    const result = await notify({
      kind: "FOLLOWED_UPDATE",
      ticketId: `missing_${RUN}`,
      preview: "nothing to see",
      actorId: OPS_ID,
    });
    expect(result).toEqual({ created: 0, auditEntries: [] });
  });

  it("followTicket audits both directions, soft-removes, and writes nothing for a no-op", async () => {
    const { followTicket, prisma } = mods();

    const on = await asUser(COMPL_ID, COMPL_EMAIL, ["compliance_officers"], () =>
      followTicket({ ticketId: CS_TICKET_ID, follow: true }),
    );
    expect(on).toEqual({ ok: true, data: { following: true } });

    const noop = await asUser(COMPL_ID, COMPL_EMAIL, ["compliance_officers"], () =>
      followTicket({ ticketId: CS_TICKET_ID, follow: true }),
    );
    expect(noop).toEqual({ ok: true, data: { following: true } });

    const off = await asUser(COMPL_ID, COMPL_EMAIL, ["compliance_officers"], () =>
      followTicket({ ticketId: CS_TICKET_ID, follow: false }),
    );
    expect(off).toEqual({ ok: true, data: { following: false } });

    const rows = (await auditRows()).filter(
      (r) => r.ticketId === CS_TICKET_ID && (r.action === "TICKET_FOLLOWED" || r.action === "TICKET_UNFOLLOWED"),
    );
    // Exactly two: the no-op in the middle wrote nothing.
    expect(rows.map((r) => r.action)).toEqual(["TICKET_FOLLOWED", "TICKET_UNFOLLOWED"]);
    expect(rows[0]).toMatchObject({ fieldChanged: "follower", oldValue: null, newValue: COMPL_EMAIL });
    expect(rows[1]).toMatchObject({ fieldChanged: "follower", oldValue: COMPL_EMAIL, newValue: null });

    // Soft removal: the row survives so the audited pair stays readable.
    const row = await prisma.ticketFollower.findUniqueOrThrow({
      where: { ticketId_userId: { ticketId: CS_TICKET_ID, userId: COMPL_ID } },
      select: { removedAt: true },
    });
    expect(row.removedAt).not.toBeNull();
  });

  it("followTicket refuses a queue the viewer cannot read, and records the denial", async () => {
    const { followTicket } = mods();
    const denied = await asGroups([], () => followTicket({ ticketId: TICKET_ID, follow: true }));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("FORBIDDEN");
    const denials = (await auditRows("AUTHZ_DENIED")).filter((r) => r.ticketId === TICKET_ID);
    expect(denials.length).toBeGreaterThanOrEqual(1);
  });

  it("markNotificationsRead touches only the caller's own rows and writes no audit row", async () => {
    const { markNotificationsRead, prisma } = mods();
    const csRows = await notificationsFor(CS_ID);
    const unreadCs = csRows.filter((n) => n.readAt === null);
    expect(unreadCs.length).toBeGreaterThan(0);

    const before = (await auditRows()).length;
    // The ops viewer asks for someone else's ids: zero rows match, and nothing leaks.
    const foreign = await markNotificationsRead({ ids: unreadCs.map((n) => n.id) });
    expect(foreign).toEqual({ ok: true, data: { read: 0 } });
    expect((await auditRows()).length).toBe(before);

    const mine = await asUser(CS_ID, CS_EMAIL, ["client_services"], () => markNotificationsRead({ all: true }));
    expect(mine.ok).toBe(true);
    if (mine.ok) expect(mine.data.read).toBeGreaterThanOrEqual(unreadCs.length);

    const stillUnread = await prisma.notification.count({
      where: { userId: CS_ID, ticketId: { in: [TICKET_ID, CS_TICKET_ID] }, readAt: null },
    });
    expect(stillUnread).toBe(0);
    expect((await auditRows()).length).toBe(before);
  });

  it("setNotificationPrefs writes ONE row with a summary and never the JSON", async () => {
    const { setNotificationPrefs, prisma, readNotificationPrefs } = mods();
    const before = (await auditRows("NOTIFICATION_PREFS_CHANGED")).length;

    const result = await setNotificationPrefs({
      prefs: {
        channels: { MENTION: { SLACK_DM: false, WEB_PUSH: false } },
        digest: false,
        muteWhileOutOfOffice: true,
      },
      outOfOfficeUntil: "2026-12-24T17:00:00.000Z",
      backupUserId: CS_ID,
    });
    expect(result.ok).toBe(true);

    const rows = await auditRows("NOTIFICATION_PREFS_CHANGED");
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    expect(row).toMatchObject({ entityType: "USER", entityId: OPS_ID, fieldChanged: "notificationPrefs" });
    expect(row.newValue).toContain("digest off");
    expect(row.newValue).not.toContain("{");
    expect(row.newValue).not.toContain("channels");
    expect(row.metadata).toMatchObject({ digest: false, outOfOfficeSet: true, backupSet: true });

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: OPS_ID },
      select: { notificationPrefs: true, backupUserId: true, outOfOfficeUntil: true },
    });
    expect(readNotificationPrefs(stored.notificationPrefs).digest).toBe(false);
    expect(stored.backupUserId).toBe(CS_ID);
    expect(stored.outOfOfficeUntil?.toISOString()).toBe("2026-12-24T17:00:00.000Z");
  });

  it("setNotificationPrefs refuses the caller as their own backup and refuses a deactivated one", async () => {
    const { setNotificationPrefs } = mods();
    const prefs = { channels: {}, digest: true, muteWhileOutOfOffice: true };

    const self = await setNotificationPrefs({ prefs, backupUserId: OPS_ID });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.code).toBe("VALIDATION");

    const gone = await setNotificationPrefs({ prefs, backupUserId: GONE_ID });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.code).toBe("VALIDATION");
  });

  it("listInbox pages by cursor and withholds subject, number and preview for a queue the viewer may not read", async () => {
    const { listInbox, unreadNotificationCount, prisma } = mods();

    // Three fresh, unread rows for compliance on the OPERATIONS ticket.
    for (let i = 0; i < 3; i += 1) {
      await prisma.notification.create({
        data: {
          userId: COMPL_ID,
          kind: "FOLLOWED_UPDATE",
          actorId: OPS_ID,
          ticketId: TICKET_ID,
          preview: `page fixture ${i}`,
          dedupeKey: `it-page-${RUN}-${i}`,
        },
      });
    }

    const complianceViewer: Viewer = {
      id: COMPL_ID,
      email: COMPL_EMAIL,
      name: "Cleo Compliance",
      image: null,
      groups: ["compliance_officers"],
      isDev: false,
    };
    const first = await listInbox(complianceViewer, { unreadOnly: true, limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.unread).toBe(await unreadNotificationCount(COMPL_ID));
    // Newest first, and the cursor continues rather than repeating.
    const second = await listInbox(complianceViewer, { unreadOnly: true, limit: 2, cursor: first.nextCursor });
    const overlap = second.rows.filter((r) => first.rows.some((f) => f.id === r.id));
    expect(overlap).toEqual([]);
    // Compliance reads every queue, so the subject and the number are both present.
    expect(first.rows[0].ticketSubject).toContain("Notification fixture");
    expect(first.rows[0].ticketNumber).not.toBeNull();

    // A row about the ADVICE queue, addressed to someone in client_services — the one group that
    // cannot read it. The row is STILL returned (hiding it would make the unread badge disagree
    // with the list) and the subject, the number AND the preview are withheld: the number IS the
    // deep link, and a preview can be a window on an internal note rather than a subject line.
    await prisma.notification.create({
      data: {
        userId: CS_ID,
        kind: "REVIEW_REQUESTED",
        actorId: OPS_ID,
        ticketId: ADVICE_TICKET_ID,
        preview: "…confirm the client wants the full balance wired before the cutoff…",
        dedupeKey: `it-advice-${RUN}`,
      },
    });
    const csViewer: Viewer = {
      id: CS_ID,
      email: CS_EMAIL,
      name: "Cara Service",
      image: null,
      groups: ["client_services"],
      isDev: false,
    };
    const csPage = await listInbox(csViewer, { unreadOnly: true, limit: 25 });
    const withheld = csPage.rows.find((r) => r.ticketId === ADVICE_TICKET_ID);
    expect(withheld).toBeDefined();
    expect(withheld?.ticketSubject).toBeNull();
    expect(withheld?.ticketNumber).toBeNull();
    // The stored text does not reach the DTO; the kind label stands in for it.
    expect(withheld?.preview).toBe(NOTIFICATION_KIND_LABELS.REVIEW_REQUESTED);
    expect(withheld?.preview).not.toContain("cutoff");
    // …and the row the same viewer CAN read still carries its real preview.
    const readable = csPage.rows.find((r) => r.ticketId === CS_TICKET_ID);
    if (readable !== undefined) expect(readable.ticketSubject).not.toBeNull();
  });

  it("dispatchPending runs its real query, sends nothing, and leaves every row exactly as it found it", async () => {
    const { dispatchPending, prisma } = mods();

    const before = await prisma.notification.findMany({
      where: { ticketId: { in: [TICKET_ID, CS_TICKET_ID, ADVICE_TICKET_ID] } },
      orderBy: { id: "asc" },
      select: { id: true, channels: true },
    });

    // The real Prisma predicate — including the `NOT { channels hasSome }` that is how the job
    // knows what is still pending — executed against a real database.
    const outcome = await dispatchPending(50);
    expect(outcome.slack).toBe(0);
    expect(outcome.push).toBe(0);
    // Nothing is configured anywhere on this branch, so every candidate row is skipped.
    expect(outcome.skipped).toBe(outcome.inApp);

    const after = await prisma.notification.findMany({
      where: { id: { in: before.map((n) => n.id) } },
      orderBy: { id: "asc" },
      select: { id: true, channels: true },
    });
    expect(after).toEqual(before);

    // Idempotent: a second pass over the same window reaches the same verdict.
    const again = await dispatchPending(50);
    expect(again.slack + again.push).toBe(0);
  });

  it("listTicketFollowers returns only live followers, and isFollowing agrees with it", async () => {
    const { listTicketFollowers, isFollowing } = mods();
    const followers = await listTicketFollowers(TICKET_ID);
    const ids = followers.map((f) => f.user.id);
    expect(ids).toContain(OPS_ID);
    expect(ids).toContain(CS_ID);
    for (const f of followers) expect(await isFollowing(TICKET_ID, f.user.id)).toBe(true);

    const removed = await listTicketFollowers(CS_TICKET_ID);
    expect(removed.map((f) => f.user.id)).not.toContain(COMPL_ID);
    expect(await isFollowing(CS_TICKET_ID, COMPL_ID)).toBe(false);
  });
});
