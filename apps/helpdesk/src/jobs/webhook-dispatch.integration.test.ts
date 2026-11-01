/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10): runs only with TEST_DATABASE_URL, against a
 * separate database. The shared test database is permanent and files run concurrently, so every
 * assertion is scoped to rows this run created — a per-run endpoint, a per-run ticket, and a cursor
 * that is read and restored around the run.
 *
 * NOTHING IS SENT. The transport is injected in every test; the default `fetchTransport` is never
 * reached, and an assertion at the end proves the injected one was the only thing called.
 *
 * Proves live:
 *   - the job is inert with `WEBHOOKS_ENABLED` unset;
 *   - the first run initialises the cursor at the ledger head and does not backfill;
 *   - a subscribed ledger row becomes one PENDING delivery per subscribing endpoint, and a re-scan
 *     creates nothing (the unique index is the at-most-once guarantee);
 *   - a 2xx marks SENT and writes `WEBHOOK_DELIVERY_SENT`; a 500 marks FAILED with a backoff and
 *     writes `WEBHOOK_DELIVERY_FAILED`; the attempt cap marks DEAD and writes `WEBHOOK_DELIVERY_DEAD`;
 *   - the SSRF guard refuses at SEND time, not only at registration, and the refusal is an ordinary
 *     audited failure rather than a throw;
 *   - the signed body is the exact bytes whose sha256 lands on `payloadHash`, and carries no subject.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}
// `src/lib/env.ts` parses once at import, so this must precede the dynamic imports below.
process.env.WEBHOOKS_ENABLED = "true";
// The app-held half of every signing key. The row holds only a salt, so without this the dispatcher
// fails closed and signs nothing — which is itself asserted below.
process.env.WEBHOOK_SIGNING_KEY = "integration-test-app-held-webhook-signing-key";
// A deep link needs a base URL; an https one, because env.ts refuses anything else.
process.env.APP_BASE_URL = "https://wm-helpdesk-test.example.com";

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const auditModule = TEST_URL ? await import("@/lib/audit") : null;
const dispatchModule = TEST_URL ? await import("@/jobs/webhook-dispatch") : null;
const loggerModule = TEST_URL ? await import("@/jobs/logger") : null;
const signingModule = TEST_URL ? await import("@/lib/webhook-signing") : null;

function mods() {
  if (!dbModule || !auditModule || !dispatchModule || !loggerModule || !signingModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return { ...dbModule, ...auditModule, ...dispatchModule, ...loggerModule, ...signingModule };
}

const RUN = randomUUID().slice(0, 8);
const USER_ID = `it_wh_actor_${RUN}`;
const USER_EMAIL = `webhook+${RUN}@wm-helpdesk.local`;
const TICKET_ID = `it_wh_ticket_${RUN}`;
const ENDPOINT_ID = `it_wh_endpoint_${RUN}`;
const ENDPOINT_URL = "https://hooks.example.com/wm";
/** What the row actually stores: a random per-endpoint SALT, in the column still named `secretHash`. */
const SECRET_SALT = "c".repeat(64);
const SUBJECT = `Webhook fixture subject ${RUN}`;

/** A resolver that always answers with one public address, so no DNS is consulted in a test run. */
const publicLookup = async (): Promise<Array<{ address: string }>> => [{ address: "93.184.216.34" }];
/** A resolver that answers with a private address — the DNS-rebinding case, at send time. */
const privateLookup = async (): Promise<Array<{ address: string }>> => [{ address: "10.0.0.5" }];

type Recorded = { url: string; body: string; headers: Record<string, string> };

function recordingTransport(status: number): {
  transport: import("@/jobs/webhook-dispatch").WebhookTransport;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    transport: async (request) => {
      calls.push({ url: request.url, body: request.body, headers: request.headers });
      return { status };
    },
  };
}

function jobContext(now: Date) {
  const { systemRequestContext, SYSTEM_ACTOR, createJobLogger } = mods();
  const ctx = systemRequestContext(`it-webhook-${RUN}`);
  return { name: "webhook-dispatch" as const, actor: SYSTEM_ACTOR, ctx, now, log: createJobLogger("webhook-dispatch", ctx.requestId) };
}

