/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB,
 * the immutability triggers make every row written here permanent).
 *
 * Proves the three Wave B automation jobs against a real database and real transactions:
 *  - out-of-office hands an absent person's OPEN tickets to their backup, unassigns when there is no
 *    usable one, leaves RESOLVED work alone, and is idempotent;
 *  - auto-close closes a RESOLVED ticket past the window, refuses one with an outstanding follow-up,
 *    and stamps `closedAt` with a `TICKET_STATUS_CHANGED` row carrying `reason: "auto-close"`;
 *  - follow-up nudges write exactly one `FollowUpNudge` per (ticket, firm-local date), so a second
 *    run of the same day nudges nobody twice.
 *
 * WHY IT DRIVES THE PIECES RATHER THAN `runJob`. These jobs are deliberately unscoped — the whole
 * point of `runAutoClose` is that it closes EVERY qualifying ticket — and the test database is shared
 * and permanent. Running the top-level job here would close other files' fixtures and reassign other
 * files' users, which is not a test failure but is a real mess. So the queries are called and then
 * filtered to this run's ids, and the transactional writes (`applyMove`, `closeOne`, `recordNudge`)
 * are invoked on this run's rows only. Every assertion is about rows this run created.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditActor, RequestContext } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const auditModule = TEST_URL ? await import("@/lib/audit") : null;
const oooModule = TEST_URL ? await import("@/jobs/out-of-office") : null;
const closeModule = TEST_URL ? await import("@/jobs/auto-close") : null;
const nudgeModule = TEST_URL ? await import("@/jobs/follow-up-nudges") : null;
const loggerModule = TEST_URL ? await import("@/jobs/logger") : null;

function mods() {
  if (!dbModule || !auditModule || !oooModule || !closeModule || !nudgeModule || !loggerModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...auditModule, ...oooModule, ...closeModule, ...nudgeModule, ...loggerModule };
}

const RUN = randomUUID().slice(0, 8);
const REQUEST_ID = `it-automation-${RUN}`;
const DAY = 24 * 60 * 60_000;

const AWAY = `it_auto_away_${RUN}`;
const BACKUP = `it_auto_backup_${RUN}`;
const AWAY_NO_BACKUP = `it_auto_lonely_${RUN}`;

const T_TO_BACKUP = `it_auto_t_backup_${RUN}`;
const T_TO_QUEUE = `it_auto_t_queue_${RUN}`;
const T_RESOLVED_HELD = `it_auto_t_resolved_${RUN}`;
const T_CLOSE_ME = `it_auto_t_close_${RUN}`;
const T_CLOSE_RECENT = `it_auto_t_recent_${RUN}`;
const T_CLOSE_FOLLOWUP = `it_auto_t_followup_${RUN}`;
const T_CLOSE_TWICE = `it_auto_t_twice_${RUN}`;
const T_OOO_TWICE = `it_auto_t_ooo_twice_${RUN}`;
const T_NUDGE = `it_auto_t_nudge_${RUN}`;
const T_NUDGE_FUTURE = `it_auto_t_future_${RUN}`;

const MY_TICKETS = [
  T_TO_BACKUP,
  T_TO_QUEUE,
  T_RESOLVED_HELD,
  T_CLOSE_ME,
  T_CLOSE_RECENT,
  T_CLOSE_FOLLOWUP,
  T_CLOSE_TWICE,
  T_OOO_TWICE,
  T_NUDGE,
  T_NUDGE_FUTURE,
];

const NOW = new Date();
const AUTO_CLOSE_DAYS = 14;

