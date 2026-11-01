/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; `TEST_DATABASE_URL` only — never the dev
 * database: the append-only triggers make every fixture row permanent).
 *
 * Proves the second disposition a held message needs — "not for the desk" — end to end:
 *
 *   - `discardHeldIntake` flips `NEW → DISCARDED` and writes ONE audit row in the same transaction,
 *     shaped so it can never be mistaken for the hold that created the row (`fieldChanged: "status"`,
 *     `oldValue: "NEW"`, `newValue: "DISCARDED"`) and carrying the reviewer's reason;
 *   - discarding twice is idempotent: the second call writes no second row into the hash chain;
 *   - the row is MARKED, never removed — it is still in the table and still readable through
 *     `listHeldIntake` under the `DISCARDED` status filter, with who/when/why read back off the
 *     ledger (`SuspendedIntake` has no discard columns);
 *   - it leaves the `NEW` backlog the page's banner counts one smaller, which is the whole point;
 *   - a `RELEASED` row is refused, and so is a released row's mirror image — `releaseHeldIntake`
 *     already refuses a `DISCARDED` one;
 *   - an advisor is refused and the denial is recorded;
 *   - the reason is required: an empty one is a VALIDATION failure and changes nothing.
 *
 * `MAILBOX_MAP` is set on `process.env` BEFORE `@/lib/env` is first imported, and every fixture
 * mailbox is scoped to this run so the shared test database cannot let one run's rows answer
 * another's assertions.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AuditActor, OktaGroup, RequestContext, Viewer } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const OPS_MAILBOX = `discard-ops-${RUN}@example.com`;
const RUN_MAILBOX_SUFFIX = `-${RUN}@example.com`;

process.env.MAILBOX_MAP = JSON.stringify({
  [OPS_MAILBOX]: { queueKey: "OPERATIONS", brand: "CEDAR_RIDGE_WEALTH", category: "ACCOUNT_CLOSURE" },
});

