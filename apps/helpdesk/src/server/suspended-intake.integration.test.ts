/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; `TEST_DATABASE_URL` only — never the dev
 * database: the append-only triggers make every fixture row permanent).
 *
 * Proves the held-mail review surface end to end (CONTRACT §3 `INTAKE_RELEASED`):
 *
 *   - `listHeldIntake` returns NEW rows newest-first and carries the ledger's `metadata.detail`, so
 *     a message held because its sender is not the thread's client is distinguishable from a DMARC
 *     failure even though both share the `UNAUTHENTICATED` reason;
 *   - `listHeldIntakePage` walks the WHOLE matched set through its keyset cursor — no skipped row, no
 *     repeated row, and a `total` that counts past the page size. Nothing in `SuspendedIntake` is ever
 *     deleted, so the list outgrows one page permanently and a truncating read hid the OLDEST held
 *     messages, which is the opposite of what this surface exists for;
 *   - the capability gate: `ops_team` and `compliance_officers` may read, an advisor may not, and the
 *     denial is written as `AUTHZ_DENIED`;
 *   - `releaseHeldIntake` creates the ticket, flips `NEW → RELEASED` with the ticket, the releaser
 *     and the timestamp, and writes ONE `INTAKE_RELEASED` row carrying the ticket id;
 *   - releasing twice returns the SAME ticket and writes no second row (the conditional flip);
 *   - compliance, which holds no queue WRITE, is refused the release and the row stays NEW;
 *   - a message from an unmapped mailbox refuses to be released until a queue is named.
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
const OPS_MAILBOX = `ops-${RUN}@example.com`;
const CS_MAILBOX = `cs-${RUN}@example.com`;
const STRAY_MAILBOX = `careers-${RUN}@example.com`;
/** Its own mailbox so the pager walks an EXACT, known set of rows and nothing else in the run. */
const PAGER_MAILBOX = `pager-${RUN}@example.com`;
/**
 * The counts test gets its own mailbox too, and for a sharper reason than tidiness: the figures it
 * asserts on are COUNTS, and an unscoped count is a reading of the whole shared table. Sibling files
 * hold and discard messages of their own while this one runs — `held-intake-discard` flips a SPAM row
 * out of NEW — so a global before/after delta is a race, not an assertion. Scoped to a mailbox nothing
 * else in the database touches, the delta is exact.
 */
const COUNTS_MAILBOX = `counts-${RUN}@example.com`;
const RUN_MAILBOX_SUFFIX = `-${RUN}@example.com`;

process.env.MAILBOX_MAP = JSON.stringify({
  [OPS_MAILBOX]: { queueKey: "OPERATIONS", brand: "CEDAR_RIDGE_WEALTH", category: "ACCOUNT_CLOSURE" },
  [CS_MAILBOX]: { queueKey: "CLIENT_SERVICE", brand: "CEDAR_RIDGE_WEALTH" },
});

const REVIEWER_ID = `it_intake_reviewer_${RUN}`;
const MACHINE_ID = `it_intake_machine_${RUN}`;

