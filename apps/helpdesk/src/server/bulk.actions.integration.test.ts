/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — rows are permanent).
 *
 * Proves the one claim the whole bulk design rests on (CONTRACT §3 rule 4): **a bulk action is N
 * ordinary actions.**
 *
 *  - Each applied ticket gets its ORDINARY audit row AND one `BULK_ACTION_APPLIED` carrying the shared
 *    `batchId` and the batch `count`, so a reader can reconstruct "these rows were one click";
 *  - a ticket the viewer may not write is SKIPPED with a reason, the denial is in the ledger, and the
 *    rest of the batch still applies — partial success is the contract, not a failure mode;
 *  - a CLOSED or VOIDED ticket, an illegal transition and a no-op are each skipped with their own code
 *    and message, and NOTHING is written for them;
 *  - the version token still guards every write: each ticket's version moves by exactly one;
 *  - the batch cap and a duplicate id are refused by validation, before anything runs;
 *  - a `follow` for the state that already holds is a SUCCESS that writes nothing, not a skip;
 *  - the transition into RESOLVED carries the SAME side-effects here as on the ticket page, so what a
 *    client is told does not depend on which control the operator used.
 *
 * Every assertion is scoped to rows this run created.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OktaGroup, RequestContext, Viewer } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) process.env.DATABASE_URL = TEST_URL;
// `src/lib/env.ts` parses ONCE at import, so the flag must be set before the dynamic imports below.
// It is what makes the resolved-notice parity assertion possible at all: with it unset,
// `maybeSendResolvedNotice` returns null on BOTH paths and "both write nothing" would prove nothing.
// Nothing is transmitted either way — a test run has no outbox poller — and the flag is file-local.
process.env.RESOLVED_NOTICE_ENABLED = "true";

const RUN = randomUUID().slice(0, 8);
const OPS_ID = `it_bulk_ops_${RUN}`;
const T1 = `it_bulk_1_${RUN}`;
const T2 = `it_bulk_2_${RUN}`;
const CLOSED_T = `it_bulk_closed_${RUN}`;
const ADVICE_T = `it_bulk_advice_${RUN}`;
// Follow-only fixtures, so the follow assertions read a ledger nothing else in this file has touched.
const FOLLOW_CS = `it_bulk_follow_cs_${RUN}`;
const FOLLOW_ADV = `it_bulk_follow_adv_${RUN}`;
// One ticket per PATH into RESOLVED, so the two ledgers can be compared without either disturbing the
// other: the bulk control resolves the first, `changeTicketStatus` — what the ticket page calls —
// resolves the second.
const RESOLVE_BULK = `it_bulk_resolve_bulk_${RUN}`;
const RESOLVE_SINGLE = `it_bulk_resolve_single_${RUN}`;
// Outcome fixtures: one with no outcome yet, one that already ended as COMPLETED, and
// one to reopen. Separate tickets so each assertion reads a ledger the others have not written to.
const OUTCOME_FRESH = `it_bulk_outcome_fresh_${RUN}`;
const OUTCOME_TAKEN = `it_bulk_outcome_taken_${RUN}`;
const OUTCOME_REOPEN = `it_bulk_outcome_reopen_${RUN}`;
// Preview fixture: its own ticket and its own follower, so the notification assertion
// reads rows nothing else in this file creates.
const PREVIEW_T = `it_bulk_preview_${RUN}`;
const WATCHER_ID = `it_bulk_watcher_${RUN}`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));
hoisted.viewer = {
  id: OPS_ID,
  email: `bulk.ops.${RUN}@wm-helpdesk.local`,
  name: "Otto Ops",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = { ipAddress: "203.0.113.24", userAgent: `it-bulk/${RUN}`, requestId: `it-bulk-${RUN}`, isPrefetch: false };

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
const actions = TEST_URL ? await import("@/server/bulk.actions") : null;
// The single-ticket path, imported so the parity assertion compares this file's output with the REAL
// other caller rather than with a hand-written expectation of it.
const ticketActions = TEST_URL ? await import("@/server/tickets.actions") : null;

function mods() {
  if (!dbModule || !actions || !ticketActions) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...actions, ...ticketActions };
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

async function rowsFor(ticketId: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: { requestId: hoisted.ctx.requestId, ticketId },
    orderBy: { seq: "asc" },
    select: { action: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true },
  });
}