/** Writes one subscribed ledger row for this run's ticket and returns its seq. */
async function writeLedgerRow(action: "TICKET_STATUS_CHANGED"): Promise<bigint> {
  const { prisma, writeAudit, SYSTEM_ACTOR, systemRequestContext } = mods();
  await writeAudit(prisma, SYSTEM_ACTOR, systemRequestContext(`it-webhook-src-${RUN}`), {
    action,
    entityType: "TICKET",
    entityId: TICKET_ID,
    ticketId: TICKET_ID,
    fieldChanged: "status",
    oldValue: "OPEN",
    newValue: "RESOLVED",
  });
  const row = await prisma.auditLog.findFirstOrThrow({
    where: { ticketId: TICKET_ID, action },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return row.seq;
}

/**
 * FIXED in integration round 1 by `prisma/migrations/20260920000300_wave_b_integration_r1`. The probe
 * below is kept as a REGRESSION guard, and the history is kept because it is the reason this suite has
 * never run before now.
 *
 * `20260920000200_wave_b_constraints` created
 * `webhook_endpoint_https_only CHECK (url ~ '^https://[^\s]{3,2000}$')`. Postgres caps a POSIX regex
 * repetition bound at **255**, so that pattern is invalid — the DDL is accepted against an empty
 * table, and then EVERY insert into `WebhookEndpoint` fails with
 * `2201B invalid regular expression: invalid repetition count(s)`. The feature could not be used on
 * any migrated database, and this whole suite skipped itself with a loud reason rather than failing on
 * a defect it could not repair.
 *
 * The replacement separates the two intentions the bound was carrying: `{3,255}` for the SHAPE, inside
 * the engine's limit, and `char_length(url) <= 2000` for the LENGTH. If a future migration reintroduces
 * an out-of-range bound, this probe skips the suite again and says so — which is how the defect would
 * be noticed a second time.
 */
const FIXTURE_BLOCKER =
  "webhook_endpoint_https_only is not a valid regular expression on this database, so no " +
  "WebhookEndpoint row can be inserted. It was fixed in " +
  "prisma/migrations/20260920000300_wave_b_integration_r1 — check that the migration is applied, and " +
  "that no later one reintroduced a POSIX repetition bound above Postgres's limit of 255.";

async function endpointTableUsable(): Promise<boolean> {
  if (!TEST_URL) return false;
  const { prisma } = mods();
  try {
    await prisma.$queryRaw`SELECT ('https://hooks.example.com/wm' ~ (
      SELECT substring(pg_get_constraintdef(oid) from '~ ''(.*)''::text')
      FROM pg_constraint WHERE conname = 'webhook_endpoint_https_only'
    )) AS ok`;
    return true;
  } catch {
    console.error(`[webhook-dispatch.integration] SKIPPED — ${FIXTURE_BLOCKER}`);
    return false;
  }
}

const ENDPOINT_TABLE_USABLE = await endpointTableUsable();

describe.skipIf(!TEST_URL || !ENDPOINT_TABLE_USABLE)("webhook dispatch (DB-gated)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    const queue = await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "integration fixture", sortOrder: 1 },
    });
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, email: USER_EMAIL, name: "Webhook fixture", groups: [], isActive: true },
    });
    await prisma.ticket.upsert({
      where: { id: TICKET_ID },
      update: {},
      create: {
        id: TICKET_ID,
        subject: SUBJECT,
        description: "Ticket used by webhook-dispatch.integration.test.ts",
        requesterName: "Fixture Requester",
        requesterEmail: `client+${RUN}@example.com`,
        category: "OTHER",
        priority: "HIGH",
        queue: { connect: { id: queue.id } },
        createdBy: { connect: { id: USER_ID } },
        slaFirstResponseMinutes: 60,
        slaResolutionMinutes: 480,
        firstResponseDueAt: new Date(Date.now() + 60 * 60_000),
        resolutionDueAt: new Date(Date.now() + 8 * 60 * 60_000),
      },
    });
    await prisma.webhookEndpoint.upsert({
      where: { id: ENDPOINT_ID },
      update: { isActive: true, revokedAt: null, url: ENDPOINT_URL, events: ["TICKET_STATUS_CHANGED"] },
      create: {
        id: ENDPOINT_ID,
        name: `Integration fixture ${RUN}`,
        url: ENDPOINT_URL,
        secretHash: SECRET_SALT,
        secretPrefix: "abcd1234",
        events: ["TICKET_STATUS_CHANGED"],
        isActive: true,
        createdById: USER_ID,
      },
    });

    // RETIRE THIS SUITE'S OWN ENDPOINTS FROM EVERY EARLIER RUN.
    //
    // `readDueDeliveries(now, 200)` is a GLOBAL read: it returns the 200 oldest due deliveries across
    // the whole table and the assertions below filter it down to this run's rows afterwards. The test
    // database is permanent by design, so every past run of this file left its PENDING and FAILED
    // deliveries behind — and they order FIRST, because a retried row has a non-null `nextAttemptAt`
    // while a freshly created one is null and Postgres sorts NULLs last on an ASC key. Once the
    // leftovers passed 200 rows, this run's own delivery fell off the end of the page and three tests
    // began failing on history rather than on behaviour.
    //
    // The fix is the one the production code already understands: `readDueDeliveries` filters on
    // `endpoint: { isActive: true, revokedAt: null }`, so retiring a finished run's endpoint takes its
    // deliveries out of every future page. Nothing is deleted — `WebhookEndpoint` is no-hard-delete and
    // the rows stay exactly where they are — and this touches only endpoints this file created
    // (`it_wh_endpoint_%`), never another suite's data.
    await prisma.webhookEndpoint.updateMany({
      where: { id: { startsWith: "it_wh_endpoint_", not: ENDPOINT_ID }, isActive: true },
      data: { isActive: false, revokedAt: new Date() },
    });
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  it("creates one PENDING delivery per subscribing endpoint, and a re-scan creates nothing", async () => {
    const { prisma, createDeliveriesForBatch, readWebhookEvents, deliveryIdFor } = mods();
    const seq = await writeLedgerRow("TICKET_STATUS_CHANGED");

    const events = (await readWebhookEvents(seq - BigInt(1), ["TICKET_STATUS_CHANGED"])).filter((e) => e.seq === seq);
    expect(events).toHaveLength(1);
    expect(events[0].ticket?.id).toBe(TICKET_ID);

    const endpoints = [{ id: ENDPOINT_ID, url: ENDPOINT_URL, events: ["TICKET_STATUS_CHANGED" as const] }];
    const created = await createDeliveriesForBatch(events, endpoints, seq, "https://wm-helpdesk-test.example.com", new Date());
    expect(created).toBe(1);

    const again = await createDeliveriesForBatch(events, endpoints, seq, "https://wm-helpdesk-test.example.com", new Date());
    expect(again, "the (endpoint, auditSeq) unique index is the at-most-once guarantee").toBe(0);

    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: deliveryIdFor(ENDPOINT_ID, seq) },
      select: { status: true, attempts: true, payloadHash: true, ticketId: true, eventAction: true },
    });
    expect(delivery.status).toBe("PENDING");
    expect(delivery.attempts).toBe(0);
    expect(delivery.ticketId).toBe(TICKET_ID);
    expect(delivery.eventAction).toBe("TICKET_STATUS_CHANGED");
    expect(delivery.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks a 2xx SENT, signs the exact bytes, and carries no subject", async () => {
    const { prisma, attemptDelivery, readDueDeliveries, sha256Hex, signWebhookBody } = mods();
    const seq = await writeLedgerRow("TICKET_STATUS_CHANGED");
    await seedDelivery(seq);

    const due = (await readDueDeliveries(new Date(), 200)).filter((d) => d.auditSeq === seq);
    expect(due).toHaveLength(1);

    const { transport, calls } = recordingTransport(202);
    const outcome = await attemptDelivery(due[0], jobContext(new Date()), transport, publicLookup);
    expect(outcome).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENDPOINT_URL);

    // §7.3: no subject, no requester, no body text.
    expect(calls[0].body).not.toContain(SUBJECT);
    expect(calls[0].body).not.toContain("@");
    const payload = JSON.parse(calls[0].body) as { ticket: { number: number }; link: string; event: string };
    expect(payload.event).toBe("TICKET_STATUS_CHANGED");
    expect(payload.link).toBe(`https://wm-helpdesk-test.example.com/tickets/wm/${payload.ticket.number}`);

    // The signature is over `<timestamp>.<raw body>`, keyed on the DERIVED key — never on the value in
    // the row, which is a salt and signs nothing on its own.
    const { deriveEndpointSigningKey } = mods();
    const signingKey = deriveEndpointSigningKey(process.env.WEBHOOK_SIGNING_KEY, SECRET_SALT);
    expect(signingKey).not.toBeNull();
    const timestamp = Number(calls[0].headers["X-WMHD-Timestamp"]);
    expect(calls[0].headers["X-WMHD-Signature"]).toBe(signWebhookBody(signingKey ?? "", calls[0].body, timestamp));
    expect(calls[0].headers["X-WMHD-Signature"]).not.toBe(signWebhookBody(SECRET_SALT, calls[0].body, timestamp));
    expect(calls[0].headers["X-WMHD-Delivery"]).toBe(due[0].id);
    expect(calls[0].headers["X-WMHD-Event"]).toBe("TICKET_STATUS_CHANGED");

    const row = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: due[0].id },
      select: { status: true, attempts: true, responseStatus: true, sentAt: true, nextAttemptAt: true, payloadHash: true },
    });
    expect(row.status).toBe("SENT");
    expect(row.attempts).toBe(1);
    expect(row.responseStatus).toBe(202);
    expect(row.sentAt).not.toBeNull();
    expect(row.nextAttemptAt).toBeNull();
    expect(row.payloadHash).toBe(sha256Hex(calls[0].body));

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "WEBHOOK_DELIVERY", entityId: due[0].id },
      orderBy: { seq: "desc" },
      select: { action: true, fieldChanged: true, oldValue: true, newValue: true, ticketId: true },
    });
    expect(audit.action).toBe("WEBHOOK_DELIVERY_SENT");
    expect(audit.fieldChanged).toBe("status");
    expect(audit.oldValue).toBe("PENDING");
    expect(audit.newValue).toBe("SENT");
    expect(audit.ticketId).toBe(TICKET_ID);
  });

  it("marks a 500 FAILED with a backoff, and audits it", async () => {
    const { prisma, attemptDelivery, readDueDeliveries, backoffMs } = mods();
    const seq = await writeLedgerRow("TICKET_STATUS_CHANGED");
    await seedDelivery(seq);
    const due = (await readDueDeliveries(new Date(), 200)).filter((d) => d.auditSeq === seq);

    const now = new Date();
    const { transport } = recordingTransport(500);
    expect(await attemptDelivery(due[0], jobContext(now), transport, publicLookup)).toBe("failed");

    const row = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: due[0].id },
      select: { status: true, attempts: true, responseStatus: true, sentAt: true, nextAttemptAt: true, lastError: true },
    });
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(1);
    expect(row.responseStatus).toBe(500);
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toBe("HTTP 500");
    expect(row.nextAttemptAt?.getTime()).toBeGreaterThanOrEqual(now.getTime() + backoffMs(1) - 5_000);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "WEBHOOK_DELIVERY", entityId: due[0].id },
      orderBy: { seq: "desc" },
      select: { action: true, newValue: true },
    });
    expect(audit.action).toBe("WEBHOOK_DELIVERY_FAILED");
    expect(audit.newValue).toBe("FAILED");
  });

  it("gives up at the attempt cap with WEBHOOK_DELIVERY_DEAD", async () => {
    const { prisma, attemptDelivery, readDueDeliveries } = mods();
    const { WAVE_B_LIMITS } = await import("@/types/domain");
    const seq = await writeLedgerRow("TICKET_STATUS_CHANGED");
    await seedDelivery(seq);
    const id = mods().deliveryIdFor(ENDPOINT_ID, seq);
    // One short of the cap, with the attempt about to be taken being the last one.
    await prisma.webhookDelivery.update({
      where: { id },
      data: { status: "FAILED", attempts: WAVE_B_LIMITS.webhookMaxAttempts - 1, nextAttemptAt: new Date(0) },
    });

    const due = (await readDueDeliveries(new Date(), 200)).filter((d) => d.id === id);
    expect(due).toHaveLength(1);
    const { transport } = recordingTransport(503);
    expect(await attemptDelivery(due[0], jobContext(new Date()), transport, publicLookup)).toBe("dead");

    const row = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id },
      select: { status: true, attempts: true, nextAttemptAt: true },
    });
    expect(row.status).toBe("DEAD");
    expect(row.attempts).toBe(WAVE_B_LIMITS.webhookMaxAttempts);
    expect(row.nextAttemptAt).toBeNull();

    // A DEAD row is never handed back.
    expect((await readDueDeliveries(new Date(), 200)).some((d) => d.id === id)).toBe(false);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "WEBHOOK_DELIVERY", entityId: id },
      orderBy: { seq: "desc" },
      select: { action: true, newValue: true },
    });
    expect(audit.action).toBe("WEBHOOK_DELIVERY_DEAD");
    expect(audit.newValue).toBe("DEAD");
  });

  it("re-runs the SSRF guard at SEND time and refuses without calling the transport", async () => {
    const { prisma, attemptDelivery, readDueDeliveries } = mods();
    const seq = await writeLedgerRow("TICKET_STATUS_CHANGED");
    await seedDelivery(seq);
    const due = (await readDueDeliveries(new Date(), 200)).filter((d) => d.auditSeq === seq);

    const { transport, calls } = recordingTransport(200);
    // The stored hostname is unchanged and passed at registration; DNS now answers with a private address.
    const outcome = await attemptDelivery(due[0], jobContext(new Date()), transport, privateLookup);
    expect(outcome).toBe("failed");
    expect(calls, "nothing may leave the process once the guard refuses").toHaveLength(0);

    const row = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: due[0].id },
      select: { status: true, responseStatus: true, lastError: true },
    });
    expect(row.status).toBe("FAILED");
    expect(row.responseStatus).toBeNull();
    expect(row.lastError).toContain("private");

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "WEBHOOK_DELIVERY", entityId: due[0].id },
      orderBy: { seq: "desc" },
      select: { action: true, metadata: true },
    });
    expect(audit.action).toBe("WEBHOOK_DELIVERY_FAILED");
    expect(audit.metadata).toMatchObject({ refusedBySsrfGuard: true });
  });

  it("leaves a delivery on a revoked endpoint alone rather than cancelling it", async () => {
    const { prisma, readDueDeliveries } = mods();
    const seq = await writeLedgerRow("TICKET_STATUS_CHANGED");
    await seedDelivery(seq);
    const id = mods().deliveryIdFor(ENDPOINT_ID, seq);

    await prisma.webhookEndpoint.update({ where: { id: ENDPOINT_ID }, data: { isActive: false } });
    try {
      expect((await readDueDeliveries(new Date(), 200)).some((d) => d.id === id)).toBe(false);
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id }, select: { status: true } });
      expect(row.status, "the row keeps its own story").toBe("PENDING");
    } finally {
      await prisma.webhookEndpoint.update({ where: { id: ENDPOINT_ID }, data: { isActive: true } });
    }
  });

  it("is inert with WEBHOOKS_ENABLED unset, and does not backfill on its first run", async () => {
    const { prisma, webhookLedgerHead } = mods();

    // --- inert -------------------------------------------------------------
    // `src/lib/env.ts` parses once at import, so seeing the shipped default needs a second registry.
    vi.resetModules();
    process.env.WEBHOOKS_ENABLED = "";
    try {
      const fresh = await import("@/jobs/webhook-dispatch");
      const { transport, calls } = recordingTransport(200);
      const disabled = await fresh.dispatchWebhooks(jobContext(new Date()), { transport });
      expect(calls).toHaveLength(0);
      expect(disabled.disabled).toBe(true);
      expect(disabled.created).toBe(0);
      expect(disabled.sent).toBe(0);
    } finally {
      process.env.WEBHOOKS_ENABLED = "true";
    }

    // --- first run initialises at the head ---------------------------------
    const { dispatchWebhooks, WEBHOOK_DISPATCH_CURSOR } = mods();
    const saved = await prisma.jobCursor.findUnique({ where: { name: WEBHOOK_DISPATCH_CURSOR } });
    await prisma.jobCursor.deleteMany({ where: { name: WEBHOOK_DISPATCH_CURSOR } });
    try {
      const head = await webhookLedgerHead();
      const { transport, calls } = recordingTransport(200);
      const first = await dispatchWebhooks(jobContext(new Date()), { transport, lookup: publicLookup });
      expect(first.created, "a first run must not replay history into a third party").toBe(0);
      // At or beyond the head this suite READ a moment ago — not exactly equal to it. The ledger is
      // global and append-only, and the other DB-gated suites in a full run are writing to it
      // between these two statements, so an equality here fails on a neighbour's audit row rather
      // than on anything this job did. What must hold is the property the test is named for: the
      // cursor lands AT the head instead of somewhere behind it, so nothing historical is replayed —
      // and `created === 0` with no transport call is the direct evidence of that.
      expect(Number(first.cursor)).toBeGreaterThanOrEqual(head);
      expect(calls).toHaveLength(0);
      const cursor = await prisma.jobCursor.findUniqueOrThrow({ where: { name: WEBHOOK_DISPATCH_CURSOR } });
      expect(cursor.seq).toBeGreaterThanOrEqual(head);
    } finally {
      await prisma.jobCursor.deleteMany({ where: { name: WEBHOOK_DISPATCH_CURSOR } });
      if (saved) {
        await prisma.jobCursor.create({ data: { name: WEBHOOK_DISPATCH_CURSOR, seq: saved.seq } });
      }
    }
  });
});

/** Creates this run's delivery row for one ledger seq, through the code under test. */
async function seedDelivery(seq: bigint): Promise<void> {
  const { createDeliveriesForBatch, readWebhookEvents } = mods();
  const events = (await readWebhookEvents(seq - BigInt(1), ["TICKET_STATUS_CHANGED"])).filter((e) => e.seq === seq);
  await createDeliveriesForBatch(
    events,
    [{ id: ENDPOINT_ID, url: ENDPOINT_URL, events: ["TICKET_STATUS_CHANGED"] }],
    seq,
    "https://wm-helpdesk-test.example.com",
    new Date(),
  );
}
