/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB).
 *
 * Proves macro ACTIONS against a real transaction:
 *
 *  - The side effects land in the SAME transaction as the comment, and they write ORDINARY audit rows
 *    (`TICKET_STATUS_CHANGED`, `TICKET_ASSIGNED`, …) plus one `MACRO_ACTIONS_APPLIED` naming the macro.
 *  - A macro is a shortcut through the UI, never a way around the policy: an illegal status transition
 *    and an ineligible assignee are REFUSED, and the refusal rolls the comment back with them.
 *  - A field already holding the requested value writes nothing — a change is an event, a save is not.
 *  - `Ticket.version` is bumped exactly ONCE per submit: the caller's guard makes it and this
 *    module deliberately does not make a second.
 *  - A priority change re-stamps both SLA due dates, exactly as `changeTicketPriority` does.
 *  - A macro with no actions behaves byte-for-byte as it did before Wave B.
 *  - `setMacroActions` validates on the way in and audits the change; a save that changes nothing
 *    writes no row.
 *
 * Every assertion is scoped to rows this run created.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionResult, MacroActions, OktaGroup, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}
// Set BEFORE `@/lib/env` is imported, so the resolved-notice assertions below exercise the real write
// path rather than its disabled no-op. Nothing transmits: the notice is a Comment plus a queued
// MessageDelivery row, and no dispatcher runs in this process.
process.env.RESOLVED_NOTICE_ENABLED = "true";

const RUN = randomUUID().slice(0, 8);
const OPS_ID = `it_macroact_ops_${RUN}`;
const CS_ID = `it_macroact_cs_${RUN}`;
const CCO_ID = `it_macroact_cco_${RUN}`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));

function viewerOf(id: string, groups: OktaGroup[]): Viewer {
  return { id, email: `${id}@wm-helpdesk.local`, name: "Olivia Ops", image: null, groups, isDev: false };
}

hoisted.viewer = viewerOf(OPS_ID, ["ops_team"]);
hoisted.ctx = {
  ipAddress: "203.0.113.55",
  userAgent: `it-macro-actions/${RUN}`,
  requestId: `it-macro-actions-${RUN}`,
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
const commentActions = TEST_URL ? await import("@/server/comments.actions") : null;
const macroActions = TEST_URL ? await import("@/server/macros.actions") : null;
const macroReads = TEST_URL ? await import("@/server/macros") : null;

function mods() {
  if (!dbModule || !commentActions || !macroActions || !macroReads) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { prisma: dbModule.prisma, ...commentActions, ...macroActions, ...macroReads };
}

function ok<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.data;
}

let seq = 0;

async function newTicket(over: { status?: "NEW" | "OPEN" | "RESOLVED" | "CLOSED"; priority?: "URGENT" | "STANDARD" } = {}) {
  const { prisma } = mods();
  const id = `it_macroact_ticket_${RUN}_${seq++}`;
  const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
  const createdAt = new Date("2026-09-19T09:00:00.000Z");
  return prisma.ticket.create({
    data: {
      id,
      subject: `Macro-actions fixture ${id}`,
      description: "A ticket for the macro-actions tests.",
      requesterName: "Margaret Thompson",
      requesterEmail: `macroact.${id}@example.com`,
      category: "ACAT",
      priority: over.priority ?? "STANDARD",
      status: over.status ?? "OPEN",
      queue: { connect: { id: queue.id } },
      createdBy: { connect: { id: OPS_ID } },
      slaFirstResponseMinutes: 240,
      slaResolutionMinutes: 1440,
      firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
      resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
      createdAt,
    },
    select: { id: true, version: true, firstResponseDueAt: true, resolutionDueAt: true },
  });
}

/** A PUBLIC macro in every queue, carrying `actions`. */
async function newMacro(actions: MacroActions | null, suffix: string): Promise<{ id: string; key: string }> {
  const { prisma } = mods();
  const key = `it-macroact-${suffix}-${RUN}`;
  return prisma.macro.create({
    data: {
      key,
      title: `Macro actions ${suffix}`,
      body: "Thank you for getting in touch about {{ticket.number}}.",
      channel: "PUBLIC",
      disclaimerKey: "GENERAL_SERVICE",
      isActive: true,
      sortOrder: 0,
      actions: actions === null ? undefined : actions,
    },
    select: { id: true, key: true },
  });
}

async function auditForTicket(ticketId: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: { requestId: hoisted.ctx.requestId, ticketId },
    orderBy: { seq: "asc" },
    select: { action: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true },
  });
}

