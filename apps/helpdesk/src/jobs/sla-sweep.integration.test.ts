/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10): runs only with TEST_DATABASE_URL, against a
 * separate database — the append-only triggers make every AuditLog and SlaAlert row permanent, so this must
 * never point at the dev database. Tolerates rows left by earlier runs: every fixture is upsert /
 * find-or-create, ids are namespaced per run, and no assertion counts rows it did not create.
 *
 * Proves live, for the SLA sweep:
 *   - the `SlaAlert` insert and its `SLA_ALERT` audit row commit in ONE transaction;
 *   - the `@@unique([ticketId, phase, kind])` constraint IS the dedupe WITHIN one lifecycle — a second
 *     sweep pages nobody;
 *   - a REOPENED ticket starts a new lifecycle and pages again, even though the append-only `SlaAlert`
 *     row from its first lifecycle can never be added to (the regression this file exists to pin);
 *   - the audit row carries `via: "job"`, the machine actor's FK, and the phase:kind verdict;
 *   - the run posts nothing with `SLA_ALERT_SLACK_WEBHOOK_URL` unset, and still records everything.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobContext } from "@/jobs/types";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL: repoint it BEFORE the first import of @/lib/db.
  process.env.DATABASE_URL = TEST_URL;
}
// The sweep must be disabled (log only) for the whole file: nothing in Wave A transmits anything.
delete process.env.SLA_ALERT_SLACK_WEBHOOK_URL;

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const auditModule = TEST_URL ? await import("@/lib/audit") : null;
const sweepModule = TEST_URL ? await import("@/jobs/sla-sweep") : null;
const loggerModule = TEST_URL ? await import("@/jobs/logger") : null;

function mods() {
  if (!dbModule || !auditModule || !sweepModule || !loggerModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...auditModule, ...sweepModule, ...loggerModule };
}

const RUN = randomUUID().slice(0, 8);
const QUEUE_ID = "it_queue_operations";
const ACTOR_USER_ID = `it_jobs_actor_${RUN}`;
const ACTOR_EMAIL = `jobs+${RUN}@wm-helpdesk.local`;
const BREACHED_TICKET_ID = `it_sla_breached_${RUN}`;
const WARNING_TICKET_ID = `it_sla_warning_${RUN}`;
const HEALTHY_TICKET_ID = `it_sla_healthy_${RUN}`;
const REOPENED_TICKET_ID = `it_sla_reopened_${RUN}`;

const NOW = new Date("2026-09-19T12:00:00.000Z");
const minutesFromNow = (m: number): Date => new Date(NOW.getTime() + m * 60_000);

function jobContext(): JobContext {
  const { actorFromMachineUser, systemRequestContext, createJobLogger } = mods();
  const ctx = systemRequestContext(`it-sla-sweep-${RUN}`);
  return {
    name: "sla-sweep",
    actor: actorFromMachineUser({ id: ACTOR_USER_ID, email: ACTOR_EMAIL }),
    ctx,
    now: NOW,
    log: createJobLogger("sla-sweep", ctx.requestId, () => undefined),
  };
}

