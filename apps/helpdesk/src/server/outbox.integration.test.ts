/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB, the
 * immutability triggers and the no-delete triggers make fixture rows permanent).
 *
 * Proves live what only a real transaction can prove:
 *   - a public reply writes its `MessageDelivery` row and its `MESSAGE_QUEUED` audit row in the SAME
 *     transaction as the comment, and a reply that cannot be delivered (no address) still records;
 *   - a lease is exclusive: a second poll inside the lease window returns nothing, an expired lease is
 *     reclaimed, and `attempts` counts leases so a message that kills the sender cannot loop forever;
 *   - FAILED below the cap returns the row to QUEUED, at the cap it stays FAILED and is never handed out
 *     again, a lease that expires on the FINAL attempt is retired to FAILED by the next sweep rather
 *     than left LEASED forever (nothing else in the app would ever move it, and the comment chip would
 *     read "Sending" for a reply that can never be delivered),
 *     SENT is terminal, a replayed terminal outcome writes no second ledger row and a
 *     contradicting one is refused, and an outcome reported against a row no poller holds is refused so
 *     the ledger never records a send that had no lease behind it;
 *   - "save reply and set Pending client" moves the status in the same transaction, under the version
 *     token, and a stale token is a CONFLICT with nothing written.
 *
 * `@/lib/session` and `@/lib/request-context` are mocked so the actions run with a fixed viewer/context
 * against the real test database, exactly as `comments-race.integration.test.ts` does.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AuditActor, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const USER_ID = `it_outbox_user_${RUN}`;