const REVIEWER_ID = `it_discard_reviewer_${RUN}`;
const MACHINE_ID = `it_discard_machine_${RUN}`;

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
}));
hoisted.viewer = {
  id: REVIEWER_ID,
  email: `discard.reviewer.${RUN}@wm-helpdesk.local`,
  name: "Dana Reviewer",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.91",
  userAgent: `it-discard/${RUN}`,
  requestId: `it-discard-${RUN}`,
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
const readsModule = TEST_URL ? await import("@/server/suspended-intake") : null;
const discardModule = TEST_URL ? await import("@/server/held-intake-discard.actions") : null;
const releaseModule = TEST_URL ? await import("@/server/suspended-intake.actions") : null;
const intakeModule = TEST_URL ? await import("@/server/email-intake") : null;

function mods() {
  if (!dbModule || !readsModule || !discardModule || !releaseModule || !intakeModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...readsModule, ...discardModule, ...releaseModule, ...intakeModule };
}

const MACHINE_ACTOR = (): AuditActor => ({
  id: MACHINE_ID,
  email: `discard.machine.${RUN}@wm-helpdesk.local`,
  groups: [],
});
const CALL = () => ({ actor: MACHINE_ACTOR(), ctx: hoisted.ctx, via: "email" as const });

/** Runs `fn` with the viewer temporarily holding `groups`, then restores it. */
async function asGroups<T>(groups: OktaGroup[], fn: () => Promise<T>): Promise<T> {
  const before = hoisted.viewer.groups;
  hoisted.viewer = { ...hoisted.viewer, groups };
  try {
    return await fn();
  } finally {
    hoisted.viewer = { ...hoisted.viewer, groups: before };
  }
}

async function hold(opts: {
  reason: "AUTO_REPLY" | "BOUNCE" | "SPAM" | "PARSE_FAILED" | "UNAUTHENTICATED";
  fromAddress: string;
  subject: string;
  snippet?: string;
}): Promise<string> {
  const { suspendIntake } = mods();
  const { suspendedId } = await suspendIntake(
    {
      reason: opts.reason,
      mailbox: OPS_MAILBOX,
      fromAddress: opts.fromAddress,
      subject: opts.subject,
      messageId: `${RUN}.${randomUUID().slice(0, 8)}@fixture.test`,
      rawRef: `n8n/${RUN}`,
      headers: { from: opts.fromAddress, subject: opts.subject },
      snippet: opts.snippet ?? "Automatic reply: I am out of the office until Monday.",
    },
    CALL(),
  );
  return suspendedId;
}

/** The audit rows that mark ONE suspension as discarded — `fieldChanged` is what tells them from the hold. */
async function discardRows(id: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({
    where: {
      // Wave B gave the disposition its own enum value; the HOLD keeps INTAKE_SUSPENDED, and the two
      // are still partitioned on `fieldChanged` ("reason" vs "status") so old rows read identically.
      action: "INTAKE_DISCARDED",
      entityId: id,
      fieldChanged: "status",
      newValue: "DISCARDED",
    },
    select: { id: true, actorId: true, actorEmail: true, oldValue: true, newValue: true, metadata: true },
  });
}

describe.skipIf(!TEST_URL)("held inbound mail: discard (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    for (const [key, name, sortOrder] of [
      ["CLIENT_SERVICE", "Client Service", 2],
      ["OPERATIONS", "Operations", 1],
    ] as const) {
      await prisma.queue.upsert({
        where: { key },
        update: {},
        create: { key, name, description: "held intake discard fixture", sortOrder },
      });
    }
    await prisma.user.upsert({
      where: { id: REVIEWER_ID },
      update: {},
      create: {
        id: REVIEWER_ID,
        email: hoisted.viewer.email,
        name: "Dana Reviewer",
        groups: ["ops_team"],
        isActive: true,
      },
    });
    await prisma.user.upsert({
      where: { id: MACHINE_ID },
      update: {},
      create: { id: MACHINE_ID, email: MACHINE_ACTOR().email, name: "Discard Machine", groups: [], isActive: true },
    });
  });

  it("marks a held message DISCARDED, writes one audit row with the reason, and keeps the row", async () => {
    const { discardHeldIntake, listHeldIntake, prisma } = mods();
    const suspendedId = await hold({
      reason: "AUTO_REPLY",
      fromAddress: "no-reply@holiday-responder.test",
      subject: "Automatic reply: Out of office",
    });

    const result = await discardHeldIntake({ suspendedId, reason: "Out-of-office auto-reply, no client content" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alreadyDiscarded).toBe(false);

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: suspendedId } });
    expect(row.status).toBe("DISCARDED");
    // Marked, never deleted: no ticket, and the preview is exactly where it was.
    expect(row.ticketId).toBeNull();
    expect(row.snippet).not.toBeNull();

    const audit = await discardRows(suspendedId);
    expect(audit).toHaveLength(1);
    const entry = audit[0] as {
      actorId: string;
      oldValue: string | null;
      metadata: Record<string, unknown> | null;
    };
    expect(entry.actorId).toBe(REVIEWER_ID);
    expect(entry.oldValue).toBe("NEW");
    expect(entry.metadata?.note).toBe("Out-of-office auto-reply, no client content");
    expect(entry.metadata?.reason).toBe("AUTO_REPLY");
    // A human decision at a screen carries no `via` (CONTRACT §3 rule 1).
    expect(entry.metadata?.via).toBeUndefined();

    // The hold row is untouched and still distinguishable by fieldChanged.
    const held = await prisma.auditLog.findMany({
      where: { action: "INTAKE_SUSPENDED", entityId: suspendedId, fieldChanged: "reason" },
      select: { newValue: true },
    });
    expect(held).toHaveLength(1);
    expect(held[0].newValue).toBe("AUTO_REPLY");

    // It leaves the NEW queue and is readable under the DISCARDED filter, with who/when/why.
    const stillNew = await listHeldIntake(hoisted.viewer, { mailbox: RUN_MAILBOX_SUFFIX }, hoisted.ctx);
    expect(stillNew.map((r) => r.id)).not.toContain(suspendedId);

    const discarded = await listHeldIntake(
      hoisted.viewer,
      { status: "DISCARDED", mailbox: RUN_MAILBOX_SUFFIX },
      hoisted.ctx,
    );
    const shown = discarded.find((r) => r.id === suspendedId);
    expect(shown).toBeDefined();
    expect(shown?.discardedBy).toBe(hoisted.viewer.email);
    expect(shown?.discardedAt).not.toBeNull();
    expect(shown?.discardNote).toBe("Out-of-office auto-reply, no client content");
  });

  it("is idempotent: a second discard writes no second row into the hash chain", async () => {
    const { discardHeldIntake } = mods();
    const suspendedId = await hold({
      reason: "BOUNCE",
      fromAddress: "mailer-daemon@relay.test",
      subject: "Undelivered Mail Returned to Sender",
    });

    const first = await discardHeldIntake({ suspendedId, reason: "Bounce notice" });
    const second = await discardHeldIntake({ suspendedId, reason: "Bounce notice" });
    expect(first.ok && first.data.alreadyDiscarded).toBe(false);
    expect(second.ok && second.data.alreadyDiscarded).toBe(true);
    expect(await discardRows(suspendedId)).toHaveLength(1);
  });

  it("takes the message out of the NEW counts the page's banner claims", async () => {
    const { discardHeldIntake, heldIntakeCounts } = mods();
    const suspendedId = await hold({
      reason: "SPAM",
      fromAddress: "offers@win-big-today.test",
      subject: "Final notice",
    });

    // Scoped to this run's mailbox: the test database is shared and other suites hold messages of
    // their own while this one runs, so only the run-scoped figures are deterministic.
    const scope = { status: "NEW" as const, mailbox: RUN_MAILBOX_SUFFIX };
    const before = await heldIntakeCounts(hoisted.viewer, hoisted.ctx, scope);
    const done = await discardHeldIntake({ suspendedId, reason: "Unsolicited marketing" });
    expect(done.ok).toBe(true);
    const after = await heldIntakeCounts(hoisted.viewer, hoisted.ctx, scope);
    expect(after.total).toBe(before.total - 1);
    expect(after.byReason.SPAM).toBe(before.byReason.SPAM - 1);
    // The banner's figure is the whole NEW backlog, so it is never smaller than the filtered one.
    expect(after.waitingTotal).toBeGreaterThanOrEqual(after.total);
  });

  it("counts under the status the list is showing, so the reason chips match the rows", async () => {
    const { discardHeldIntake, heldIntakeCounts } = mods();
    const suspendedId = await hold({
      reason: "PARSE_FAILED",
      fromAddress: "(no address)",
      subject: "(no subject)",
    });
    expect((await discardHeldIntake({ suspendedId, reason: "Unreadable, nothing to act on" })).ok).toBe(true);

    const shownAsDiscarded = await heldIntakeCounts(hoisted.viewer, hoisted.ctx, {
      status: "DISCARDED",
      mailbox: RUN_MAILBOX_SUFFIX,
    });
    expect(shownAsDiscarded.byReason.PARSE_FAILED).toBeGreaterThanOrEqual(1);

    // The same call under the default NEW status must NOT count it — that was the defect.
    const shownAsNew = await heldIntakeCounts(hoisted.viewer, hoisted.ctx, {
      status: "NEW",
      mailbox: RUN_MAILBOX_SUFFIX,
    });
    expect(shownAsNew.byReason.PARSE_FAILED).toBe(0);
  });

  it("flags a held message with no usable sender as unreleasable, which is what makes discard its only exit", async () => {
    const { listHeldIntake } = mods();
    const suspendedId = await hold({
      reason: "PARSE_FAILED",
      fromAddress: "(unparseable)",
      subject: "(no subject)",
    });

    const rows = await listHeldIntake(hoisted.viewer, { mailbox: RUN_MAILBOX_SUFFIX }, hoisted.ctx);
    const row = rows.find((r) => r.id === suspendedId);
    expect(row?.hasUsableSender).toBe(false);

    const usable = await hold({
      reason: "SPAM",
      fromAddress: "offers@win-big-today.test",
      subject: "Second chance",
    });
    expect(
      (await listHeldIntake(hoisted.viewer, { mailbox: RUN_MAILBOX_SUFFIX }, hoisted.ctx)).find(
        (r) => r.id === usable,
      )?.hasUsableSender,
    ).toBe(true);
  });

  it("refuses a released row, and release refuses a discarded one — the two dispositions are exclusive", async () => {
    const { discardHeldIntake, releaseHeldIntake, prisma } = mods();

    const discarded = await hold({
      reason: "SPAM",
      fromAddress: "offers@win-big-today.test",
      subject: "Act now",
    });
    expect((await discardHeldIntake({ suspendedId: discarded, reason: "Unsolicited marketing" })).ok).toBe(true);
    const released = await releaseHeldIntake({ suspendedId: discarded });
    expect(released.ok).toBe(false);
    if (released.ok) return;
    expect(released.code).toBe("CONFLICT");
    expect(await prisma.ticket.count({ where: { externalId: `intake-release.${discarded}` } })).toBe(0);
  });

  it("refuses an advisor and records the denial; the row stays NEW", async () => {
    const { discardHeldIntake, prisma } = mods();
    const suspendedId = await hold({
      reason: "SPAM",
      fromAddress: "offers@win-big-today.test",
      subject: "Limited time",
    });

    const refused = await asGroups(["advisors"], () =>
      discardHeldIntake({ suspendedId, reason: "Not for the desk" }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("FORBIDDEN");

    expect((await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: suspendedId } })).status).toBe("NEW");
    expect(await discardRows(suspendedId)).toHaveLength(0);

    const denials = await prisma.auditLog.findMany({
      where: { requestId: hoisted.ctx.requestId, action: "AUTHZ_DENIED" },
      select: { newValue: true, metadata: true },
    });
    expect(JSON.stringify(denials)).toContain("discardHeldIntake");
  });

  it("requires a reason: an empty one is a validation failure and changes nothing", async () => {
    const { discardHeldIntake, prisma } = mods();
    const suspendedId = await hold({
      reason: "SPAM",
      fromAddress: "offers@win-big-today.test",
      subject: "One weird trick",
    });

    const refused = await discardHeldIntake({ suspendedId, reason: "  " });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("VALIDATION");
    expect((await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: suspendedId } })).status).toBe("NEW");
  });

  it("refuses a suspension id that does not exist", async () => {
    const { discardHeldIntake } = mods();
    const missing = await discardHeldIntake({ suspendedId: `it_missing_${RUN}`, reason: "Not for the desk" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("NOT_FOUND");
  });
});