describe.skipIf(!TEST_URL)("SLA sweep (DB-gated)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { id: QUEUE_ID, key: "OPERATIONS", name: "Operations", description: "integration fixture", sortOrder: 1 },
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    await prisma.user.upsert({
      where: { id: ACTOR_USER_ID },
      update: {},
      create: { id: ACTOR_USER_ID, email: ACTOR_EMAIL, name: "Scheduled jobs (fixture)", groups: [], isActive: true },
    });

    const ticket = async (
      id: string,
      clocks: { firstResponseDueAt: Date; resolutionDueAt: Date; firstRespondedAt?: Date },
    ) =>
      prisma.ticket.upsert({
        where: { id },
        update: {},
        create: {
          id,
          subject: "SLA sweep fixture",
          description: "Ticket used by sla-sweep.integration.test.ts",
          requesterName: "Fixture Requester",
          requesterEmail: `fixture+${RUN}@example.com`,
          category: "OTHER",
          priority: "HIGH",
          queue: { connect: { id: queue.id } },
          createdBy: { connect: { id: ACTOR_USER_ID } },
          slaFirstResponseMinutes: 240,
          slaResolutionMinutes: 1440,
          firstResponseDueAt: clocks.firstResponseDueAt,
          resolutionDueAt: clocks.resolutionDueAt,
          firstRespondedAt: clocks.firstRespondedAt ?? null,
        },
      });

    // First-response clock 3h05m past due, no reply yet.
    await ticket(BREACHED_TICKET_ID, {
      firstResponseDueAt: minutesFromNow(-185),
      resolutionDueAt: minutesFromNow(600),
    });
    // Replied to; resolution clock due in 12 minutes.
    await ticket(WARNING_TICKET_ID, {
      firstRespondedAt: minutesFromNow(-300),
      firstResponseDueAt: minutesFromNow(-280),
      resolutionDueAt: minutesFromNow(12),
    });
    // Comfortably on track.
    await ticket(HEALTHY_TICKET_ID, {
      firstResponseDueAt: minutesFromNow(600),
      resolutionDueAt: minutesFromNow(3000),
    });
    // Replied to; resolution clock 45 minutes past due. Used by the reopen test below, which alerts it,
    // reopens it, and expects the sweep to page a second time.
    await ticket(REOPENED_TICKET_ID, {
      firstRespondedAt: minutesFromNow(-300),
      firstResponseDueAt: minutesFromNow(-280),
      resolutionDueAt: minutesFromNow(-45),
    });
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  it("finds exactly the tickets whose live clock is in WARNING or BREACHED", async () => {
    const { findSlaCandidates, classifySlaAlert } = mods();
    const candidates = await findSlaCandidates(NOW);
    const mine = new Map(candidates.filter((c) => c.id.endsWith(RUN)).map((c) => [c.id, c]));

    expect(mine.has(BREACHED_TICKET_ID)).toBe(true);
    expect(mine.has(WARNING_TICKET_ID)).toBe(true);
    expect(mine.has(HEALTHY_TICKET_ID)).toBe(false);

    expect(classifySlaAlert(mine.get(BREACHED_TICKET_ID)!, NOW)).toMatchObject({
      phase: "FIRST_RESPONSE",
      kind: "BREACHED",
      minutesOver: 185,
    });
    expect(classifySlaAlert(mine.get(WARNING_TICKET_ID)!, NOW)).toMatchObject({
      phase: "RESOLUTION",
      kind: "WARNING",
      minutesOver: 0,
    });
  });

  it("commits the SlaAlert row and its SLA_ALERT audit row together, then dedupes on the constraint", async () => {
    const { prisma, runSlaSweep, alertKey, lastAlertAtByKey } = mods();
    const job = jobContext();

    const first = await runSlaSweep(job);
    expect(first.ok).toBe(true);
    // The webhook is unset, so the sweep records everything and posts nothing.
    expect(first.posted).toBe(0);
    expect(first.metadata?.slack).toBe("disabled");

    const breachedAlert = await prisma.slaAlert.findUnique({
      where: {
        ticketId_phase_kind: { ticketId: BREACHED_TICKET_ID, phase: "FIRST_RESPONSE", kind: "BREACHED" },
      },
    });
    expect(breachedAlert).not.toBeNull();
    expect(breachedAlert?.minutesOver).toBe(185);

    const warningAlert = await prisma.slaAlert.findUnique({
      where: { ticketId_phase_kind: { ticketId: WARNING_TICKET_ID, phase: "RESOLUTION", kind: "WARNING" } },
    });
    expect(warningAlert).not.toBeNull();
    expect(warningAlert?.minutesOver).toBe(0);

    expect(
      await prisma.slaAlert.count({ where: { ticketId: HEALTHY_TICKET_ID } }),
    ).toBe(0);

    const auditRows = await prisma.auditLog.findMany({
      where: { action: "SLA_ALERT", requestId: job.ctx.requestId },
      orderBy: { seq: "asc" },
    });
    const breachedRow = auditRows.find((r) => r.ticketId === BREACHED_TICKET_ID);
    expect(breachedRow).toBeDefined();
    expect(breachedRow?.entityType).toBe("TICKET");
    expect(breachedRow?.fieldChanged).toBe("slaStatus");
    expect(breachedRow?.newValue).toBe("FIRST_RESPONSE:BREACHED");
    expect(breachedRow?.actorId).toBe(ACTOR_USER_ID);
    expect(breachedRow?.actorGroups).toEqual([]);
    expect(breachedRow?.metadata).toMatchObject({
      via: "job",
      jobName: "sla-sweep",
      minutesOver: 185,
      queueKey: "OPERATIONS",
      priority: "HIGH",
    });

    const lastAlertAt = await lastAlertAtByKey([BREACHED_TICKET_ID, WARNING_TICKET_ID]);
    expect(lastAlertAt.get(alertKey(BREACHED_TICKET_ID, "FIRST_RESPONSE", "BREACHED"))).toBeInstanceOf(Date);
    expect(lastAlertAt.get(alertKey(WARNING_TICKET_ID, "RESOLUTION", "WARNING"))).toBeInstanceOf(Date);

    // A second sweep against the same clock pages nobody for these tickets and writes no second alert
    // row. Counts are scoped to this run's tickets: sibling DB-gated files share the database and may
    // create breached tickets of their own while this one runs.
    const secondJob = jobContext();
    await runSlaSweep(secondJob);
    expect(await prisma.slaAlert.count({ where: { ticketId: BREACHED_TICKET_ID } })).toBe(1);
    expect(await prisma.slaAlert.count({ where: { ticketId: WARNING_TICKET_ID } })).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { action: "SLA_ALERT", requestId: secondJob.ctx.requestId, ticketId: { in: [BREACHED_TICKET_ID, WARNING_TICKET_ID] } },
      }),
    ).toBe(0);
  });

  it("reports a race against the unique constraint as skipped rather than throwing", async () => {
    const { recordSlaAlert, findSlaCandidates, classifySlaAlert } = mods();
    const candidates = await findSlaCandidates(NOW);
    const breached = candidates.find((c) => c.id === BREACHED_TICKET_ID);
    expect(breached).toBeDefined();
    const decision = classifySlaAlert(breached!, NOW);
    expect(decision).not.toBeNull();

    // The alert already exists from the sweep above: this is exactly what a concurrent run would hit.
    await expect(recordSlaAlert(jobContext(), { ...breached!, ...decision! })).resolves.toBe(false);
  });
  it("pages again after a reopen, and still only once per lifecycle", async () => {
    const { prisma, runSlaSweep, withTx, writeAudit, findSlaCandidates, lastAlertAtByKey, alertKey } = mods();

    // --- lifecycle 1: the resolution clock is 45 minutes past due, so the sweep pages once. ---
    await runSlaSweep(jobContext());
    const firstCycleAlerts = await prisma.auditLog.findMany({
      where: { action: "SLA_ALERT", ticketId: REOPENED_TICKET_ID },
      orderBy: { seq: "asc" },
    });
    expect(firstCycleAlerts).toHaveLength(1);
    expect(firstCycleAlerts[0].newValue).toBe("RESOLUTION:BREACHED");
    expect(firstCycleAlerts[0].metadata).toMatchObject({ reopened: false, ledgerRowCreated: true });
    expect(await prisma.slaAlert.count({ where: { ticketId: REOPENED_TICKET_ID } })).toBe(1);

    // --- the ticket is resolved, then a requester reply reopens it. ---
    // Exactly what `addRequesterMessageCore` does: status back to OPEN, `resolvedAt` cleared, and a
    // TICKET_REOPENED_BY_REQUESTER row. The audit row is what marks the lifecycle boundary.
    await prisma.ticket.update({
      where: { id: REOPENED_TICKET_ID },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    // The boundary is compared against the first alert's own timestamp, so the two must not land in the
    // same millisecond. A short wait is cheaper and clearer than freezing the clock inside writeAudit.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reopenJob = jobContext();
    await withTx(async (tx) => {
      await prisma.ticket.update({
        where: { id: REOPENED_TICKET_ID },
        data: { status: "OPEN", resolvedAt: null },
      });
      await writeAudit(tx, reopenJob.actor, reopenJob.ctx, {
        action: "TICKET_REOPENED_BY_REQUESTER",
        entityType: "TICKET",
        entityId: REOPENED_TICKET_ID,
        ticketId: REOPENED_TICKET_ID,
        fieldChanged: "status",
        oldValue: "RESOLVED",
        newValue: "OPEN",
      });
    });

    // The candidate now carries the reopen instant, and it is later than the first alert.
    const reopened = (await findSlaCandidates(NOW)).find((c) => c.id === REOPENED_TICKET_ID);
    expect(reopened?.cycleStartedAt).toBeInstanceOf(Date);
    const previousAlertAt = (await lastAlertAtByKey([REOPENED_TICKET_ID])).get(
      alertKey(REOPENED_TICKET_ID, "RESOLUTION", "BREACHED"),
    );
    expect(previousAlertAt).toBeInstanceOf(Date);
    expect(reopened!.cycleStartedAt!.getTime()).toBeGreaterThan(previousAlertAt!.getTime());

    // --- lifecycle 2: the sweep pages a SECOND time. This is the regression. ---
    const secondCycle = await runSlaSweep(jobContext());
    expect(secondCycle.ok).toBe(true);
    expect(secondCycle.metadata?.reopened).toBeGreaterThanOrEqual(1);

    const afterReopen = await prisma.auditLog.findMany({
      where: { action: "SLA_ALERT", ticketId: REOPENED_TICKET_ID },
      orderBy: { seq: "asc" },
    });
    expect(afterReopen).toHaveLength(2);
    expect(afterReopen[1].newValue).toBe("RESOLUTION:BREACHED");
    // The append-only SlaAlert row from lifecycle 1 cannot be added to, so the second page's record is
    // the audit row alone — and it says so.
    expect(afterReopen[1].metadata).toMatchObject({ reopened: true, ledgerRowCreated: false, via: "job" });
    expect(await prisma.slaAlert.count({ where: { ticketId: REOPENED_TICKET_ID } })).toBe(1);

    // --- and only once: a third sweep inside the SAME lifecycle pages nobody. ---
    await runSlaSweep(jobContext());
    expect(
      await prisma.auditLog.count({ where: { action: "SLA_ALERT", ticketId: REOPENED_TICKET_ID } }),
    ).toBe(2);
  });
});