const MAIL_TICKET = `it_outbox_mail_${RUN}`;
const PHONE_TICKET = `it_outbox_phone_${RUN}`;
const PENDING_TICKET = `it_outbox_pending_${RUN}`;
const CONFLICT_TICKET = `it_outbox_conflict_${RUN}`;

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
}));
hoisted.viewer = {
  id: USER_ID,
  email: `outbox.ops.${RUN}@wm-helpdesk.local`,
  name: "Outbox Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.21",
  userAgent: `it-outbox/${RUN}`,
  requestId: `it-outbox-${RUN}`,
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
const actionsModule = TEST_URL ? await import("@/server/comments.actions") : null;
const outboxModule = TEST_URL ? await import("@/server/outbox") : null;
const errorsModule = TEST_URL ? await import("@/lib/errors") : null;

function mods() {
  if (!dbModule || !actionsModule || !outboxModule || !errorsModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...actionsModule, ...outboxModule, ...errorsModule };
}

const ACTOR: AuditActor = { id: USER_ID, email: hoisted.viewer.email, groups: [] };

type Prisma = typeof import("@/lib/db").prisma;

async function seedTicket(
  prisma: Prisma,
  id: string,
  queueId: string,
  contact: { requesterEmail: string | null; requesterPhone: string | null },
): Promise<void> {
  const createdAt = new Date("2026-09-17T12:00:00.000Z");
  await prisma.ticket.upsert({
    where: { id },
    update: {},
    create: {
      id,
      subject: "Outbox probe",
      description: "Outbox probe description",
      requesterName: "Outbox Requester",
      requesterEmail: contact.requesterEmail,
      requesterPhone: contact.requesterPhone,
      category: "TRADE_CORRECTION",
      priority: "URGENT",
      status: "OPEN",
      brand: "CEDAR_RIDGE_WEALTH",
      queue: { connect: { id: queueId } },
      createdBy: { connect: { id: USER_ID } },
      slaFirstResponseMinutes: 30,
      slaResolutionMinutes: 120,
      firstResponseDueAt: new Date(createdAt.getTime() + 30 * 60_000),
      resolutionDueAt: new Date(createdAt.getTime() + 120 * 60_000),
    },
  });
}

function replyInput(ticketId: string) {
  return {
    ticketId,
    body: `Outbox probe reply ${RUN}`,
    disclaimerKey: "GENERAL_SERVICE" as const,
    disclaimerAcknowledged: true as const,
  };
}

/**
 * Backdates a delivery so the FIFO lease query reaches it first.
 *
 * `wm_helpdesk_test` is permanent and shared: every earlier run of THIS file left its own backdated
 * rows behind, and two of them (the exclusive-lease row and the reclaim row) stay leasable forever
 * once their five-minute lease expires. Fixed literal timestamps therefore tie with the previous
 * run's rows and the winner is decided by a random cuid — which is why this file failed
 * intermittently and then permanently. The base is instead computed at `beforeAll` as "older than
 * anything currently in the table", so each run's rows are strictly the head of the FIFO and the
 * four offsets keep the same relative order the literals used to give.
 */
const BACKDATE_MARGIN_MS = 30 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
let backdateBase = 0;

async function computeBackdateBase(prisma: Prisma): Promise<number> {
  const oldest = await prisma.messageDelivery.aggregate({ _min: { createdAt: true } });
  return (oldest._min.createdAt?.getTime() ?? Date.now()) - BACKDATE_MARGIN_MS;
}

async function backdate(prisma: Prisma, deliveryId: string, offsetDays: number): Promise<void> {
  await prisma.messageDelivery.update({
    where: { id: deliveryId },
    data: { createdAt: new Date(backdateBase + offsetDays * DAY_MS) },
  });
}

async function auditRows(prisma: Prisma, ticketId: string, action: string) {
  return prisma.auditLog.findMany({
    where: { ticketId, action: action as never },
    orderBy: { seq: "asc" },
    select: { action: true, entityType: true, entityId: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true },
  });
}

describe.skipIf(!TEST_URL)("outbox delivery lifecycle (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    backdateBase = await computeBackdateBase(prisma);
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "outbox fixture", sortOrder: 1 },
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, email: hoisted.viewer.email, name: "Outbox Ops", groups: ["ops_team"], isActive: true },
    });
    await seedTicket(prisma, MAIL_TICKET, queue.id, {
      requesterEmail: `outbox.${RUN}@example.com`,
      requesterPhone: null,
    });
    await seedTicket(prisma, PHONE_TICKET, queue.id, { requesterEmail: null, requesterPhone: "+15125550142" });
    await seedTicket(prisma, PENDING_TICKET, queue.id, {
      requesterEmail: `pending.${RUN}@example.com`,
      requesterPhone: null,
    });
    await seedTicket(prisma, CONFLICT_TICKET, queue.id, {
      requesterEmail: `conflict.${RUN}@example.com`,
      requesterPhone: null,
    });
  });

  it("enqueues the delivery and its MESSAGE_QUEUED row in the same transaction as the comment", async () => {
    const { addPublicReply, prisma } = mods();
    const res = await addPublicReply(replyInput(MAIL_TICKET));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.deliveryQueued).toBe(true);
    expect(res.data.deliveryId).not.toBeNull();

    const delivery = await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: res.data.id } });
    expect(delivery.id).toBe(res.data.deliveryId);
    expect(delivery.status).toBe("QUEUED");
    expect(delivery.attempts).toBe(0);
    expect(delivery.toAddress).toBe(`outbox.${RUN}@example.com`);
    expect(delivery.brand).toBe("CEDAR_RIDGE_WEALTH");
    expect(delivery.subject).toContain("[HD-");
    expect(delivery.textBody).toContain("Outbox probe reply");
    expect(delivery.messageId).toContain(delivery.id);
    expect(delivery.sentAt).toBeNull();
    expect(delivery.providerMessageId).toBeNull();

    const queued = await auditRows(prisma, MAIL_TICKET, "MESSAGE_QUEUED");
    expect(queued).toHaveLength(1);
    expect(queued[0].entityType).toBe("MESSAGE_DELIVERY");
    expect(queued[0].entityId).toBe(delivery.id);
    expect(queued[0].oldValue).toBeNull();
    expect(queued[0].newValue).toBe("QUEUED");
    expect(queued[0].metadata).toMatchObject({ brand: "CEDAR_RIDGE_WEALTH", to: delivery.toAddress });
  });

  it("records a reply on a phone-only ticket but queues nothing — there is no address to deliver to", async () => {
    const { addPublicReply, prisma } = mods();
    const res = await addPublicReply(replyInput(PHONE_TICKET));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.deliveryQueued).toBe(false);
    expect(res.data.deliveryId).toBeNull();

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: res.data.id } });
    expect(comment.visibility).toBe("PUBLIC");
    expect(await prisma.messageDelivery.findUnique({ where: { commentId: res.data.id } })).toBeNull();
    expect(await auditRows(prisma, PHONE_TICKET, "MESSAGE_QUEUED")).toHaveLength(0);
  });

  it("leases exclusively, counts the attempt, and refuses to hand the same row out twice", async () => {
    const { addPublicReply, leaseQueuedDeliveries, prisma } = mods();
    const res = await addPublicReply(replyInput(MAIL_TICKET));
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.deliveryId === null) return;
    const id = res.data.deliveryId;
    await backdate(prisma, id, 0);

    const first = await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);
    expect(first.map((d) => d.id)).toContain(id);
    const leased = first.find((d) => d.id === id);
    expect(leased?.attempts).toBe(1);
    expect(leased?.to).toBe(`outbox.${RUN}@example.com`);
    expect(leased?.messageId).toContain(id);
    expect(new Date(leased?.leaseExpiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());

    const row = await prisma.messageDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("LEASED");
    expect(row.attempts).toBe(1);

    // A second poll inside the lease window must not see it: two senders never hold the same message.
    const second = await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);
    expect(second.map((d) => d.id)).not.toContain(id);

    const leases = (await auditRows(prisma, MAIL_TICKET, "MESSAGE_LEASED")).filter((r) => r.entityId === id);
    expect(leases).toHaveLength(1);
    expect(leases[0].oldValue).toBe("QUEUED");
    expect(leases[0].newValue).toBe("LEASED");
    expect(leases[0].metadata).toMatchObject({ reclaimed: false, attempts: 1 });
  });

  it("reclaims an expired lease and says so in the ledger", async () => {
    const { addPublicReply, leaseQueuedDeliveries, prisma } = mods();
    const res = await addPublicReply(replyInput(MAIL_TICKET));
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.deliveryId === null) return;
    const id = res.data.deliveryId;
    await backdate(prisma, id, 1);

    await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);
    // The poller died: expire the lease by hand rather than waiting five minutes.
    await prisma.messageDelivery.update({
      where: { id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    const reclaimed = await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);
    expect(reclaimed.map((d) => d.id)).toContain(id);
    expect(reclaimed.find((d) => d.id === id)?.attempts).toBe(2);

    const leases = (await auditRows(prisma, MAIL_TICKET, "MESSAGE_LEASED")).filter((r) => r.entityId === id);
    expect(leases).toHaveLength(2);
    expect(leases[1].oldValue).toBe("LEASED");
    expect(leases[1].metadata).toMatchObject({ reclaimed: true, attempts: 2 });
  });

  it("marks SENT terminally, replays idempotently and refuses a contradiction", async () => {
    const { addPublicReply, leaseQueuedDeliveries, reportDeliveryOutcome, ConflictError, prisma } = mods();
    const res = await addPublicReply(replyInput(MAIL_TICKET));
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.deliveryId === null) return;
    const id = res.data.deliveryId;
    await backdate(prisma, id, 2);
    await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);

    const sent = await reportDeliveryOutcome(ACTOR, hoisted.ctx, {
      deliveryId: id,
      outcome: "SENT",
      providerMessageId: "prov-abc-123",
    });
    expect(sent.status).toBe("SENT");

    const row = await prisma.messageDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("SENT");
    expect(row.sentAt).not.toBeNull();
    expect(row.providerMessageId).toBe("prov-abc-123");
    expect(row.lastError).toBeNull();

    const before = (await auditRows(prisma, MAIL_TICKET, "MESSAGE_SENT")).filter((r) => r.entityId === id);
    expect(before).toHaveLength(1);
    expect(before[0].newValue).toBe("SENT");

    // Replay: same answer, no second ledger row.
    const replay = await reportDeliveryOutcome(ACTOR, hoisted.ctx, { deliveryId: id, outcome: "SENT" });
    expect(replay.status).toBe("SENT");
    const after = (await auditRows(prisma, MAIL_TICKET, "MESSAGE_SENT")).filter((r) => r.entityId === id);
    expect(after).toHaveLength(1);

    // Contradiction: refused, state untouched.
    await expect(
      reportDeliveryOutcome(ACTOR, hoisted.ctx, { deliveryId: id, outcome: "FAILED", error: "too late" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { id } })).status).toBe("SENT");

    // A delivery that was never written is a 404, not a silent success.
    const { NotFoundError } = mods();
    await expect(
      reportDeliveryOutcome(ACTOR, hoisted.ctx, { deliveryId: `dlv_missing_${RUN}`, outcome: "SENT" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses an outcome for a delivery no poller ever leased, and writes no ledger row", async () => {
    const { addPublicReply, reportDeliveryOutcome, ConflictError, prisma } = mods();
    const res = await addPublicReply(replyInput(MAIL_TICKET));
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.deliveryId === null) return;
    const id = res.data.deliveryId;

    const sentBefore = (await auditRows(prisma, MAIL_TICKET, "MESSAGE_SENT")).length;
    const failedBefore = (await auditRows(prisma, MAIL_TICKET, "MESSAGE_FAILED")).length;

    // SENT on a QUEUED row would set sentAt and write MESSAGE_SENT with oldValue "QUEUED" — a delivery
    // recorded as sent with no evidence it was ever handed out. §3 specifies "LEASED" → "SENT".
    await expect(reportDeliveryOutcome(ACTOR, hoisted.ctx, { deliveryId: id, outcome: "SENT" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(
      reportDeliveryOutcome(ACTOR, hoisted.ctx, { deliveryId: id, outcome: "FAILED", error: "never leased" }),
    ).rejects.toBeInstanceOf(ConflictError);

    const row = await prisma.messageDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("QUEUED");
    expect(row.attempts).toBe(0);
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toBeNull();

    expect((await auditRows(prisma, MAIL_TICKET, "MESSAGE_SENT")).length).toBe(sentBefore);
    expect((await auditRows(prisma, MAIL_TICKET, "MESSAGE_FAILED")).length).toBe(failedBefore);
  });

  it("refuses a second outcome after a FAILED report returned the row to the queue", async () => {
    const { addPublicReply, leaseQueuedDeliveries, reportDeliveryOutcome, ConflictError, prisma } = mods();
    const res = await addPublicReply(replyInput(MAIL_TICKET));
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.deliveryId === null) return;
    const id = res.data.deliveryId;
    // Offset 4 keeps this row BEHIND the retry test's offset-3 row in the FIFO: it stays QUEUED after
    // its failure report, and at a lower offset it would win that test's take-1 leases instead.
    await backdate(prisma, id, 4);

    const leased = await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);
    expect(leased.map((d) => d.id)).toContain(id);
    const failed = await reportDeliveryOutcome(ACTOR, hoisted.ctx, {
      deliveryId: id,
      outcome: "FAILED",
      error: "smtp 421 first try",
    });
    expect(failed.status).toBe("QUEUED");

    // The lease is spent. A replaying poller reporting again holds nothing, so the report is refused
    // rather than transitioning a row that is waiting for its next lease.
    await expect(
      reportDeliveryOutcome(ACTOR, hoisted.ctx, { deliveryId: id, outcome: "SENT", providerMessageId: "prov-late" }),
    ).rejects.toBeInstanceOf(ConflictError);

    const row = await prisma.messageDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("QUEUED");
    expect(row.sentAt).toBeNull();
    expect(row.providerMessageId).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it("retries a failure below the cap and stops at MESSAGE_MAX_ATTEMPTS", async () => {
    const { addPublicReply, leaseQueuedDeliveries, reportDeliveryOutcome, MESSAGE_MAX_ATTEMPTS, prisma } = mods();
    const res = await addPublicReply(replyInput(MAIL_TICKET));
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.deliveryId === null) return;
    const id = res.data.deliveryId;
    await backdate(prisma, id, 3);

    for (let attempt = 1; attempt <= MESSAGE_MAX_ATTEMPTS; attempt++) {
      const leased = await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);
      expect(leased.map((d) => d.id), `attempt ${attempt}`).toContain(id);
      const outcome = await reportDeliveryOutcome(ACTOR, hoisted.ctx, {
        deliveryId: id,
        outcome: "FAILED",
        error: `smtp 421 on attempt ${attempt}`,
      });
      expect(outcome.attempts).toBe(attempt);
      expect(outcome.status).toBe(attempt < MESSAGE_MAX_ATTEMPTS ? "QUEUED" : "FAILED");
    }

    const row = await prisma.messageDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(MESSAGE_MAX_ATTEMPTS);
    expect(row.lastError).toContain("smtp 421");
    expect(row.leaseExpiresAt).toBeNull();

    // Terminal: never handed out again.
    const after = await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 5);
    expect(after.map((d) => d.id)).not.toContain(id);

    const failures = (await auditRows(prisma, MAIL_TICKET, "MESSAGE_FAILED")).filter((r) => r.entityId === id);
    expect(failures).toHaveLength(MESSAGE_MAX_ATTEMPTS);
    expect(failures.slice(0, -1).every((r) => r.newValue === "QUEUED")).toBe(true);
    expect(failures.at(-1)?.newValue).toBe("FAILED");
    expect(failures.at(-1)?.metadata).toMatchObject({ terminal: true });

    // Replaying the terminal failure writes no sixth row.
    await reportDeliveryOutcome(ACTOR, hoisted.ctx, { deliveryId: id, outcome: "FAILED", error: "again" });
    const stillFive = (await auditRows(prisma, MAIL_TICKET, "MESSAGE_FAILED")).filter((r) => r.entityId === id);
    expect(stillFive).toHaveLength(MESSAGE_MAX_ATTEMPTS);
  });

  it("retires a lease that expired on the final attempt instead of stranding it as LEASED", async () => {
    const { addPublicReply, leaseQueuedDeliveries, MESSAGE_MAX_ATTEMPTS, LEASE_EXPIRED_AT_CAP_ERROR, prisma } = mods();
    const res = await addPublicReply(replyInput(MAIL_TICKET));
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.deliveryId === null) return;
    const id = res.data.deliveryId;
    // Offset -1 puts this row ahead of every other row in the table — this run's and every earlier
    // run's — so each take-1 lease below is unambiguously about this delivery. It ends terminal, so it
    // never competes with anything that runs after it.
    await backdate(prisma, id, -1);
    // One attempt short of the cap, as if four earlier sends had already failed and been reported.
    await prisma.messageDelivery.update({ where: { id }, data: { attempts: MESSAGE_MAX_ATTEMPTS - 1 } });

    // The final attempt: leasing spends it, so the row is now AT the cap while still LEASED.
    const final = await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);
    expect(final.map((d) => d.id)).toContain(id);
    expect(final.find((d) => d.id === id)?.attempts).toBe(MESSAGE_MAX_ATTEMPTS);
    expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { id } })).status).toBe("LEASED");

    // That poller dies after the handshake and never reports. Nothing but the next sweep can move it:
    // `reportDeliveryOutcome` runs only when a caller reports, and no job touches this table.
    await prisma.messageDelivery.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
    expect((await auditRows(prisma, MAIL_TICKET, "MESSAGE_FAILED")).filter((r) => r.entityId === id)).toHaveLength(0);

    const sweep = await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);
    // Not handed out again — that would spend a sixth attempt — and not left "Sending" forever either.
    expect(sweep.map((d) => d.id)).not.toContain(id);

    const row = await prisma.messageDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(MESSAGE_MAX_ATTEMPTS);
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.leasedAt).toBeNull();
    expect(row.lastError).toBe(LEASE_EXPIRED_AT_CAP_ERROR);
    expect(row.sentAt).toBeNull();

    const failures = (await auditRows(prisma, MAIL_TICKET, "MESSAGE_FAILED")).filter((r) => r.entityId === id);
    expect(failures).toHaveLength(1);
    expect(failures[0].entityType).toBe("MESSAGE_DELIVERY");
    expect(failures[0].fieldChanged).toBe("status");
    expect(failures[0].oldValue).toBe("LEASED");
    expect(failures[0].newValue).toBe("FAILED");
    expect(failures[0].metadata).toMatchObject({
      terminal: true,
      reclaimed: true,
      attempts: MESSAGE_MAX_ATTEMPTS,
      error: LEASE_EXPIRED_AT_CAP_ERROR,
    });

    // Terminal for good: a later sweep neither leases it nor writes a second ledger row for it.
    const again = await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 5);
    expect(again.map((d) => d.id)).not.toContain(id);
    expect((await auditRows(prisma, MAIL_TICKET, "MESSAGE_FAILED")).filter((r) => r.entityId === id)).toHaveLength(1);
  });

  it("refuses a late SENT report for a delivery retired at the cap, and replays its FAILED idempotently", async () => {
    const { addPublicReply, leaseQueuedDeliveries, reportDeliveryOutcome, ConflictError, MESSAGE_MAX_ATTEMPTS, prisma } =
      mods();
    const res = await addPublicReply(replyInput(MAIL_TICKET));
    expect(res.ok).toBe(true);
    if (!res.ok || res.data.deliveryId === null) return;
    const id = res.data.deliveryId;
    await backdate(prisma, id, -2);
    await prisma.messageDelivery.update({ where: { id }, data: { attempts: MESSAGE_MAX_ATTEMPTS - 1 } });

    await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);
    await prisma.messageDelivery.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
    await leaseQueuedDeliveries(ACTOR, hoisted.ctx, 1);
    expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { id } })).status).toBe("FAILED");

    // The poller comes back long after its lease died. The row is terminal, so it is answered exactly
    // like any other report against a terminal row.
    await expect(
      reportDeliveryOutcome(ACTOR, hoisted.ctx, { deliveryId: id, outcome: "SENT", providerMessageId: "prov-late" }),
    ).rejects.toBeInstanceOf(ConflictError);
    const replay = await reportDeliveryOutcome(ACTOR, hoisted.ctx, { deliveryId: id, outcome: "FAILED", error: "smtp" });
    expect(replay.status).toBe("FAILED");
    expect(replay.attempts).toBe(MESSAGE_MAX_ATTEMPTS);

    const row = await prisma.messageDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("FAILED");
    expect(row.sentAt).toBeNull();
    expect(row.providerMessageId).toBeNull();
    // One row for the retirement, none for either report: a terminal replay writes nothing.
    expect((await auditRows(prisma, MAIL_TICKET, "MESSAGE_FAILED")).filter((r) => r.entityId === id)).toHaveLength(1);
    expect((await auditRows(prisma, MAIL_TICKET, "MESSAGE_SENT")).filter((r) => r.entityId === id)).toHaveLength(0);
  });

  it("sets Pending client in the same transaction as the reply and its delivery", async () => {
    const { addPublicReplyAndSetPending, prisma } = mods();
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: PENDING_TICKET } });
    const res = await addPublicReplyAndSetPending({ ...replyInput(PENDING_TICKET), version: before.version });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.status).toBe("PENDING_CLIENT");
    expect(res.data.deliveryQueued).toBe(true);

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: PENDING_TICKET } });
    expect(after.status).toBe("PENDING_CLIENT");
    expect(after.version).toBe(before.version + 1);

    const delivery = await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: res.data.id } });
    expect(delivery.status).toBe("QUEUED");

    const statusRows = await auditRows(prisma, PENDING_TICKET, "TICKET_STATUS_CHANGED");
    expect(statusRows.at(-1)).toMatchObject({ fieldChanged: "status", oldValue: "OPEN", newValue: "PENDING_CLIENT" });
    expect(await auditRows(prisma, PENDING_TICKET, "MESSAGE_QUEUED")).toHaveLength(1);
  });

  it("refuses a stale version token and writes nothing at all", async () => {
    const { addPublicReplyAndSetPending, prisma } = mods();
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: CONFLICT_TICKET } });
    const commentsBefore = await prisma.comment.count({ where: { ticketId: CONFLICT_TICKET } });

    const res = await addPublicReplyAndSetPending({ ...replyInput(CONFLICT_TICKET), version: before.version + 99 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("CONFLICT");

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: CONFLICT_TICKET } });
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(await prisma.comment.count({ where: { ticketId: CONFLICT_TICKET } })).toBe(commentsBefore);
    expect(await prisma.messageDelivery.count({ where: { ticketId: CONFLICT_TICKET } })).toBe(0);
  });
});