describe.skipIf(!TEST_URL)("Wave B automation jobs (DB-gated)", () => {
  let job: {
    name: "out-of-office";
    actor: AuditActor;
    ctx: RequestContext;
    now: Date;
    log: ReturnType<NonNullable<typeof loggerModule>["createJobLogger"]>;
  };

  beforeAll(async () => {
    const { prisma, actorFromMachineUser, createJobLogger } = mods();

    const queue = await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "automation fixture", sortOrder: 1 },
    });

    const person = (id: string, over: Record<string, unknown> = {}) => ({
      where: { id },
      update: { isActive: true, ...over },
      create: { id, email: `${id}@wm-helpdesk.local`, name: id, groups: ["ops_team" as const], isActive: true, ...over },
    });
    await prisma.user.upsert(person(BACKUP));
    await prisma.user.upsert(person(AWAY, { outOfOfficeUntil: new Date(NOW.getTime() + 3 * DAY), backupUserId: BACKUP }));
    await prisma.user.upsert(person(AWAY_NO_BACKUP, { outOfOfficeUntil: new Date(NOW.getTime() + 3 * DAY) }));

    const ticket = (id: string, over: Record<string, unknown>) => ({
      where: { id },
      update: {},
      create: {
        id,
        subject: `automation fixture ${RUN}`,
        description: "automation integration fixture (no PII)",
        requesterName: "Fixture Requester",
        requesterEmail: `auto.${RUN}@example.test`,
        category: "OTHER" as const,
        priority: "STANDARD" as const,
        queueId: queue.id,
        createdById: BACKUP,
        slaFirstResponseMinutes: 240,
        slaResolutionMinutes: 1440,
        firstResponseDueAt: new Date(NOW.getTime() + 4 * 3_600_000),
        resolutionDueAt: new Date(NOW.getTime() + 24 * 3_600_000),
        ...over,
      },
    });

    await prisma.ticket.upsert(ticket(T_TO_BACKUP, { status: "OPEN", assigneeId: AWAY }));
    await prisma.ticket.upsert(ticket(T_TO_QUEUE, { status: "OPEN", assigneeId: AWAY_NO_BACKUP }));
    // RESOLVED work stays with the person who did it, absent or not.
    await prisma.ticket.upsert(
      ticket(T_RESOLVED_HELD, { status: "RESOLVED", assigneeId: AWAY, resolvedAt: new Date(NOW.getTime() - DAY) }),
    );
    await prisma.ticket.upsert(
      ticket(T_CLOSE_ME, { status: "RESOLVED", resolvedAt: new Date(NOW.getTime() - 30 * DAY) }),
    );
    await prisma.ticket.upsert(
      ticket(T_CLOSE_RECENT, { status: "RESOLVED", resolvedAt: new Date(NOW.getTime() - 2 * DAY) }),
    );
    await prisma.ticket.upsert(
      ticket(T_CLOSE_FOLLOWUP, {
        status: "RESOLVED",
        resolvedAt: new Date(NOW.getTime() - 30 * DAY),
        followUpAt: new Date(NOW.getTime() + 5 * DAY),
      }),
    );
    // Closed once, reopened by the requester, resolved and closed again — the assignee is the
    // follower who must hear about BOTH closes.
    await prisma.ticket.upsert(
      ticket(T_CLOSE_TWICE, {
        status: "RESOLVED",
        assigneeId: BACKUP,
        resolvedAt: new Date(NOW.getTime() - 30 * DAY),
      }),
    );
    // Handed to the same backup during two separate absences.
    await prisma.ticket.upsert(ticket(T_OOO_TWICE, { status: "OPEN", assigneeId: AWAY }));
    await prisma.ticket.upsert(ticket(T_NUDGE, { status: "OPEN", followUpAt: new Date(NOW.getTime() - 2 * DAY) }));
    await prisma.ticket.upsert(
      ticket(T_NUDGE_FUTURE, { status: "OPEN", followUpAt: new Date(NOW.getTime() + 5 * DAY) }),
    );

    job = {
      name: "out-of-office",
      actor: actorFromMachineUser({ id: BACKUP, email: `${BACKUP}@wm-helpdesk.local` }),
      ctx: { ipAddress: "unknown", userAgent: `it-automation/${RUN}`, requestId: REQUEST_ID, isPrefetch: false },
      now: NOW,
      log: createJobLogger("out-of-office", REQUEST_ID, () => undefined),
    };
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // out-of-office
  // -------------------------------------------------------------------------

  it("finds the people who are out RIGHT NOW, not the ones whose absence has ended", async () => {
    const { findAbsentUsers } = mods();
    const absent = await findAbsentUsers(NOW);
    const ids = absent.map((a) => a.id);
    expect(ids).toContain(AWAY);
    expect(ids).toContain(AWAY_NO_BACKUP);
    // Somebody whose return date has passed keeps their tickets.
    const returned = await findAbsentUsers(new Date(NOW.getTime() + 10 * DAY));
    expect(returned.map((a) => a.id)).not.toContain(AWAY);
  });

  it("plans a hand-off to the named backup and a return to the queue when there is none", async () => {
    const { findAbsentUsers, planMoves } = mods();
    const absent = (await findAbsentUsers(NOW)).filter((a) => a.id === AWAY || a.id === AWAY_NO_BACKUP);
    const moves = (await planMoves(NOW, absent)).filter((m) => MY_TICKETS.includes(m.ticketId));

    const toBackup = moves.find((m) => m.ticketId === T_TO_BACKUP);
    expect(toBackup?.toUserId).toBe(BACKUP);
    expect(toBackup?.reason).toBe("backup");

    const toQueue = moves.find((m) => m.ticketId === T_TO_QUEUE);
    expect(toQueue?.toUserId).toBeNull();
    expect(toQueue?.reason).toBe("unassigned");

    // The RESOLVED ticket is the historical record of who worked it and is never moved.
    expect(moves.map((m) => m.ticketId)).not.toContain(T_RESOLVED_HELD);
  });

  it("applies a move in one transaction: assignee, version bump and one audit row", async () => {
    const { prisma, findAbsentUsers, planMoves, applyMove } = mods();
    const before = await prisma.ticket.findUniqueOrThrow({
      where: { id: T_TO_BACKUP },
      select: { version: true },
    });

    const absent = (await findAbsentUsers(NOW)).filter((a) => a.id === AWAY);
    const move = (await planMoves(NOW, absent)).find((m) => m.ticketId === T_TO_BACKUP);
    expect(move).toBeDefined();
    expect(await applyMove(job, move!)).toBe(true);

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: T_TO_BACKUP },
      select: { assigneeId: true, version: true },
    });
    expect(after.assigneeId).toBe(BACKUP);
    expect(after.version).toBe(before.version + 1);

    const rows = await prisma.auditLog.findMany({
      where: { ticketId: T_TO_BACKUP, action: "TICKET_ASSIGNED" },
      select: { oldValue: true, newValue: true, metadata: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].oldValue).toBe(AWAY);
    expect(rows[0].newValue).toBe(BACKUP);
    const meta = rows[0].metadata as { reason?: string; via?: string; disposition?: string } | null;
    expect(meta?.reason).toBe("out-of-office");
    expect(meta?.disposition).toBe("backup");
    expect(meta?.via).toBe("job");
  });

  it("is idempotent: the ticket no longer matches, so a second run moves nothing", async () => {
    const { findAbsentUsers, planMoves } = mods();
    const absent = (await findAbsentUsers(NOW)).filter((a) => a.id === AWAY);
    const moves = await planMoves(NOW, absent);
    expect(moves.map((m) => m.ticketId)).not.toContain(T_TO_BACKUP);
  });

  it("notifies the backup again on a second absence, rather than dedupeing the hand-off away forever", async () => {
    const { prisma, applyMove } = mods();
    const move = {
      ticketId: T_OOO_TWICE,
      ticketNumber: 0,
      queueKey: "OPERATIONS" as const,
      fromUserId: AWAY,
      fromEmail: `${AWAY}@wm-helpdesk.local`,
      toUserId: BACKUP,
      reason: "backup" as const,
    };
    expect(await applyMove(job, move)).toBe(true);

    // The colleague comes back, takes the ticket again, and goes away again weeks later. The
    // hand-off that follows is a second event and the person covering has to be told about it —
    // `Notification` rows are permanent and unique on (userId, dedupeKey), so a key without an
    // occurrence in it would silently swallow this one.
    await prisma.ticket.update({ where: { id: T_OOO_TWICE }, data: { assigneeId: AWAY } });
    const later = new Date(NOW.getTime() + 21 * DAY);
    expect(await applyMove({ ...job, now: later }, move)).toBe(true);

    const rows = await prisma.notification.findMany({
      where: { ticketId: T_OOO_TWICE, userId: BACKUP, kind: "ASSIGNED" },
      select: { dedupeKey: true },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(2);
    expect(rows.every((r) => r.dedupeKey?.startsWith(`ooo:${T_OOO_TWICE}:${BACKUP}:`))).toBe(true);
  });

  it("unassigns rather than inventing a recipient when there is no usable backup", async () => {
    const { prisma, findAbsentUsers, planMoves, applyMove } = mods();
    const absent = (await findAbsentUsers(NOW)).filter((a) => a.id === AWAY_NO_BACKUP);
    const move = (await planMoves(NOW, absent)).find((m) => m.ticketId === T_TO_QUEUE);
    expect(await applyMove(job, move!)).toBe(true);

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: T_TO_QUEUE },
      select: { assigneeId: true },
    });
    expect(after.assigneeId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // auto-close
  // -------------------------------------------------------------------------

  it("selects only RESOLVED tickets past the window with no outstanding follow-up", async () => {
    const { findAutoCloseCandidates } = mods();
    const ids = (await findAutoCloseCandidates(NOW, AUTO_CLOSE_DAYS))
      .map((c) => c.id)
      .filter((id) => MY_TICKETS.includes(id));

    expect(ids).toContain(T_CLOSE_ME);
    // Resolved two days ago: nowhere near the window.
    expect(ids).not.toContain(T_CLOSE_RECENT);
    // Somebody wrote down a date they intend to come back to this.
    expect(ids).not.toContain(T_CLOSE_FOLLOWUP);
    // Still open.
    expect(ids).not.toContain(T_NUDGE);
  });

  it("closes one ticket with closedAt and an audit row that says the clock did it", async () => {
    const { prisma, findAutoCloseCandidates, closeOne } = mods();
    const candidate = (await findAutoCloseCandidates(NOW, AUTO_CLOSE_DAYS)).find((c) => c.id === T_CLOSE_ME);
    expect(candidate?.daysResolved).toBeGreaterThanOrEqual(AUTO_CLOSE_DAYS);
    expect(await closeOne(job, candidate!, AUTO_CLOSE_DAYS)).toBe(true);

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: T_CLOSE_ME },
      select: { status: true, closedAt: true },
    });
    expect(after.status).toBe("CLOSED");
    expect(after.closedAt).not.toBeNull();

    const status = await prisma.auditLog.findMany({
      where: { ticketId: T_CLOSE_ME, action: "TICKET_STATUS_CHANGED" },
      select: { oldValue: true, newValue: true, metadata: true },
    });
    expect(status).toHaveLength(1);
    expect(status[0].oldValue).toBe("RESOLVED");
    expect(status[0].newValue).toBe("CLOSED");
    const meta = status[0].metadata as { reason?: string; autoCloseDays?: number; via?: string } | null;
    expect(meta?.reason).toBe("auto-close");
    expect(meta?.autoCloseDays).toBe(AUTO_CLOSE_DAYS);
    expect(meta?.via).toBe("job");

    const stamped = await prisma.auditLog.count({
      where: { ticketId: T_CLOSE_ME, action: "TICKET_FIELD_CHANGED", fieldChanged: "closedAt" },
    });
    expect(stamped).toBe(1);
  });

  it("loses the race quietly when the ticket is no longer RESOLVED", async () => {
    const { findAutoCloseCandidates, closeOne } = mods();
    // T_CLOSE_ME is CLOSED by the previous test; re-closing it must be a no-op, not an error.
    const stale = {
      id: T_CLOSE_ME,
      number: 0,
      queueKey: "OPERATIONS" as const,
      resolvedAt: new Date(NOW.getTime() - 30 * DAY),
      daysResolved: 30,
    };
    expect(await closeOne(job, stale, AUTO_CLOSE_DAYS)).toBe(false);
    expect((await findAutoCloseCandidates(NOW, AUTO_CLOSE_DAYS)).map((c) => c.id)).not.toContain(T_CLOSE_ME);
  });

  it("notifies followers again when a reopened ticket is auto-closed a second time", async () => {
    const { prisma, closeOne } = mods();
    const candidate = {
      id: T_CLOSE_TWICE,
      number: 0,
      queueKey: "OPERATIONS" as const,
      resolvedAt: new Date(NOW.getTime() - 30 * DAY),
      daysResolved: 30,
    };
    expect(await closeOne(job, candidate, AUTO_CLOSE_DAYS)).toBe(true);

    // The requester replies (RESOLVED → OPEN clears `resolvedAt`), the desk answers again, and the
    // clock comes round a second time. The second close is a second event: dedupe keys are permanent
    // here, so one without the occurrence in it would tell nobody.
    await prisma.ticket.update({
      where: { id: T_CLOSE_TWICE },
      data: { status: "RESOLVED", closedAt: null },
    });
    const later = new Date(NOW.getTime() + 21 * DAY);
    expect(await closeOne({ ...job, now: later }, candidate, AUTO_CLOSE_DAYS)).toBe(true);

    const rows = await prisma.notification.findMany({
      where: { ticketId: T_CLOSE_TWICE, userId: BACKUP, kind: "FOLLOWED_UPDATE" },
      select: { dedupeKey: true },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(2);
    expect(rows.every((r) => r.dedupeKey?.startsWith(`auto-close:${T_CLOSE_TWICE}:`))).toBe(true);
  });

  it("exits 0 and does nothing at all while AUTO_CLOSE_DAYS is unset", async () => {
    const { runAutoClose, prisma } = mods();
    // `env.AUTO_CLOSE_DAYS` is undefined in this process (no key is set anywhere in Wave B), so the
    // top-level job is safe to run here: it must not touch the shared table.
    const before = await prisma.ticket.count({ where: { status: "RESOLVED" } });
    const outcome = await runAutoClose({ ...job, name: "auto-close" });
    expect(outcome.processed).toBe(0);
    expect(outcome.metadata?.disabled).toBe(true);
    expect(await prisma.ticket.count({ where: { status: "RESOLVED" } })).toBe(before);
  });

  // -------------------------------------------------------------------------
  // follow-up nudges
  // -------------------------------------------------------------------------

  it("finds a follow-up whose date has passed and ignores one still in the future", async () => {
    const { findDueFollowUps } = mods();
    const due = (await findDueFollowUps(NOW)).filter((c) => MY_TICKETS.includes(c.id));
    expect(due.map((c) => c.id)).toContain(T_NUDGE);
    expect(due.map((c) => c.id)).not.toContain(T_NUDGE_FUTURE);
    const mine = due.find((c) => c.id === T_NUDGE);
    expect(mine?.daysOverdue).toBeGreaterThanOrEqual(1);
    expect(mine?.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("nudges once per firm-local due date, however many times the job runs", async () => {
    const { prisma, findDueFollowUps, recordNudge } = mods();
    const candidate = (await findDueFollowUps(NOW)).find((c) => c.id === T_NUDGE);
    expect(candidate).toBeDefined();

    expect(await recordNudge(job, candidate!)).toBe(true);
    // The second call is the whole point: the unique constraint is the dedupe.
    expect(await recordNudge(job, candidate!)).toBe(false);
    expect(await recordNudge(job, candidate!)).toBe(false);

    const rows = await prisma.followUpNudge.findMany({ where: { ticketId: T_NUDGE } });
    expect(rows).toHaveLength(1);
    expect(rows[0].dueOn).toBe(candidate!.dueOn);
  });

  it("nudges again when the commitment is moved to a different date", async () => {
    const { prisma, recordNudge, findDueFollowUps } = mods();
    const moved = new Date(NOW.getTime() - 1 * DAY);
    await prisma.ticket.update({ where: { id: T_NUDGE }, data: { followUpAt: moved } });
    const candidate = (await findDueFollowUps(NOW)).find((c) => c.id === T_NUDGE);
    expect(candidate).toBeDefined();

    const firstDueOn = (await prisma.followUpNudge.findMany({ where: { ticketId: T_NUDGE } }))[0].dueOn;
    if (candidate!.dueOn === firstDueOn) {
      // The move landed on the same firm day; the dedupe correctly still holds.
      expect(await recordNudge(job, candidate!)).toBe(false);
      return;
    }
    expect(await recordNudge(job, candidate!)).toBe(true);
    const rows = await prisma.followUpNudge.findMany({ where: { ticketId: T_NUDGE } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dueOn)).size).toBe(2);
  });
});