describe.skipIf(!TEST_URL)("applyBulkAction (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    for (const q of [
      { key: "OPERATIONS" as const, name: "Operations", sortOrder: 1 },
      { key: "CLIENT_SERVICE" as const, name: "Client Service", sortOrder: 2 },
      { key: "ADVICE" as const, name: "Advice", sortOrder: 3 },
    ]) {
      await prisma.queue.upsert({
        where: { key: q.key },
        update: {},
        create: { key: q.key, name: q.name, description: "bulk fixture", sortOrder: q.sortOrder },
      });
    }
    const ops = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
    const clientService = await prisma.queue.findUniqueOrThrow({ where: { key: "CLIENT_SERVICE" } });
    const advice = await prisma.queue.findUniqueOrThrow({ where: { key: "ADVICE" } });
    await prisma.user.upsert({
      where: { id: OPS_ID },
      update: { groups: ["ops_team"], isActive: true },
      create: { id: OPS_ID, email: hoisted.viewer.email, name: "Otto Ops", groups: ["ops_team"], isActive: true, emailVerified: new Date() },
    });
    // The follower for the preview assertion — anyone but the actor, who is never notified.
    await prisma.user.upsert({
      where: { id: WATCHER_ID },
      update: { groups: ["ops_team"], isActive: true },
      create: {
        id: WATCHER_ID,
        email: `bulk.watch.${RUN}@wm-helpdesk.local`,
        name: "Wanda Watcher",
        groups: ["ops_team"],
        isActive: true,
        emailVerified: new Date(),
      },
    });

    const createdAt = new Date("2026-09-19T12:00:00.000Z");
    const fixtures = [
      { id: T1, queueId: ops.id, status: "NEW" as const },
      { id: T2, queueId: ops.id, status: "OPEN" as const },
      { id: CLOSED_T, queueId: ops.id, status: "CLOSED" as const },
      { id: ADVICE_T, queueId: advice.id, status: "OPEN" as const },
      { id: FOLLOW_CS, queueId: clientService.id, status: "OPEN" as const },
      { id: FOLLOW_ADV, queueId: advice.id, status: "OPEN" as const },
      { id: RESOLVE_BULK, queueId: ops.id, status: "OPEN" as const },
      { id: RESOLVE_SINGLE, queueId: ops.id, status: "OPEN" as const },
      { id: OUTCOME_FRESH, queueId: ops.id, status: "OPEN" as const },
      { id: OUTCOME_TAKEN, queueId: ops.id, status: "OPEN" as const, resolution: "COMPLETED" as const },
      { id: OUTCOME_REOPEN, queueId: ops.id, status: "OPEN" as const },
      { id: PREVIEW_T, queueId: ops.id, status: "OPEN" as const },
    ];
    for (const f of fixtures) {
      await prisma.ticket.upsert({
        where: { id: f.id },
        update: {},
        create: {
          id: f.id,
          subject: `Bulk fixture ${f.id}`,
          description: "Bulk fixture description",
          requesterName: "Dana Requester",
          requesterEmail: `bulk.${RUN}@example.com`,
          category: "OTHER",
          priority: "STANDARD",
          status: f.status,
          queueId: f.queueId,
          createdById: OPS_ID,
          slaFirstResponseMinutes: 240,
          slaResolutionMinutes: 1440,
          firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
          resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
          resolution: f.resolution ?? "NONE",
          resolvedAt: f.status === "CLOSED" ? createdAt : null,
          closedAt: f.status === "CLOSED" ? createdAt : null,
        },
      });
    }
  });

  it("applies per ticket, with one ordinary row AND one BULK_ACTION_APPLIED sharing a batch id", async () => {
    const { applyBulkAction, prisma } = mods();
    const before = await prisma.ticket.findMany({ where: { id: { in: [T1, T2] } }, select: { id: true, version: true } });

    const result = await applyBulkAction({ ticketIds: [T1, T2], action: { kind: "assign", assigneeId: OPS_ID } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(2);
    expect(result.data.skipped).toEqual([]);

    for (const t of before) {
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id }, select: { version: true, assigneeId: true } });
      expect(after.assigneeId).toBe(OPS_ID);
      // One write per ticket, version-guarded — never a blanket update.
      expect(after.version).toBe(t.version + 1);
    }

    const t1Rows = await rowsFor(T1);
    expect(t1Rows.filter((r) => r.action === "TICKET_ASSIGNED")).toHaveLength(1);
    const bulk1 = t1Rows.filter((r) => r.action === "BULK_ACTION_APPLIED");
    expect(bulk1).toHaveLength(1);
    expect(bulk1[0]).toMatchObject({ fieldChanged: "bulk", oldValue: null, newValue: "assign" });
    const meta1 = bulk1[0]?.metadata as { batchId?: string; count?: number } | null;
    expect(meta1?.count).toBe(2);

    // §b.6: assigning a NEW ticket auto-opens it, and that is its OWN ordinary row.
    expect(t1Rows.filter((r) => r.action === "TICKET_STATUS_CHANGED" && r.newValue === "OPEN")).toHaveLength(1);

    const bulk2 = (await rowsFor(T2)).filter((r) => r.action === "BULK_ACTION_APPLIED");
    const meta2 = bulk2[0]?.metadata as { batchId?: string } | null;
    expect(meta2?.batchId).toBe(meta1?.batchId);
    expect(typeof meta1?.batchId).toBe("string");
  });

  it("SKIPS what it may not write, records the denial, and still applies the rest", async () => {
    const { applyBulkAction, prisma } = mods();
    const adviceBefore = await prisma.ticket.findUniqueOrThrow({ where: { id: ADVICE_T }, select: { version: true, priority: true } });

    // ops_team WRITES Operations and only READS Advice (the §b access table), so one ticket in this
    // batch is writable and one is not — which is the whole point of the assertion.
    const result = await applyBulkAction({ ticketIds: [T2, ADVICE_T], action: { kind: "priority", priority: "HIGH" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(1);
    expect(result.data.skipped).toHaveLength(1);
    expect(result.data.skipped[0]).toMatchObject({ ticketId: ADVICE_T, code: "FORBIDDEN" });

    const advice = await prisma.ticket.findUniqueOrThrow({ where: { id: ADVICE_T }, select: { version: true, priority: true } });
    expect(advice).toEqual(adviceBefore);
    // The ONLY row written for the refused ticket is the denial itself: no field change, and no
    // BULK_ACTION_APPLIED claiming it was part of the batch.
    const adviceRows = await rowsFor(ADVICE_T);
    expect(adviceRows.map((r) => r.action)).toEqual(["AUTHZ_DENIED"]);

    expect(adviceRows[0]?.newValue).toMatch(/bulk:apply/);

    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: T2 } })).priority).toBe("HIGH");
  });

  it("applies NOTHING for a read-plus-annotate group: compliance never operates (§b rule 2)", async () => {
    const { applyBulkAction, prisma } = mods();
    const before = await prisma.ticket.findMany({ where: { id: { in: [T1, T2] } }, select: { id: true, version: true } });

    const result = await asGroups(["compliance_officers"], () =>
      applyBulkAction({ ticketIds: [T1, T2], action: { kind: "status", status: "RESOLVED" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(0);
    expect(result.data.skipped.map((s) => s.code)).toEqual(["FORBIDDEN", "FORBIDDEN"]);

    for (const t of before) {
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).version).toBe(t.version);
    }
  });

  it("skips a terminal ticket, an illegal transition and a no-op, each with its own reason", async () => {
    const { applyBulkAction, prisma } = mods();

    const closed = await applyBulkAction({ ticketIds: [CLOSED_T], action: { kind: "status", status: "OPEN" } });
    expect(closed.ok).toBe(true);
    if (closed.ok) {
      expect(closed.data.applied).toBe(0);
      expect(closed.data.skipped[0]?.code).toBe("VALIDATION");
      expect(closed.data.skipped[0]?.message).toMatch(/closed/i);
    }
    expect(await rowsFor(CLOSED_T)).toEqual([]);

    // T2 is OPEN; OPEN → NEW is not in the state machine.
    const illegal = await applyBulkAction({ ticketIds: [T2], action: { kind: "status", status: "NEW" } });
    expect(illegal.ok).toBe(true);
    if (illegal.ok) expect(illegal.data.skipped[0]?.message).toMatch(/not an allowed transition/i);

    const noop = await applyBulkAction({ ticketIds: [T2], action: { kind: "priority", priority: "HIGH" } });
    expect(noop.ok).toBe(true);
    if (noop.ok) {
      expect(noop.data.applied).toBe(0);
      expect(noop.data.skipped[0]?.message).toMatch(/already/i);
    }
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: T2 } })).priority).toBe("HIGH");
  });

  it("follows and unfollows with the paired audit rows, and soft-removes rather than deleting", async () => {
    const { applyBulkAction, prisma } = mods();

    const followed = await applyBulkAction({ ticketIds: [T1], action: { kind: "follow", follow: true } });
    expect(followed.ok && followed.data.applied).toBe(1);
    const row = await prisma.ticketFollower.findUniqueOrThrow({ where: { ticketId_userId: { ticketId: T1, userId: OPS_ID } } });
    expect(row.removedAt).toBeNull();
    expect(row.source).toBe("MANUAL");

    // Asking for the state that already holds is a SUCCESS that writes nothing — the rule
    // `followTicket` states and the bulk path used to contradict by throwing, which reported a ticket
    // in exactly the asked-for state as a skipped failure beside the genuine refusals.
    const rowsBeforeNoop = await rowsFor(T1);
    const again = await applyBulkAction({ ticketIds: [T1], action: { kind: "follow", follow: true } });
    expect(again.ok && again.data.applied).toBe(1);
    if (again.ok) expect(again.data.skipped).toEqual([]);
    // Nothing written: no second TICKET_FOLLOWED, and no BULK_ACTION_APPLIED claiming a change.
    expect(await rowsFor(T1)).toEqual(rowsBeforeNoop);
    expect(await prisma.ticketFollower.count({ where: { ticketId: T1, userId: OPS_ID } })).toBe(1);

    const unfollowed = await applyBulkAction({ ticketIds: [T1], action: { kind: "follow", follow: false } });
    expect(unfollowed.ok && unfollowed.data.applied).toBe(1);
    const after = await prisma.ticketFollower.findUniqueOrThrow({ where: { ticketId_userId: { ticketId: T1, userId: OPS_ID } } });
    expect(after.removedAt).not.toBeNull();

    const rows = await rowsFor(T1);
    expect(rows.filter((r) => r.action === "TICKET_FOLLOWED")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "TICKET_UNFOLLOWED")).toHaveLength(1);
    expect(rows.find((r) => r.action === "TICKET_FOLLOWED")).toMatchObject({
      fieldChanged: "follower",
      newValue: hoisted.viewer.email,
    });
  });

  it("refuses a batch over the cap, or one carrying the same ticket twice, before anything runs", async () => {
    const { applyBulkAction, prisma } = mods();
    const before = await prisma.auditLog.count({ where: { requestId: hoisted.ctx.requestId } });

    const tooMany = await applyBulkAction({
      ticketIds: Array.from({ length: WAVE_B_LIMITS.bulkMaxTickets + 1 }, (_, i) => `it_bulk_fake_${RUN}_${i}`),
      action: { kind: "priority", priority: "LOW" },
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.code).toBe("VALIDATION");

    const duplicated = await applyBulkAction({ ticketIds: [T1, T1], action: { kind: "priority", priority: "LOW" } });
    expect(duplicated.ok).toBe(false);

    expect(await prisma.auditLog.count({ where: { requestId: hoisted.ctx.requestId } })).toBe(before);
  });

  it("bulk-follows on queue READ, so compliance — WRITE nowhere — can follow from the board", async () => {
    // The bar per kind is the bar the single-ticket control applies: `followTicket` requires queue
    // READ because following is watching, and the bulk path must not be stricter. compliance_officers
    // READS all three queues and WRITES none, so this batch is the strongest form of the claim.
    const { applyBulkAction, prisma } = mods();
    const before = await prisma.ticket.findMany({
      where: { id: { in: [FOLLOW_CS, FOLLOW_ADV] } },
      select: { id: true, version: true },
    });

    const result = await asGroups(["compliance_officers"], () =>
      applyBulkAction({ ticketIds: [FOLLOW_CS, FOLLOW_ADV], action: { kind: "follow", follow: true } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(2);
    expect(result.data.skipped).toEqual([]);

    for (const t of before) {
      const row = await prisma.ticketFollower.findUniqueOrThrow({
        where: { ticketId_userId: { ticketId: t.id, userId: OPS_ID } },
      });
      expect(row.removedAt).toBeNull();
      // Following writes no ticket field: the version token does not move.
      expect((await prisma.ticketFollower.count({ where: { ticketId: t.id, userId: OPS_ID } }))).toBe(1);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).version).toBe(t.version);

      const rows = await rowsFor(t.id);
      expect(rows.map((r) => r.action)).toEqual(["TICKET_FOLLOWED", "BULK_ACTION_APPLIED"]);
      // No denial for something the same person may do one click away on the ticket page.
      expect(rows.some((r) => r.action === "AUTHZ_DENIED")).toBe(false);
    }
  });

  it("still refuses a bulk follow on a queue the viewer cannot even READ", async () => {
    // client_services has NO access to ADVICE (QUEUE_ACCESS), so READ is a real bar, not a formality.
    const { applyBulkAction, prisma } = mods();
    const before = await prisma.ticketFollower.findUniqueOrThrow({
      where: { ticketId_userId: { ticketId: FOLLOW_ADV, userId: OPS_ID } },
      select: { removedAt: true },
    });

    const result = await asGroups(["client_services"], () =>
      applyBulkAction({ ticketIds: [FOLLOW_ADV], action: { kind: "follow", follow: false } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(0);
    expect(result.data.skipped[0]).toMatchObject({ ticketId: FOLLOW_ADV, code: "FORBIDDEN" });
    expect(result.data.skipped[0]?.message).toMatch(/queue:read/);

    // Nothing changed, and the refusal is the only new row.
    const after = await prisma.ticketFollower.findUniqueOrThrow({
      where: { ticketId_userId: { ticketId: FOLLOW_ADV, userId: OPS_ID } },
      select: { removedAt: true },
    });
    expect(after).toEqual(before);
    const rows = await rowsFor(FOLLOW_ADV);
    expect(rows.map((r) => r.action)).toEqual(["TICKET_FOLLOWED", "BULK_ACTION_APPLIED", "AUTHZ_DENIED"]);
    expect(rows.at(-1)?.newValue).toMatch(/bulk:apply follow/);
  });

  it("keeps WRITE on the four kinds that change the ticket, for the same reader", async () => {
    // The fix widens `follow` alone. A compliance officer following a ticket must still be unable to
    // assign, re-prioritise, move or resolve it.
    const { applyBulkAction, prisma } = mods();
    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: FOLLOW_CS }, select: { version: true } });

    const result = await asGroups(["compliance_officers"], () =>
      applyBulkAction({ ticketIds: [FOLLOW_CS], action: { kind: "assign", assigneeId: OPS_ID } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(0);
    expect(result.data.skipped[0]).toMatchObject({ ticketId: FOLLOW_CS, code: "FORBIDDEN" });
    expect(result.data.skipped[0]?.message).toMatch(/bulk:apply assign/);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: FOLLOW_CS } })).version).toBe(before.version);
  });

  it("resolves with the SAME side-effects the ticket page's control has — one notice either way", async () => {
    // Fix round 1. `changeTicketStatus` ran `maybeSendResolvedNotice` on the transition into RESOLVED
    // and this path did not, so with RESOLVED_NOTICE_ENABLED set a client was emailed when an operator
    // used the ticket page and told nothing when the same operator resolved the same ticket from the
    // dashboard checkbox — and the two tickets' correspondence histories differed for no visible
    // reason. The flag is on for this file (top of module), so both paths really write.
    const { applyBulkAction, changeTicketStatus, prisma } = mods();

    const bulk = await applyBulkAction({ ticketIds: [RESOLVE_BULK], action: { kind: "status", status: "RESOLVED" } });
    expect(bulk.ok).toBe(true);
    if (!bulk.ok) return;
    expect(bulk.data.applied).toBe(1);
    expect(bulk.data.skipped).toEqual([]);

    const before = await prisma.ticket.findUniqueOrThrow({ where: { id: RESOLVE_SINGLE }, select: { version: true } });
    const single = await changeTicketStatus({ ticketId: RESOLVE_SINGLE, version: before.version, status: "RESOLVED" });
    expect(single.ok).toBe(true);

    // The notice's own rows, in order. The two paths still differ in ways this assertion deliberately
    // does not cover (the single path also writes the `resolvedAt` TICKET_FIELD_CHANGED row and can
    // carry an outcome; the bulk path writes BULK_ACTION_APPLIED) — what must not differ is whether
    // the client heard anything.
    const noticeRows = (rows: Awaited<ReturnType<typeof rowsFor>>) =>
      rows.map((r) => r.action).filter((a) => a === "COMMENT_ADDED_PUBLIC" || a === "MESSAGE_QUEUED");
    const bulkRows = await rowsFor(RESOLVE_BULK);
    const singleRows = await rowsFor(RESOLVE_SINGLE);
    expect(noticeRows(bulkRows)).toEqual(["COMMENT_ADDED_PUBLIC", "MESSAGE_QUEUED"]);
    expect(noticeRows(bulkRows)).toEqual(noticeRows(singleRows));

    // And the ticket's own record: one SYSTEM-authored PUBLIC comment and one delivery, on each.
    for (const id of [RESOLVE_BULK, RESOLVE_SINGLE]) {
      const comments = await prisma.comment.findMany({
        where: { ticketId: id },
        select: { authorKind: true, authorId: true, visibility: true },
      });
      expect(comments).toEqual([{ authorKind: "SYSTEM", authorId: null, visibility: "PUBLIC" }]);
      expect(await prisma.messageDelivery.count({ where: { ticketId: id } })).toBe(1);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id } })).status).toBe("RESOLVED");
    }
  });

  /**
   * Fix round 2. The bulk status change could not record HOW a ticket ended, so a desk that worked
   * from the board filled `resolution-mix` with "Not recorded" no matter how carefully it used the
   * ticket page. The outcome is asked once for the batch and written per ticket, with its own
   * `TICKET_FIELD_CHANGED` row — the same shape the single-ticket path writes.
   */
  it("records the batch's outcome per ticket, with its own audit row", async () => {
    const { applyBulkAction, prisma } = mods();
    const result = await applyBulkAction({
      ticketIds: [OUTCOME_FRESH],
      action: { kind: "status", status: "RESOLVED", resolution: "ANSWERED" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(1);

    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: OUTCOME_FRESH } });
    expect(t.status).toBe("RESOLVED");
    expect(t.resolution).toBe("ANSWERED");

    const rows = await rowsFor(OUTCOME_FRESH);
    const outcomeRow = rows.find((r) => r.action === "TICKET_FIELD_CHANGED" && r.fieldChanged === "resolution");
    expect(outcomeRow).toBeDefined();
    expect(outcomeRow?.oldValue).toBe("NONE");
    expect(outcomeRow?.newValue).toBe("ANSWERED");
  });

  /**
   * Write-once, the same rule `assertResolutionAllowed` enforces on the single-ticket path — but
   * SKIPPED rather than refused, because a batch of forty is exactly where one already-resolved
   * ticket would otherwise abort the whole action. The recorded fact is not overwritten either way.
   */
  it("leaves an outcome that is already recorded alone, and does not fail the batch for it", async () => {
    const { applyBulkAction, prisma } = mods();
    const result = await applyBulkAction({
      ticketIds: [OUTCOME_TAKEN],
      action: { kind: "status", status: "RESOLVED", resolution: "ANSWERED" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(1);
    expect(result.data.skipped).toEqual([]);

    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: OUTCOME_TAKEN } });
    expect(t.status).toBe("RESOLVED");
    expect(t.resolution).toBe("COMPLETED");
    const rows = await rowsFor(OUTCOME_TAKEN);
    expect(rows.filter((r) => r.action === "TICKET_FIELD_CHANGED" && r.fieldChanged === "resolution")).toEqual([]);
  });

  /** A reopened ticket has not ended, so it carries no outcome — the same clear the other paths make. */
  it("clears the outcome when a batch reopens a resolved ticket", async () => {
    const { applyBulkAction, prisma } = mods();
    const resolved = await applyBulkAction({
      ticketIds: [OUTCOME_REOPEN],
      action: { kind: "status", status: "RESOLVED", resolution: "NO_RESPONSE" },
    });
    expect(resolved.ok).toBe(true);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: OUTCOME_REOPEN } })).resolution).toBe("NO_RESPONSE");

    const reopened = await applyBulkAction({ ticketIds: [OUTCOME_REOPEN], action: { kind: "status", status: "OPEN" } });
    expect(reopened.ok).toBe(true);
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: OUTCOME_REOPEN } });
    expect(t.status).toBe("OPEN");
    expect(t.resolution).toBe("NONE");
    expect(t.resolvedAt).toBeNull();
  });

  /**
   * Fix round 2 (QA). The follower preview used to print the union discriminator —
   * "HD-1042 updated (queue)" — which is how this module spells its own type, not how /inbox speaks.
   * §7.3 still holds: a label is the same enum value written the way the badge and the filters
   * write it, and nothing about the subject, the requester or the body enters the string.
   */
  it("previews a bulk change in the words every other surface uses, not the action kind", async () => {
    const { applyBulkAction, prisma } = mods();
    await prisma.ticketFollower.upsert({
      where: { ticketId_userId: { ticketId: PREVIEW_T, userId: WATCHER_ID } },
      update: { removedAt: null },
      create: { ticketId: PREVIEW_T, userId: WATCHER_ID, source: "MANUAL" },
    });
    const { number } = await prisma.ticket.findUniqueOrThrow({ where: { id: PREVIEW_T }, select: { number: true } });

    const result = await applyBulkAction({ ticketIds: [PREVIEW_T], action: { kind: "priority", priority: "URGENT" } });
    expect(result.ok).toBe(true);

    const rows = await prisma.notification.findMany({
      where: { ticketId: PREVIEW_T, userId: WATCHER_ID, kind: "FOLLOWED_UPDATE" },
      select: { preview: true },
    });
    expect(rows.map((r) => r.preview)).toEqual([`HD-${number} priority → Urgent`]);
    expect(rows[0]?.preview).not.toContain("(priority)");
    expect(rows[0]?.preview).not.toContain("URGENT");
  });

  it("reports a ticket that does not exist as NOT_FOUND rather than failing the batch", async () => {
    const { applyBulkAction } = mods();
    const result = await applyBulkAction({
      ticketIds: [`it_bulk_missing_${RUN}`, T1],
      action: { kind: "priority", priority: "LOW" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.applied).toBe(1);
    expect(result.data.skipped[0]?.code).toBe("NOT_FOUND");
  });
});