const hoisted = vi.hoisted(() => ({
  viewer: null as unknown as Viewer,
  ctx: null as unknown as RequestContext,
}));
hoisted.viewer = {
  id: REVIEWER_ID,
  email: `intake.reviewer.${RUN}@wm-helpdesk.local`,
  name: "Rhea Reviewer",
  image: null,
  groups: ["ops_team"],
  isDev: false,
};
hoisted.ctx = {
  ipAddress: "203.0.113.77",
  userAgent: `it-intake/${RUN}`,
  requestId: `it-intake-${RUN}`,
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
const actionsModule = TEST_URL ? await import("@/server/suspended-intake.actions") : null;
const intakeModule = TEST_URL ? await import("@/server/email-intake") : null;
/** the released ticket is fed through the REAL client DTO builder, below. */
const clientViewModule = TEST_URL ? await import("@/server/client-view") : null;

function mods() {
  if (!dbModule || !readsModule || !actionsModule || !intakeModule || !clientViewModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return {
    ...dbModule,
    ...readsModule,
    ...actionsModule,
    ...intakeModule,
    toClientTicketView: clientViewModule.toClientTicketView,
    assertNoInternalLeak: clientViewModule.assertNoInternalLeak,
    // Decision #117 (amended): the opening entry is READ, from the "ClientVisibleOpeningMessage" view,
    // so the two tests below now exercise the gate where it is enforced instead of re-stating it.
    selectOpeningMessage: clientViewModule.selectOpeningMessage,
  };
}

const MACHINE_ACTOR = (): AuditActor => ({
  id: MACHINE_ID,
  email: `intake.machine.${RUN}@wm-helpdesk.local`,
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

/** A DMARC-pass verdict from the trusted authserv-id, in the shape the inbound corpus uses. */
function authPass(from: string): string {
  const domain = from.slice(from.lastIndexOf("@") + 1);
  return (
    `mx.google.com; spf=pass (google.com: domain of ${from} designates 209.85.220.41 as permitted sender) ` +
    `smtp.mailfrom=${from}; dkim=pass header.i=@${domain} header.s=20230601 header.b=Qj7bKq2p; ` +
    `dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`
  );
}

async function hold(opts: {
  reason: "UNAUTHENTICATED" | "UNKNOWN_MAILBOX" | "SPAM";
  mailbox: string;
  fromAddress: string;
  subject: string;
  snippet?: string;
  detail?: string;
  /**
   * The sender-authentication verdict the hold records beside the reason. Omitted means the ledger
   * carries no verdict — which is what a row written before the fix looks like, and the case
   * `heldIntakeSenderVerified` must keep deciding on the reason alone.
   */
  senderVerified?: boolean;
}): Promise<string> {
  const { suspendIntake } = mods();
  const { suspendedId } = await suspendIntake(
    {
      reason: opts.reason,
      mailbox: opts.mailbox,
      fromAddress: opts.fromAddress,
      subject: opts.subject,
      messageId: `${RUN}.${randomUUID().slice(0, 8)}@fixture.test`,
      rawRef: `n8n/${RUN}`,
      headers: { from: opts.fromAddress, subject: opts.subject },
      snippet: opts.snippet ?? "Please move the quarterly distribution to my other account.",
      detail: opts.detail ?? null,
      ...(opts.senderVerified === undefined ? {} : { senderVerified: opts.senderVerified }),
    },
    CALL(),
  );
  return suspendedId;
}

describe.skipIf(!TEST_URL)("held inbound mail: review and release (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    for (const [key, name, sortOrder] of [
      ["CLIENT_SERVICE", "Client Service", 2],
      ["OPERATIONS", "Operations", 1],
    ] as const) {
      await prisma.queue.upsert({
        where: { key },
        update: {},
        create: { key, name, description: "held intake fixture", sortOrder },
      });
    }
    await prisma.user.upsert({
      where: { id: REVIEWER_ID },
      update: {},
      create: {
        id: REVIEWER_ID,
        email: hoisted.viewer.email,
        name: "Rhea Reviewer",
        groups: ["ops_team"],
        isActive: true,
      },
    });
    await prisma.user.upsert({
      where: { id: MACHINE_ID },
      update: {},
      create: { id: MACHINE_ID, email: MACHINE_ACTOR().email, name: "Intake Machine", groups: [], isActive: true },
    });
  });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  it("lists held messages newest-first and carries the ledger's detail onto the row", async () => {
    const { listHeldIntake } = mods();
    const older = await hold({
      reason: "SPAM",
      mailbox: OPS_MAILBOX,
      fromAddress: "offers@win-big-today.test",
      subject: "You have won",
    });
    const newer = await hold({
      reason: "UNAUTHENTICATED",
      mailbox: OPS_MAILBOX,
      fromAddress: "colin.mabry@driftwood.test",
      subject: "Re: [HD-1] wire instructions",
      detail: "SENDER_MISMATCH",
    });

    const rows = await listHeldIntake(hoisted.viewer, { mailbox: RUN_MAILBOX_SUFFIX }, hoisted.ctx);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(older);
    expect(ids).toContain(newer);
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));

    const mismatch = rows.find((r) => r.id === newer);
    expect(mismatch?.detail).toBe("SENDER_MISMATCH");
    expect(mismatch?.reason).toBe("UNAUTHENTICATED");
    expect(mismatch?.status).toBe("NEW");
    expect(mismatch?.ticketId).toBeNull();
    expect(mismatch?.snippet).not.toBeNull();
    expect(rows.find((r) => r.id === older)?.detail).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Hold-reason precedence: the review row and the release gate read the VERDICT,
  // not the reason
  // -------------------------------------------------------------------------

  it("marks a row unverified when the ledger recorded an authentication failure under another reason", async () => {
    const { listHeldIntake } = mods();
    // The finding, as a row: an unauthenticated message that also arrived on an unmapped address is
    // held as UNKNOWN_MAILBOX, and the reason alone would have rendered the benign
    // "not in the mailbox map" banner with no sender caution at all.
    const unverified = await hold({
      reason: "UNKNOWN_MAILBOX",
      mailbox: STRAY_MAILBOX,
      fromAddress: "treasury@cedar-ridgeweaIth.test",
      subject: "Updated wire instructions for my account",
      senderVerified: false,
    });
    const verified = await hold({
      reason: "UNKNOWN_MAILBOX",
      mailbox: STRAY_MAILBOX,
      fromAddress: "sana.iqbal@applicants.test",
      subject: "Application - client service associate",
      senderVerified: true,
    });
    // No verdict at all: a row written before the fix, which must keep reading exactly as it did.
    const legacy = await hold({
      reason: "UNKNOWN_MAILBOX",
      mailbox: STRAY_MAILBOX,
      fromAddress: "hello@vendor.test",
      subject: "Partnership enquiry",
    });

    const rows = await listHeldIntake(hoisted.viewer, { mailbox: RUN_MAILBOX_SUFFIX }, hoisted.ctx);
    expect(rows.find((r) => r.id === unverified)?.senderVerified).toBe(false);
    expect(rows.find((r) => r.id === verified)?.senderVerified).toBe(true);
    expect(rows.find((r) => r.id === legacy)?.senderVerified).toBe(true);
    // The reason is untouched — nothing is re-filed, the second fact simply travels with it.
    expect(rows.find((r) => r.id === unverified)?.reason).toBe("UNKNOWN_MAILBOX");
    // And an UNAUTHENTICATED row is still unverified with no verdict recorded.
    const dmarc = await hold({
      reason: "UNAUTHENTICATED",
      mailbox: OPS_MAILBOX,
      fromAddress: "someone@spoofed.test",
      subject: "Re: [HD-1] please wire",
    });
    const after = await listHeldIntake(hoisted.viewer, { mailbox: RUN_MAILBOX_SUFFIX }, hoisted.ctx);
    expect(after.find((r) => r.id === dmarc)?.senderVerified).toBe(false);
  });

  it("charges the unverified-sender acknowledgement on an UNKNOWN_MAILBOX row that failed authentication", async () => {
    const { prisma, releaseHeldIntake } = mods();
    const suspendedId = await hold({
      reason: "UNKNOWN_MAILBOX",
      mailbox: STRAY_MAILBOX,
      fromAddress: "Colin Mabry <colin.mabry@driftwood.test>",
      subject: "Please send the balance to my new bank",
      snippet: "Please send the balance to my new bank.",
      senderVerified: false,
    });

    // Before the fix this released straight through: no acknowledgement, no note, and a ticket with
    // nothing on it to say the sender was never proven.
    const refused = await releaseHeldIntake({ suspendedId, queueKey: "OPERATIONS" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("VALIDATION");
    expect(refused.fieldErrors?.confirmUnverifiedSender).toBeDefined();
    expect(refused.fieldErrors?.note).toBeDefined();
    expect(await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: suspendedId } })).toMatchObject({
      status: "NEW",
      ticketId: null,
    });

    // The acknowledgement alone is not enough either — the note carries the same floor.
    const short = await releaseHeldIntake({
      suspendedId,
      queueKey: "OPERATIONS",
      confirmUnverifiedSender: true,
      note: "ok",
    });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.code).toBe("VALIDATION");

    const released = await releaseHeldIntake({
      suspendedId,
      queueKey: "OPERATIONS",
      confirmUnverifiedSender: true,
      note: "Called Colin on the number already on file and confirmed",
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // The provenance survives onto the ticket, which is what the next person to work it reads.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: released.data.ticketId } });
    expect(ticket.description).toContain("SENDER NOT VERIFIED");
    expect(ticket.requesterEmail).toBe("colin.mabry@driftwood.test");

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "INTAKE_RELEASED", entityId: suspendedId },
      select: { metadata: true },
    });
    const metadata = audit.metadata as Record<string, unknown>;
    expect(metadata.senderVerified).toBe(false);
    expect(metadata.unverifiedSenderConfirmed).toBe(true);
  });

  it("still releases an UNKNOWN_MAILBOX row whose sender DID authenticate without the acknowledgement", async () => {
    const { prisma, releaseHeldIntake } = mods();
    const suspendedId = await hold({
      reason: "UNKNOWN_MAILBOX",
      mailbox: STRAY_MAILBOX,
      fromAddress: "priya.raman@fidelity.test",
      subject: "Statement copy for 2025",
      senderVerified: true,
    });

    const released = await releaseHeldIntake({ suspendedId, queueKey: "OPERATIONS" });
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: released.data.ticketId } });
    expect(ticket.description).not.toContain("SENDER NOT VERIFIED");
  });

  it("counts NEW held messages by reason", async () => {
    const { heldIntakeCounts } = mods();
    // Scoped to a mailbox only this test writes to, so every delta below is an EQUALITY. The earlier
    // `>=` form read the whole table, which a sibling file moves underneath it (discarding or
    // releasing a SPAM row takes it out of NEW between the two reads) — the assertion passed on a
    // clean database and raced on an accumulated one.
    const scope = { status: "NEW" as const, mailbox: COUNTS_MAILBOX };
    const before = await heldIntakeCounts(hoisted.viewer, hoisted.ctx, scope);
    expect(before.total).toBe(0);

    await hold({
      reason: "SPAM",
      mailbox: COUNTS_MAILBOX,
      fromAddress: "offers@win-big-today.test",
      subject: "Second chance",
    });
    const afterSpam = await heldIntakeCounts(hoisted.viewer, hoisted.ctx, scope);
    expect(afterSpam.byReason.SPAM).toBe(before.byReason.SPAM + 1);
    expect(afterSpam.total).toBe(before.total + 1);

    // A second hold under a DIFFERENT reason moves that reason's chip and the total, and leaves the
    // first chip exactly where it was — the grouping key is the reason, not the row.
    await hold({
      reason: "UNAUTHENTICATED",
      mailbox: COUNTS_MAILBOX,
      fromAddress: "treasury@cedar-ridgewea1th.test",
      subject: "Wire instructions changed",
    });
    const afterBoth = await heldIntakeCounts(hoisted.viewer, hoisted.ctx, scope);
    expect(afterBoth.byReason.SPAM).toBe(afterSpam.byReason.SPAM);
    expect(afterBoth.byReason.UNAUTHENTICATED).toBe(afterSpam.byReason.UNAUTHENTICATED + 1);
    expect(afterBoth.total).toBe(afterSpam.total + 1);
    // Nothing else lands in this mailbox, so the scoped total IS the two rows this test held.
    expect(afterBoth.total).toBe(2);

    // The banner's figures still count the WHOLE NEW backlog rather than the filter — which is the
    // reason they cannot be asserted exactly here, and the only safe claim about a shared table: the
    // backlog is never smaller than a subset of itself.
    expect(afterBoth.waitingTotal).toBeGreaterThanOrEqual(afterBoth.total);
    expect(afterBoth.waitingUnauthenticated).toBeGreaterThanOrEqual(afterBoth.byReason.UNAUTHENTICATED);
  });

  it("pages the whole matched set through the cursor: every row once, oldest included", async () => {
    const { listHeldIntakePage } = mods();

    // Five held messages on a mailbox nothing else in this run touches.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await hold({
          reason: "UNKNOWN_MAILBOX",
          mailbox: PAGER_MAILBOX,
          fromAddress: `pager.${i}@clients.test`,
          subject: `Pager fixture ${i}`,
        }),
      );
    }
    const oldest = ids[0];

    const filter = { mailbox: PAGER_MAILBOX } as const;
    const whole = await listHeldIntakePage(hoisted.viewer, { ...filter, limit: 50 }, hoisted.ctx);
    expect(whole.total).toBe(5);
    expect(whole.rows).toHaveLength(5);
    expect(whole.nextCursor).toBeNull();

    // Two at a time, following the cursor exactly as "Load more" does.
    const walked: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await listHeldIntakePage(hoisted.viewer, { ...filter, limit: 2, cursor }, hoisted.ctx);
      pages += 1;
      // The total is the whole filter, not the page — the figure the footer prints — and it does NOT
      // shrink as the reviewer pages, which would read as messages leaving the table.
      expect(page.total).toBe(5);
      expect(page.rows.length).toBeLessThanOrEqual(2);
      walked.push(...page.rows.map((r) => r.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10); // a cursor that never terminates is the bug this guards
    }

    expect(pages).toBe(3);
    expect(walked).toHaveLength(5);
    expect(new Set(walked).size).toBe(5); // no row returned twice
    // The pages, concatenated, are the single-page read in the same order — so nothing was skipped and
    // the OLDEST message (the one a 100-row truncation used to hide) is reachable.
    expect(walked).toEqual(whole.rows.map((r) => r.id));
    expect(walked[walked.length - 1]).toBe(oldest);
  });

  it("ignores a cursor it did not write instead of erroring over the queue", async () => {
    const { listHeldIntakePage } = mods();
    const top = await listHeldIntakePage(hoisted.viewer, { mailbox: PAGER_MAILBOX, limit: 2 }, hoisted.ctx);
    const garbage = await listHeldIntakePage(
      hoisted.viewer,
      { mailbox: PAGER_MAILBOX, limit: 2, cursor: "not-a-cursor" },
      hoisted.ctx,
    );
    expect(garbage.rows.map((r) => r.id)).toEqual(top.rows.map((r) => r.id));
    expect(garbage.total).toBe(top.total);
  });

  it("counts the total under the reason filter too, so the footer cannot over-claim", async () => {
    const { listHeldIntakePage } = mods();
    await hold({
      reason: "SPAM",
      mailbox: PAGER_MAILBOX,
      fromAddress: "offers@win-big-today.test",
      subject: "Pager spam fixture",
    });
    const all = await listHeldIntakePage(hoisted.viewer, { mailbox: PAGER_MAILBOX, limit: 50 }, hoisted.ctx);
    const spam = await listHeldIntakePage(
      hoisted.viewer,
      { mailbox: PAGER_MAILBOX, reason: "SPAM", limit: 50 },
      hoisted.ctx,
    );
    expect(all.total).toBe(6);
    expect(spam.total).toBe(1);
    expect(spam.rows).toHaveLength(1);
    expect(spam.rows[0].reason).toBe("SPAM");
  });

  it("gates the paged read on the same capability as the row read", async () => {
    const { listHeldIntakePage } = mods();
    await expect(
      asGroups(["advisors"], () => listHeldIntakePage(hoisted.viewer, { mailbox: PAGER_MAILBOX }, hoisted.ctx)),
    ).rejects.toThrow(/Forbidden/);
  });

  it("lets compliance read held mail, refuses an advisor, and records the denial", async () => {
    const { listHeldIntake, prisma } = mods();

    await expect(
      asGroups(["compliance_officers"], () => listHeldIntake(hoisted.viewer, { mailbox: RUN_MAILBOX_SUFFIX }, hoisted.ctx)),
    ).resolves.toBeInstanceOf(Array);

    await expect(
      asGroups(["advisors"], () => listHeldIntake(hoisted.viewer, {}, hoisted.ctx)),
    ).rejects.toThrow(/Forbidden/);

    const denials = await prisma.auditLog.findMany({
      where: { requestId: hoisted.ctx.requestId, action: "AUTHZ_DENIED" },
      select: { newValue: true, metadata: true },
    });
    expect(JSON.stringify(denials)).toContain("intake:review");
  });

  // -------------------------------------------------------------------------
  // Release
  // -------------------------------------------------------------------------

  it("releases a held message into a ticket in the mailbox's queue and writes INTAKE_RELEASED once", async () => {
    const { prisma, releaseHeldIntake } = mods();
    const suspendedId = await hold({
      reason: "UNAUTHENTICATED",
      mailbox: OPS_MAILBOX,
      fromAddress: "Tomas Berg <tomas.berg@fidelity.test>",
      subject: "Please close my account",
      snippet: "I would like to close the joint account.",
      detail: "SENDER_MISMATCH",
    });

    const result = await releaseHeldIntake({
      suspendedId,
      note: "Called Tomas back and confirmed",
      confirmUnverifiedSender: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.alreadyReleased).toBe(false);

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: result.data.ticketId },
      include: { queue: { select: { key: true } } },
    });
    expect(ticket.queue.key).toBe("OPERATIONS");
    expect(ticket.source).toBe("EMAIL");
    expect(ticket.requesterEmail).toBe("tomas.berg@fidelity.test");
    expect(ticket.externalId).toBe(`intake-release.${suspendedId}`);
    expect(ticket.description).toContain("I would like to close the joint account.");
    expect(ticket.description).toContain("Released from held inbound mail.");
    expect(ticket.description).toContain("UNAUTHENTICATED");
    expect(ticket.description).toContain("Called Tomas back and confirmed");

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: suspendedId } });
    expect(row.status).toBe("RELEASED");
    expect(row.ticketId).toBe(result.data.ticketId);
    expect(row.releasedById).toBe(REVIEWER_ID);
    expect(row.releasedAt).not.toBeNull();

    const released = await prisma.auditLog.findMany({
      where: { action: "INTAKE_RELEASED", entityId: suspendedId },
      select: {
        entityType: true,
        ticketId: true,
        fieldChanged: true,
        oldValue: true,
        newValue: true,
        actorId: true,
        metadata: true,
      },
    });
    expect(released).toHaveLength(1);
    expect(released[0].entityType).toBe("SUSPENDED_INTAKE");
    expect(released[0].ticketId).toBe(result.data.ticketId);
    expect(released[0].oldValue).toBe("NEW");
    expect(released[0].newValue).toBe("RELEASED");
    expect(released[0].actorId).toBe(REVIEWER_ID);
    // §3 rule 1: a human did this, so the row carries the CHANNEL but no `via`.
    const meta = released[0].metadata as Record<string, unknown>;
    expect(meta.via).toBeUndefined();
    expect(meta.source).toBe("EMAIL");
    expect(meta.senderVerified).toBe(false);
    expect(meta.unverifiedSenderConfirmed).toBe(true);

    // Releasing again is idempotent: the same ticket, no second ledger row.
    const again = await releaseHeldIntake({ suspendedId });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.ticketId).toBe(result.data.ticketId);
    expect(again.data.alreadyReleased).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "INTAKE_RELEASED", entityId: suspendedId } })).toBe(1);
  });

  /**
   * Decision #117, and the reason the opening entry needs a SECOND gate.
   *
   * A released hold is the one path that writes a DESK-COMPOSED body under `source: EMAIL`. The source
   * allowlist alone would therefore have returned this whole field to the client as the first entry of
   * their own thread, attributed to them as "You": the hold reason, the internal mailbox, the address
   * the message claimed to come from, the Message-ID, the raw-message pointer, the "verify the sender
   * out of band" instruction and the REVIEWER'S NOTE. `sanitizePII` does not touch any of it — it
   * redacts SSN, card and account numbers only.
   *
   * The fixture is deliberately NOT a hand-written EMAIL body: it is whatever `releaseDescription`
   * really produced a moment ago, read back off the row, so this test keeps working on the real
   * composer rather than on somebody's memory of it.
   */
  it("withholds a RELEASED hold from the client's thread — the desk's review material is never the client's message (I1, Decision #117)", async () => {
    const { prisma, releaseHeldIntake, toClientTicketView, assertNoInternalLeak, selectOpeningMessage } = mods();
    const suspendedId = await hold({
      reason: "UNAUTHENTICATED",
      mailbox: OPS_MAILBOX,
      fromAddress: "Nadia Okafor <nadia.okafor@fidelity.test>",
      subject: "Wire the balance out today",
      snippet: "Please wire the whole balance to my new account.",
      detail: "SENDER_MISMATCH",
    });

    const result = await releaseHeldIntake({
      suspendedId,
      note: "REVIEWER_NOTE_SENTINEL_5d2c — called Nadia on file and confirmed",
      confirmUnverifiedSender: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: result.data.ticketId },
      select: {
        id: true,
        number: true,
        subject: true,
        status: true,
        priority: true,
        category: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
        source: true,
        description: true,
        externalId: true,
      },
    });

    // The preconditions that make this the dangerous case: an allowlisted source carrying a body the
    // desk wrote. If either stops being true the test below stops proving anything, so assert both.
    expect(ticket.source).toBe("EMAIL");
    expect(ticket.externalId).toBe(`intake-release.${suspendedId}`);
    for (const marker of [
      "Released from held inbound mail.",
      "UNAUTHENTICATED",
      OPS_MAILBOX,
      "nadia.okafor@fidelity.test",
      "SENDER NOT VERIFIED",
      "REVIEWER_NOTE_SENTINEL_5d2c",
    ]) {
      expect(ticket.description, `stored description should carry ${marker}`).toContain(marker);
    }

    // The client payload, built by the real builder from the real row — and the opening entry read
    // from the real view, which is where the gate now lives. The DATABASE is what withholds it: the
    // released ticket has no row in "ClientVisibleOpeningMessage" at all.
    const opening = await selectOpeningMessage(ticket.id);
    expect(opening, "a released held-mail ticket must have no row in the view").toBeNull();
    const view = toClientTicketView(ticket, [], opening);
    expect(view.messages).toEqual([]);

    // VALUE-level, not key-level: `assertNoInternalLeak` walks KEYS, and this text would have arrived
    // under `messages[].body`, a legitimate key. Every sentinel the composer emits is checked by name.
    const payload = JSON.stringify(view);
    for (const marker of [
      "Released from held inbound mail.",
      "Held because",
      "UNAUTHENTICATED",
      OPS_MAILBOX,
      "nadia.okafor@fidelity.test",
      "Message-ID",
      "Raw message reference",
      "SENDER NOT VERIFIED",
      "Reviewer note",
      "REVIEWER_NOTE_SENTINEL_5d2c",
      "Please wire the whole balance to my new account.",
    ]) {
      expect(payload, `client payload must not contain ${marker}`).not.toContain(marker);
    }
    expect(() => assertNoInternalLeak(view)).not.toThrow();
  });

  it("an ORDINARY emailed ticket still shows the client their own message — the gate is the release marker, not the channel (Decision #117)", async () => {
    const { prisma, toClientTicketView, selectOpeningMessage } = mods();
    // Same source, same shape, no release marker: the control that proves the test above is not simply
    // asserting that EMAIL never shows anything.
    const released = await prisma.ticket.findFirstOrThrow({
      where: { externalId: { startsWith: "intake-release." } },
      select: { queueId: true, createdById: true },
      orderBy: { createdAt: "desc" },
    });
    const own = "CLIENT_OWN_WORDS_INTAKE_CONTROL — I have not heard back about the wire.";
    const plain = await prisma.ticket.create({
      data: {
        subject: "Wire status",
        description: own,
        source: "EMAIL",
        externalId: `plain-email.${RUN}`,
        requesterName: "Nadia Okafor",
        requesterEmail: "nadia.okafor@fidelity.test",
        category: "WIRE_TRANSFER",
        priority: "HIGH",
        status: "OPEN",
        queueId: released.queueId,
        createdById: released.createdById,
        slaFirstResponseMinutes: 60,
        slaResolutionMinutes: 480,
        firstResponseDueAt: new Date(Date.now() + 60 * 60_000),
        resolutionDueAt: new Date(Date.now() + 480 * 60_000),
      },
      select: {
        id: true,
        number: true,
        subject: true,
        status: true,
        priority: true,
        category: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
        source: true,
        description: true,
        externalId: true,
      },
    });

    const opening = await selectOpeningMessage(plain.id);
    expect(opening, "an ordinary emailed ticket must have a row in the view").not.toBeNull();
    const view = toClientTicketView(plain, [], opening);
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0].body).toBe(own);
    expect(view.messages[0].authorDisplay).toBe("You");
  });


  // Releasing against the candidate is the ONE release that knows the requester's real name: it was
  // written in the forwarded block the candidate address itself was parsed out of. Deriving the name
  // from the address instead — which is stored lower-cased, because an address is case-insensitive —
  // put "marla <run>" on a client-facing ticket while "Marla Whitfield" sat on the held row.
  it("releases a forward against the candidate under the client's OWN name, not one derived from the address", async () => {
    const { prisma, ingestInboundEmail, parseInboundEmail, releaseHeldIntake } = mods();
    const forwarderId = `it_intake_forwarder_${RUN}`;
    const forwarderEmail = `advisor.${RUN}@example.com`;
    const clientEmail = `marla.${RUN}@fastmail.test`;
    // `resolveForwardedRelease` rests on the forwarder being an ACTIVE member of staff.
    await prisma.user.upsert({
      where: { id: forwarderId },
      update: {},
      create: { id: forwarderId, email: forwarderEmail, name: "Dean Okonkwo", groups: [], isActive: true },
    });

    const held = await ingestInboundEmail(
      parseInboundEmail({
        mailbox: OPS_MAILBOX,
        messageId: `${RUN}.candidate-release@example.com`,
        from: `Dean Okonkwo <${forwarderEmail}>`,
        subject: "Fwd: Wire not received",
        textBody: [
          "Marla sent this to me directly — can the desk pick it up?",
          "",
          "---------- Forwarded message ---------",
          `From: Marla Whitfield <${clientEmail}>`,
          "Date: Fri, 18 Sep 2026 at 09:14",
          "Subject: Wire not received",
          "",
          "The wire has not landed yet. Could you check?",
        ].join("\n"),
        headers: {
          "delivered-to": OPS_MAILBOX,
          from: `Dean Okonkwo <${forwarderEmail}>`,
          subject: "Fwd: Wire not received",
          "authentication-results": authPass(forwarderEmail),
        },
        rawRef: `n8n:exec-candidate-${RUN}`,
      }),
      CALL(),
    );
    expect(held.outcome).toBe("suspended");
    if (held.outcome !== "suspended") return;
    expect(held.reason).toBe("FORWARDED");

    const released = await releaseHeldIntake({ suspendedId: held.suspendedId, releaseAsCandidate: true });
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: released.data.ticketId } });
    expect(ticket.requesterEmail).toBe(clientEmail);
    expect(ticket.requesterName).toBe("Marla Whitfield");
  });

  it("refuses an unauthenticated sender until the reviewer acknowledges it, and leaves the row NEW", async () => {
    const { prisma, releaseHeldIntake } = mods();
    const suspendedId = await hold({
      reason: "UNAUTHENTICATED",
      mailbox: OPS_MAILBOX,
      fromAddress: "treasury@cedar-ridgewea1th.test",
      subject: "Updated wire instructions",
      snippet: "Please send the distribution to the account below instead.",
    });

    // No acknowledgement at all: both halves of the gate are reported, not just the first.
    const bare = await releaseHeldIntake({ suspendedId });
    expect(bare.ok).toBe(false);
    if (bare.ok) return;
    expect(bare.code).toBe("VALIDATION");
    expect(Object.keys(bare.fieldErrors ?? {}).sort()).toEqual(["confirmUnverifiedSender", "note"]);

    // Acknowledged, but with a note that records nothing.
    const thin = await releaseHeldIntake({ suspendedId, confirmUnverifiedSender: true, note: "ok" });
    expect(thin.ok).toBe(false);
    if (thin.ok) return;
    expect(thin.code).toBe("VALIDATION");
    expect(Object.keys(thin.fieldErrors ?? {})).toEqual(["note"]);

    // A real note, but the reviewer never confirmed.
    const unconfirmed = await releaseHeldIntake({
      suspendedId,
      confirmUnverifiedSender: false,
      note: "Rang the client on the number in CRM",
    });
    expect(unconfirmed.ok).toBe(false);
    if (unconfirmed.ok) return;
    expect(unconfirmed.code).toBe("VALIDATION");
    expect(Object.keys(unconfirmed.fieldErrors ?? {})).toEqual(["confirmUnverifiedSender"]);

    // Nothing was created by any of the three refusals.
    const stillHeld = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: suspendedId } });
    expect(stillHeld.status).toBe("NEW");
    expect(stillHeld.ticketId).toBeNull();
    expect(await prisma.ticket.count({ where: { externalId: `intake-release.${suspendedId}` } })).toBe(0);

    const released = await releaseHeldIntake({
      suspendedId,
      confirmUnverifiedSender: true,
      note: "Rang the client on the number in CRM",
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    // The unproven provenance survives onto the ticket the desk will now work.
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: released.data.ticketId } });
    expect(ticket.description).toContain("SENDER NOT VERIFIED");
    expect(ticket.description).toContain("Rang the client on the number in CRM");
    expect(ticket.requesterEmail).toBe("treasury@cedar-ridgewea1th.test");
  });

  it("writes the release as a HUMAN action: no `metadata.via` on any row it produces", async () => {
    const { prisma, releaseHeldIntake } = mods();
    const suspendedId = await hold({
      reason: "SPAM",
      mailbox: OPS_MAILBOX,
      fromAddress: "hal.osborne@brightpath.test",
      subject: "Sorry — real question in here",
      snippet: "My RMD letter never arrived.",
    });

    const result = await releaseHeldIntake({ suspendedId, note: "Read it; it is a real client question" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Every row this release produced — the ticket's TICKET_INGESTED (and any PII_REDACTED beside
    // it) and the INTAKE_RELEASED row — must read as human: `metadata->>'via' IS NULL` is what a
    // compliance extract of human activity partitions on (CONTRACT §3 rule 1).
    const rows = await prisma.auditLog.findMany({
      where: {
        OR: [
          { ticketId: result.data.ticketId },
          { action: "INTAKE_RELEASED", entityId: suspendedId },
        ],
      },
      select: { action: true, actorId: true, metadata: true },
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((r) => r.action)).toContain("TICKET_INGESTED");
    for (const r of rows) {
      expect(r.actorId).toBe(REVIEWER_ID);
      expect((r.metadata as Record<string, unknown> | null)?.via).toBeUndefined();
    }
    // The channel is still recorded, on the rows and on the ticket itself.
    const ingested = rows.find((r) => r.action === "TICKET_INGESTED");
    expect((ingested?.metadata as Record<string, unknown>).source).toBe("EMAIL");
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: result.data.ticketId } })).source).toBe("EMAIL");

    // The partition itself, asked exactly the way a compliance extract asks it. Raw SQL on purpose:
    // `metadata->>'via' IS NULL` is the contract's own wording, and it is true for an ABSENT key as
    // well as a JSON null, which a Prisma path filter does not express.
    const humanRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "AuditLog"
      WHERE "action" = 'INTAKE_RELEASED'
        AND "entityId" = ${suspendedId}
        AND "metadata" ->> 'via' IS NULL
    `;
    expect(Number(humanRows[0].count)).toBe(1);

    // The positive control: the MACHINE row for the same message — the intake that held it — still
    // carries `via`, so the partition separates the two halves of this message's history rather than
    // emptying one of them.
    const suspended = await prisma.auditLog.findFirstOrThrow({
      where: { action: "INTAKE_SUSPENDED", entityId: suspendedId },
      select: { actorId: true, metadata: true },
    });
    expect(suspended.actorId).toBe(MACHINE_ID);
    expect((suspended.metadata as Record<string, unknown>).via).toBe("email");
  });

  it("refuses the release to a reviewer with no WRITE on the destination queue, and leaves the row NEW", async () => {
    const { prisma, releaseHeldIntake } = mods();
    const suspendedId = await hold({
      reason: "SPAM",
      mailbox: CS_MAILBOX,
      fromAddress: "marla.whitfield@fastmail.test",
      subject: "Statement question",
    });

    // compliance_officers: audit:view, and WRITE on nothing. ops_team: WRITE on OPERATIONS only.
    const asCompliance = await asGroups(["compliance_officers"], () => releaseHeldIntake({ suspendedId }));
    expect(asCompliance.ok).toBe(false);
    if (asCompliance.ok) return;
    expect(asCompliance.code).toBe("FORBIDDEN");

    const asOps = await releaseHeldIntake({ suspendedId });
    expect(asOps.ok).toBe(false);
    if (asOps.ok) return;
    expect(asOps.code).toBe("FORBIDDEN");

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: suspendedId } });
    expect(row.status).toBe("NEW");
    expect(row.ticketId).toBeNull();
    expect(await prisma.ticket.count({ where: { externalId: `intake-release.${suspendedId}` } })).toBe(0);

    // The queue is the boundary, not the person: the same reviewer with client_services releases it.
    const allowed = await asGroups(["ops_team", "client_services"], () => releaseHeldIntake({ suspendedId }));
    expect(allowed.ok).toBe(true);
  });

  it("makes the reviewer name a queue when the message arrived on an unmapped mailbox", async () => {
    const { prisma, releaseHeldIntake } = mods();
    const suspendedId = await hold({
      reason: "UNKNOWN_MAILBOX",
      mailbox: STRAY_MAILBOX,
      fromAddress: "sana.iqbal@applicants.test",
      subject: "Application",
    });

    const refused = await releaseHeldIntake({ suspendedId });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("VALIDATION");

    const released = await releaseHeldIntake({ suspendedId, queueKey: "OPERATIONS" });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: released.data.ticketId },
      include: { queue: { select: { key: true } } },
    });
    expect(ticket.queue.key).toBe("OPERATIONS");
  });

  it("refuses a suspension id that does not exist", async () => {
    const { releaseHeldIntake } = mods();
    const missing = await releaseHeldIntake({ suspendedId: `it_missing_${RUN}` });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("NOT_FOUND");
  });
});