async function reply(ticketId: string, macroId: string) {
  const { addPublicReply } = mods();
  return addPublicReply({
    ticketId,
    body: "Thank you for getting in touch.",
    macroId,
    disclaimerKey: "GENERAL_SERVICE",
    disclaimerAcknowledged: true,
  });
}

describe.skipIf(!TEST_URL)("macro actions (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    for (const [key, name, order] of [
      ["OPERATIONS", "Operations", 1],
      ["CLIENT_SERVICE", "Client Service", 2],
    ] as const) {
      await prisma.queue.upsert({
        where: { key },
        update: {},
        create: { key, name, description: "macro-actions fixture", sortOrder: order },
      });
    }
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
    // CS holds WRITE on CLIENT_SERVICE and cannot write OPERATIONS — the eligibility fixture.
    await prisma.user.upsert({
      where: { id: CS_ID },
      update: { groups: ["client_services"], isActive: true },
      create: {
        id: CS_ID,
        email: `${CS_ID}@wm-helpdesk.local`,
        name: "Chris Service",
        groups: ["client_services"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
    // Compliance reads every queue and writes none: may add an internal note, may not edit a ticket.
    await prisma.user.upsert({
      where: { id: CCO_ID },
      update: { groups: ["compliance_officers"], isActive: true },
      create: {
        id: CCO_ID,
        email: `${CCO_ID}@wm-helpdesk.local`,
        name: "Casey Compliance",
        groups: ["compliance_officers"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
  });

  async function newInternalMacro(actions: MacroActions, suffix: string): Promise<{ id: string; key: string }> {
    const { prisma } = mods();
    return prisma.macro.create({
      data: {
        key: `it-macroact-internal-${suffix}-${RUN}`,
        title: `Internal ${suffix}`,
        body: "Noted.",
        channel: "INTERNAL",
        disclaimerKey: "NONE",
        isActive: true,
        sortOrder: 0,
        actions,
      },
      select: { id: true, key: true },
    });
  }

  it("REFUSES a macro's actions from a viewer who can only read the queue, rolling the note back", async () => {
    const { prisma, addInternalNote } = mods();
    const ticket = await newTicket();
    const macro = await newInternalMacro({ status: "RESOLVED", resolution: "ANSWERED", priority: "URGENT" }, "readonly");
    hoisted.viewer = viewerOf(CCO_ID, ["compliance_officers"]);
    try {
      const refused = await addInternalNote({ ticketId: ticket.id, body: "Noted.", macroId: macro.id });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.code).toBe("VALIDATION");
        expect(refused.fieldErrors?.macroId?.[0] ?? "").toContain("OPERATIONS");
      }
      // The note alone, with no macro, is still allowed: READ is enough for that.
      ok(await addInternalNote({ ticketId: ticket.id, body: "Noted." }));
    } finally {
      hoisted.viewer = viewerOf(OPS_ID, ["ops_team"]);
    }
    expect(await prisma.comment.count({ where: { ticketId: ticket.id } })).toBe(1);
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, select: { status: true, priority: true } });
    expect(after).toEqual({ status: "OPEN", priority: "STANDARD" });
  });

  it("REFUSES a macro's actions on a closed ticket, where an internal note alone is still allowed", async () => {
    const { prisma, addInternalNote } = mods();
    const ticket = await newTicket({ status: "CLOSED" });
    const macro = await newInternalMacro({ priority: "URGENT", escalationTarget: "COMPLIANCE" }, "closed");

    const refused = await addInternalNote({ ticketId: ticket.id, body: "Noted.", macroId: macro.id });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.fieldErrors?.macroId?.[0] ?? "").toContain("closed");
    ok(await addInternalNote({ ticketId: ticket.id, body: "Noted." }));

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { priority: true, escalationTarget: true },
    });
    expect(after.priority).toBe("STANDARD");
    expect(after.escalationTarget).not.toBe("COMPLIANCE");
  });

  it("offers macros with actions only to viewers who can write the queue", async () => {
    const { listMacros } = mods();
    const macro = await newInternalMacro({ followUpInDays: 2 }, "offered");
    const plain = await mods().prisma.macro.create({
      data: { key: `it-macroact-noteonly-${RUN}`, title: "Plain note", body: "Noted.", channel: "INTERNAL", disclaimerKey: "NONE", isActive: true, sortOrder: 0 },
      select: { id: true },
    });
    const ids = async (viewer: Viewer) => (await listMacros(viewer, "OPERATIONS", hoisted.ctx)).map((m) => m.id);

    const forOps = await ids(viewerOf(OPS_ID, ["ops_team"]));
    expect(forOps).toContain(macro.id);
    expect(forOps).toContain(plain.id);
    const forCompliance = await ids(viewerOf(CCO_ID, ["compliance_officers"]));
    expect(forCompliance).not.toContain(macro.id);
    expect(forCompliance).toContain(plain.id);
  });

  it("applies status, assignee and follow-up atomically with the comment", async () => {
    const { prisma } = mods();
    const ticket = await newTicket();
    const macro = await newMacro({ status: "PENDING_CLIENT", assignee: "me", followUpInDays: 3 }, "full");

    ok(await reply(ticket.id, macro.id));

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("PENDING_CLIENT");
    expect(after.assigneeId).toBe(OPS_ID);
    expect(after.followUpAt).not.toBeNull();

    const rows = await auditForTicket(ticket.id);
    // Ordinary rows, the same ones the manual path writes …
    expect(rows.find((r) => r.action === "TICKET_STATUS_CHANGED")).toMatchObject({
      fieldChanged: "status",
      oldValue: "OPEN",
      newValue: "PENDING_CLIENT",
    });
    expect(rows.find((r) => r.action === "TICKET_ASSIGNED")).toMatchObject({ fieldChanged: "assigneeId", newValue: OPS_ID });
    expect(rows.find((r) => r.fieldChanged === "followUpAt")?.action).toBe("TICKET_FIELD_CHANGED");
    // … plus exactly one row naming the macro.
    const applied = rows.filter((r) => r.action === "MACRO_ACTIONS_APPLIED");
    expect(applied).toHaveLength(1);
    expect(applied[0]?.newValue?.split(",").sort()).toEqual(["assignee", "followUpInDays", "status"]);
    expect((applied[0]?.metadata as { macroKey?: string })?.macroKey).toBe(macro.key);
  });

  it("bumps Ticket.version exactly once per submit (I13)", async () => {
    const { prisma } = mods();
    const ticket = await newTicket();
    const macro = await newMacro({ status: "PENDING_CLIENT", priority: "URGENT" }, "version");

    ok(await reply(ticket.id, macro.id));

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, select: { version: true } });
    expect(after.version).toBe(ticket.version + 1);
  });

  it("re-stamps both SLA due dates when the priority moves, like changeTicketPriority", async () => {
    const { prisma } = mods();
    const ticket = await newTicket({ priority: "STANDARD" });
    const macro = await newMacro({ priority: "URGENT" }, "priority");

    ok(await reply(ticket.id, macro.id));

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.priority).toBe("URGENT");
    expect(after.firstResponseDueAt.getTime()).not.toBe(ticket.firstResponseDueAt.getTime());
    expect(after.resolutionDueAt.getTime()).not.toBe(ticket.resolutionDueAt.getTime());

    const rows = await auditForTicket(ticket.id);
    expect(rows.find((r) => r.action === "TICKET_PRIORITY_CHANGED")).toBeDefined();
    for (const field of ["slaFirstResponseMinutes", "slaResolutionMinutes", "firstResponseDueAt", "resolutionDueAt"]) {
      expect(rows.some((r) => r.fieldChanged === field), `no audit row for ${field}`).toBe(true);
    }
  });

  it("REFUSES an illegal status transition and rolls the comment back with it", async () => {
    const { prisma } = mods();
    // RESOLVED → PENDING_CLIENT is not in the state machine.
    const ticket = await newTicket({ status: "RESOLVED" });
    const macro = await newMacro({ status: "PENDING_CLIENT" }, "illegal");

    const refused = await reply(ticket.id, macro.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("VALIDATION");
      expect(refused.fieldErrors?.macroId?.[0] ?? "").toContain("status");
    }

    // Atomic: no comment, no status change, no version bump.
    expect(await prisma.comment.count({ where: { ticketId: ticket.id } })).toBe(0);
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, select: { status: true, version: true } });
    expect(after).toEqual({ status: "RESOLVED", version: ticket.version });
  });

  it("REFUSES an assignee who cannot work the queue (§b.4), rolling the comment back", async () => {
    const { prisma } = mods();
    const ticket = await newTicket();
    // CS cannot write OPERATIONS, so this is exactly the assignment the manual path refuses.
    const macro = await newMacro({ assignee: CS_ID }, "ineligible");

    const refused = await reply(ticket.id, macro.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("VALIDATION");

    expect(await prisma.comment.count({ where: { ticketId: ticket.id } })).toBe(0);
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, select: { assigneeId: true } });
    expect(after.assigneeId).toBeNull();
  });

  it("clears an assignee who cannot write the destination when the macro moves the queue (§b.5)", async () => {
    const { prisma } = mods();
    const ticket = await newTicket();
    await prisma.ticket.update({ where: { id: ticket.id }, data: { assigneeId: OPS_ID } });
    // ops_team cannot write CLIENT_SERVICE, so the move must drop the assignee.
    const macro = await newMacro({ queueKey: "CLIENT_SERVICE" }, "move");

    ok(await reply(ticket.id, macro.id));

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { assigneeId: true, queue: { select: { key: true } } },
    });
    expect(after.queue.key).toBe("CLIENT_SERVICE");
    expect(after.assigneeId).toBeNull();

    const rows = await auditForTicket(ticket.id);
    expect(rows.find((r) => r.action === "TICKET_QUEUE_CHANGED")).toMatchObject({
      oldValue: "OPERATIONS",
      newValue: "CLIENT_SERVICE",
    });
    expect(
      rows.find((r) => r.action === "TICKET_ASSIGNED" && (r.metadata as { reason?: string })?.reason === "queue-move"),
    ).toBeDefined();
  });

  it("writes nothing for a field that already holds the requested value", async () => {
    const ticket = await newTicket({ priority: "STANDARD" });
    const macro = await newMacro({ priority: "STANDARD" }, "noop-field");

    ok(await reply(ticket.id, macro.id));

    const rows = await auditForTicket(ticket.id);
    expect(rows.some((r) => r.action === "TICKET_PRIORITY_CHANGED")).toBe(false);
    expect(rows.some((r) => r.action === "MACRO_ACTIONS_APPLIED")).toBe(false);
  });

  it("leaves a macro with NO actions behaving exactly as it did before Wave B", async () => {
    const { prisma } = mods();
    const ticket = await newTicket();
    const macro = await newMacro(null, "plain");

    ok(await reply(ticket.id, macro.id));

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("OPEN");
    expect(after.assigneeId).toBeNull();
    expect(after.followUpAt).toBeNull();

    const rows = await auditForTicket(ticket.id);
    expect(rows.some((r) => r.action === "MACRO_ACTIONS_APPLIED")).toBe(false);
    // The Wave A row that names the applied macro is still written.
    expect(rows.find((r) => r.action === "MACRO_APPLIED")?.newValue).toBe(macro.key);
  });

  /**
   * Fix round 2. A macro whose action resolved a ticket was the ONE path into RESOLVED that told the
   * client nothing: `changeTicketStatus` and the bulk status change both ran `maybeSendResolvedNotice`
   * and this did not, so two tickets resolved on the same day carried different correspondence
   * histories depending only on which control the operator reached for.
   */
  it("sends the resolved notice on a macro-applied RESOLVED, like every other path", async () => {
    const { prisma } = mods();
    const ticket = await newTicket();
    const macro = await newMacro({ status: "RESOLVED" }, "resolved-notice");

    ok(await reply(ticket.id, macro.id));

    const rows = await auditForTicket(ticket.id);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("TICKET_STATUS_CHANGED");
    // The notice's own rows. The operator's own reply is the first PUBLIC comment; the notice is the
    // second, and it is the one with a queued delivery beside it.
    expect(actions).toContain("MESSAGE_QUEUED");

    const comments = await prisma.comment.findMany({
      where: { ticketId: ticket.id },
      orderBy: { createdAt: "asc" },
      select: { authorKind: true, visibility: true },
    });
    // TWO public comments and TWO deliveries: the operator's own reply, then the notice. The one that
    // matters is the SYSTEM-authored one — that is the notice, and before this fix it did not exist.
    expect(comments).toEqual([
      { authorKind: "STAFF", visibility: "PUBLIC" },
      { authorKind: "SYSTEM", visibility: "PUBLIC" },
    ]);
    expect(await prisma.messageDelivery.count({ where: { ticketId: ticket.id } })).toBe(2);
  });

  /**
   * The macro half of the outcome. Only ever written beside an ending status — `macroActionsSchema`
   * refuses the incoherent configuration outright — and never over an outcome already recorded.
   */
  it("records the macro's outcome, with its own audit row", async () => {
    const { prisma } = mods();
    const ticket = await newTicket();
    const macro = await newMacro({ status: "RESOLVED", resolution: "COMPLETED" }, "outcome");

    ok(await reply(ticket.id, macro.id));

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { status: true, resolution: true },
    });
    expect(after).toEqual({ status: "RESOLVED", resolution: "COMPLETED" });

    const rows = await auditForTicket(ticket.id);
    const outcomeRow = rows.find((r) => r.action === "TICKET_FIELD_CHANGED" && r.fieldChanged === "resolution");
    expect(outcomeRow?.oldValue).toBe("NONE");
    expect(outcomeRow?.newValue).toBe("COMPLETED");
  });

  it("leaves an outcome that is already recorded alone", async () => {
    const { prisma } = mods();
    const ticket = await newTicket();
    await prisma.ticket.update({ where: { id: ticket.id }, data: { resolution: "WITHDRAWN" } });
    const macro = await newMacro({ status: "RESOLVED", resolution: "ANSWERED" }, "outcome-taken");

    ok(await reply(ticket.id, macro.id));

    const after = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { status: true, resolution: true },
    });
    expect(after).toEqual({ status: "RESOLVED", resolution: "WITHDRAWN" });
  });

  it("applies actions on an INTERNAL macro too", async () => {
    const { prisma, addInternalNote } = mods();
    const ticket = await newTicket();
    const macro = await prisma.macro.create({
      data: {
        key: `it-macroact-internal-${RUN}`,
        title: "Internal with actions",
        body: "Chased the custodian.",
        channel: "INTERNAL",
        disclaimerKey: "NONE",
        isActive: true,
        sortOrder: 0,
        actions: { status: "PENDING_INTERNAL" },
      },
      select: { id: true },
    });

    ok(await addInternalNote({ ticketId: ticket.id, body: "Chased the custodian.", macroId: macro.id }));

    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id }, select: { status: true } });
    expect(after.status).toBe("PENDING_INTERNAL");
  });
});

describe.skipIf(!TEST_URL)("setMacroActions (TEST_DATABASE_URL)", () => {
  it("stores, audits and re-reads the actions", async () => {
    const { setMacroActions, listMacrosAdmin, prisma } = mods();
    const macro = await newMacro(null, "admin");

    ok(await setMacroActions({ macroId: macro.id, actions: { status: "PENDING_CLIENT", followUpInDays: 2 } }));

    const stored = await prisma.macro.findUniqueOrThrow({ where: { id: macro.id }, select: { actions: true, updatedById: true } });
    expect(stored.actions).toEqual({ status: "PENDING_CLIENT", followUpInDays: 2 });
    expect(stored.updatedById).toBe(OPS_ID);

    const row = (await listMacrosAdmin(hoisted.viewer, hoisted.ctx)).find((m) => m.id === macro.id);
    expect(row?.actions).toEqual({ status: "PENDING_CLIENT", followUpInDays: 2 });

    const audit = await prisma.auditLog.findMany({
      where: { requestId: hoisted.ctx.requestId, entityId: macro.id, fieldChanged: "actions" },
      select: { action: true, oldValue: true, newValue: true },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "MACRO_UPDATED", oldValue: "none" });
    expect(audit[0]?.newValue).toContain("PENDING_CLIENT");
  });

  it("clears back to SQL NULL, not JSON null, so `actions IS NULL` stays true", async () => {
    const { setMacroActions, prisma } = mods();
    const macro = await newMacro({ status: "OPEN" }, "clear");

    ok(await setMacroActions({ macroId: macro.id, actions: null }));

    // Asked in SQL on purpose: Prisma's `equals: null` on a Json column means JSON null, which is a
    // DIFFERENT value from SQL NULL and is exactly the confusion this assertion exists to catch.
    const rows = await prisma.$queryRaw<Array<{ is_null: boolean }>>`
      SELECT actions IS NULL AS is_null FROM "Macro" WHERE id = ${macro.id}`;
    expect(rows[0]?.is_null).toBe(true);
  });

  it("writes no row when nothing changed", async () => {
    const { setMacroActions, prisma } = mods();
    const macro = await newMacro({ status: "PENDING_CLIENT" }, "unchanged");

    ok(await setMacroActions({ macroId: macro.id, actions: { status: "PENDING_CLIENT" } }));

    const audit = await prisma.auditLog.count({
      where: { requestId: hoisted.ctx.requestId, entityId: macro.id, fieldChanged: "actions" },
    });
    expect(audit).toBe(0);
  });

  it("refuses a blob the applier could not apply, and refuses a caller without macro:admin", async () => {
    const { setMacroActions, prisma } = mods();
    const macro = await newMacro(null, "refusals");

    const bad = await setMacroActions({
      macroId: macro.id,
      actions: { status: "VOIDED" } as unknown as MacroActions,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("VALIDATION");

    const before = hoisted.viewer;
    hoisted.viewer = viewerOf(OPS_ID, ["client_services"]);
    try {
      const denied = await setMacroActions({ macroId: macro.id, actions: { status: "OPEN" } });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.code).toBe("FORBIDDEN");
    } finally {
      hoisted.viewer = before;
    }

    const stored = await prisma.macro.findUniqueOrThrow({ where: { id: macro.id }, select: { actions: true } });
    expect(stored.actions).toBeNull();
  });
});
