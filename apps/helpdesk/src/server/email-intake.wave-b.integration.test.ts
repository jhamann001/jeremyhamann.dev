/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; `TEST_DATABASE_URL` only — never the dev
 * database: the immutability and no-delete triggers make every fixture row permanent).
 *
 * The Wave B half of inbound intake:
 *
 *   - a FORWARDED hold: a staff member forwards a client's mail in, the message is held with the
 *     parsed original sender as a CANDIDATE, and nothing is attributed to that sender;
 *   - the gate is narrow: a forward with no distinct embedded sender is the sender's own message and
 *     becomes an ordinary ticket, because there is no mis-attribution to prevent;
 *   - the gate runs AHEAD of threading: a forwarded copy carrying the original's In-Reply-To is held
 *     as FORWARDED rather than joined-then-refused as a SENDER_MISMATCH;
 *   - `resolveForwardedRelease` allows the parsed candidate ONLY for an authenticated, active staff
 *     forwarder, and only for the address that was actually parsed;
 *   - a DSN naming one of our Message-IDs moves that delivery SENT → BOUNCED with `MESSAGE_BOUNCED`,
 *     and does so even though the DSN itself is held by an earlier gate;
 *   - a hard bounce suppresses NOTHING on its own.
 *
 * EVERY assertion is scoped to rows this run created, by a per-run marker: `wm_helpdesk_test` is
 * shared and permanent, and these files run concurrently.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { AuditActor, RequestContext } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const SERVICE_MAILBOX = "service@example.com";
process.env.MAILBOX_MAP = JSON.stringify({
  [SERVICE_MAILBOX]: { queueKey: "CLIENT_SERVICE", brand: "CEDAR_RIDGE_WEALTH" },
});

const RUN = randomUUID().slice(0, 8);
const MACHINE_ID = `it_fwd_machine_${RUN}`;
const STAFF_ID = `it_fwd_staff_${RUN}`;
const INACTIVE_ID = `it_fwd_inactive_${RUN}`;
const STAFF_EMAIL = `advisor.${RUN}@example.com`;
const INACTIVE_EMAIL = `former.${RUN}@example.com`;
const CLIENT_EMAIL = `marla.${RUN}@fastmail.test`;
const BOUNCE_TICKET = `it_fwd_bounce_ticket_${RUN}`;
const BOUNCE_ADDRESS = `gone.${RUN}@fastmail.test`;
const OUR_MESSAGE_ID = `<wm.it_dlv_${RUN}.aa11@example.com>`;

const ACTOR: AuditActor = { id: MACHINE_ID, email: `fwd.machine.${RUN}@wm-helpdesk.local`, groups: [] };
const CTX: RequestContext = {
  ipAddress: "203.0.113.77",
  userAgent: `it-email-wave-b/${RUN}`,
  requestId: `it-email-wave-b-${RUN}`,
  isPrefetch: false,
};
const CALL = () => ({ actor: ACTOR, ctx: CTX, via: "email" as const });

const dbModule = TEST_URL ? await import("@/lib/db") : null;
const intakeModule = TEST_URL ? await import("@/server/email-intake") : null;

function mods() {
  if (!dbModule || !intakeModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { ...dbModule, ...intakeModule };
}

type Prisma = typeof import("@/lib/db").prisma;

/** A DMARC-pass verdict from the trusted authserv-id, in the shape the corpus uses. */
function authPass(from: string): string {
  const domain = from.slice(from.lastIndexOf("@") + 1);
  return (
    `mx.google.com; spf=pass (google.com: domain of ${from} designates 209.85.220.41 as permitted sender) ` +
    `smtp.mailfrom=${from}; dkim=pass header.i=@${domain} header.s=20230601 header.b=Qj7bKq2p; ` +
    `dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`
  );
}

const FORWARD_BODY = [
  "Marla sent this to me directly — can the desk pick it up?",
  "",
  "---------- Forwarded message ---------",
  `From: Marla Whitfield <${CLIENT_EMAIL}>`,
  "Date: Fri, 18 Sep 2026 at 09:14",
  "Subject: Wire not received",
  "To: Dean Okonkwo <dean@example.com>",
  "",
  "The wire has not landed yet. Could you check?",
].join("\n");

function forwardPayload(overrides: { from?: string; messageId?: string; headers?: Record<string, string> } = {}) {
  const from = overrides.from ?? STAFF_EMAIL;
  return {
    mailbox: SERVICE_MAILBOX,
    messageId: overrides.messageId ?? `${RUN}.forward@example.com`,
    from: `Advisor <${from}>`,
    subject: "Fwd: Wire not received",
    textBody: FORWARD_BODY,
    headers: {
      "delivered-to": SERVICE_MAILBOX,
      from: `Advisor <${from}>`,
      subject: "Fwd: Wire not received",
      "authentication-results": authPass(from),
      ...(overrides.headers ?? {}),
    },
    rawRef: `n8n:exec-fwd-${RUN}`,
  };
}

async function ingest(payload: unknown) {
  const { ingestInboundEmail, parseInboundEmail } = mods();
  return ingestInboundEmail(parseInboundEmail(payload), CALL());
}

async function auditFor(prisma: Prisma, action: string, entityId: string) {
  return prisma.auditLog.findMany({
    where: { action: action as never, entityId },
    orderBy: { seq: "asc" },
    select: { action: true, entityType: true, ticketId: true, fieldChanged: true, oldValue: true, newValue: true, metadata: true },
  });
}

describe.skipIf(!TEST_URL)("inbound email — Wave B (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "CLIENT_SERVICE" },
      update: {},
      create: { key: "CLIENT_SERVICE", name: "Client Service", description: "wave-b email fixture", sortOrder: 2 },
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "CLIENT_SERVICE" } });

    for (const [id, email, isActive] of [
      [MACHINE_ID, ACTOR.email, true],
      [STAFF_ID, STAFF_EMAIL, true],
      [INACTIVE_ID, INACTIVE_EMAIL, false],
    ] as const) {
      await prisma.user.upsert({
        where: { id },
        update: {},
        create: { id, email, name: `Fixture ${id}`, groups: [], isActive },
      });
    }

    // A ticket with one SENT outbound delivery, so a DSN has something of ours to name.
    const createdAt = new Date("2026-09-10T12:00:00.000Z");
    const ticket = await prisma.ticket.upsert({
      where: { id: BOUNCE_TICKET },
      update: {},
      create: {
        id: BOUNCE_TICKET,
        subject: `Bounce thread ${RUN}`,
        description: "Seeded thread for the Wave B bounce test",
        requesterName: "Gone Away",
        requesterEmail: BOUNCE_ADDRESS,
        category: "OTHER",
        priority: "STANDARD",
        status: "OPEN",
        brand: "CEDAR_RIDGE_WEALTH",
        source: "EMAIL",
        queue: { connect: { id: queue.id } },
        createdBy: { connect: { id: MACHINE_ID } },
        slaFirstResponseMinutes: 240,
        slaResolutionMinutes: 1440,
        firstResponseDueAt: new Date(createdAt.getTime() + 240 * 60_000),
        resolutionDueAt: new Date(createdAt.getTime() + 1440 * 60_000),
      },
      select: { id: true, number: true },
    });

    const existing = await prisma.messageDelivery.findUnique({ where: { messageId: OUR_MESSAGE_ID } });
    if (existing === null) {
      const comment = await prisma.comment.create({
        data: {
          ticketId: ticket.id,
          authorId: MACHINE_ID,
          authorKind: "STAFF",
          visibility: "PUBLIC",
          body: "Seeded outbound reply.\n\n---\nDisclaimer text",
          disclaimerKey: "GENERAL_SERVICE",
        },
        select: { id: true },
      });
      await prisma.messageDelivery.create({
        data: {
          commentId: comment.id,
          ticketId: ticket.id,
          brand: "CEDAR_RIDGE_WEALTH",
          fromAddress: SERVICE_MAILBOX,
          fromName: "Cedar Ridge Wealth Client Service",
          replyTo: SERVICE_MAILBOX,
          toAddress: BOUNCE_ADDRESS,
          subject: `[HD-${ticket.number}] Bounce thread`,
          textBody: "Seeded outbound reply.",
          htmlBody: "<p>Seeded outbound reply.</p>",
          messageId: OUR_MESSAGE_ID,
          status: "SENT",
          attempts: 1,
          sentAt: new Date(),
        },
      });
    }
  });

  // -------------------------------------------------------------------------
  // Forwarded mail
  // -------------------------------------------------------------------------

  it("holds a forwarded message as FORWARDED and records the parsed sender as a CANDIDATE", async () => {
    const { prisma } = mods();
    const result = await ingest(forwardPayload());

    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;
    expect(result.reason).toBe("FORWARDED");

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: result.suspendedId } });
    expect(row.candidateRequesterEmail).toBe(CLIENT_EMAIL);
    // The row's own From is the FORWARDER, not the client. Nothing was attributed.
    expect(row.fromAddress).toBe(STAFF_EMAIL);
    // The forward passed DMARC, so the verdict is on the row as well as in the ledger.
    expect(row.senderVerified).toBe(true);

    // No ticket and no comment were written for it.
    expect(await prisma.ticket.count({ where: { requesterEmail: CLIENT_EMAIL } })).toBe(0);

    const audit = await auditFor(prisma, "INTAKE_SUSPENDED", result.suspendedId);
    expect(audit).toHaveLength(1);
    expect(audit[0].newValue).toBe("FORWARDED");
    const metadata = audit[0].metadata as Record<string, unknown>;
    expect(metadata.candidateRequesterEmail).toBe(CLIENT_EMAIL);
    expect(metadata.senderVerified).toBe(true);
  });

  // The address is lower-cased because an address is case-insensitive; the client's NAME is not. The
  // raw message is never stored, so the hold is the only moment the correctly-cased name exists
  // — dropped here, a release against the candidate can only derive "marla whitfield" from the
  // address, and the client is mis-named on the ticket from the moment it is created.
  it("keeps the ORIGINAL sender's display name, casing intact, for the release to name the client by", async () => {
    const { prisma, forwardedCandidateName, FORWARD_CANDIDATE_NAME_HEADER_KEY } = mods();
    const result = await ingest(forwardPayload({ messageId: `${RUN}.forward-name@example.com` }));
    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: result.suspendedId } });
    expect(forwardedCandidateName(row.headers)).toBe("Marla Whitfield");
    expect((row.headers as Record<string, string>)[FORWARD_CANDIDATE_NAME_HEADER_KEY]).toBe("Marla Whitfield");
    // The forwarder's own display name is still the one on the `from` header, unchanged.
    expect((row.headers as Record<string, string>).from).toBe(`Advisor <${STAFF_EMAIL}>`);
  });

  it("keeps NO name when the forwarded block carried a bare address — an addr-spec is not a name", async () => {
    const { prisma, forwardedCandidateName } = mods();
    const payload = forwardPayload({ messageId: `${RUN}.forward-noname@example.com` });
    payload.textBody = FORWARD_BODY.replace(`Marla Whitfield <${CLIENT_EMAIL}>`, CLIENT_EMAIL);

    const result = await ingest(payload);
    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: result.suspendedId } });
    expect(row.candidateRequesterEmail).toBe(CLIENT_EMAIL);
    expect(forwardedCandidateName(row.headers)).toBeNull();
  });

  it("will not let a sender put a name of their own choosing on the row through a header", async () => {
    const { prisma, forwardedCandidateName, FORWARD_CANDIDATE_NAME_HEADER_KEY } = mods();
    const result = await ingest(
      forwardPayload({
        messageId: `${RUN}.forward-name-spoof@example.com`,
        headers: { [FORWARD_CANDIDATE_NAME_HEADER_KEY]: "Chief Investment Officer" },
      }),
    );
    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: result.suspendedId } });
    expect(forwardedCandidateName(row.headers)).toBe("Marla Whitfield");
  });

  it("is idempotent — a redelivered forward produces one permanent row", async () => {
    const { prisma } = mods();
    const payload = forwardPayload({ messageId: `${RUN}.forward-replay@example.com` });
    const first = await ingest(payload);
    const again = await ingest(payload);
    expect(first).toEqual(again);
    expect(
      await prisma.suspendedIntake.count({ where: { messageId: payload.messageId } }),
    ).toBe(1);
  });

  it("does NOT hold a forward that carries no distinct embedded sender — that is the sender's own message", async () => {
    const payload = forwardPayload({
      messageId: `${RUN}.own-forward@example.com`,
      headers: { subject: "Fwd: my custodian receipt" },
    });
    payload.subject = "Fwd: my custodian receipt";
    payload.textBody = "Forwarding the receipt my custodian sent me — please file it.";

    const result = await ingest(payload);
    expect(result.outcome).toBe("ticket");
  });

  it("does NOT hold a forward whose embedded sender IS the sender", async () => {
    const payload = forwardPayload({
      from: STAFF_EMAIL,
      messageId: `${RUN}.self-forward@example.com`,
    });
    payload.textBody = FORWARD_BODY.replace(CLIENT_EMAIL, STAFF_EMAIL);

    const result = await ingest(payload);
    expect(result.outcome).toBe("ticket");
  });

  it("holds a forwarded REPLY as FORWARDED rather than joining the thread and refusing it", async () => {
    const { prisma } = mods();
    // The forwarded copy carries the original thread's In-Reply-To — which the Message-ID matcher
    // would otherwise resolve, only for the sender-identity gate to hold it as a SENDER_MISMATCH,
    // losing both the forward and the candidate.
    const payload = forwardPayload({
      messageId: `${RUN}.forwarded-reply@example.com`,
      headers: { "in-reply-to": OUR_MESSAGE_ID },
    });

    const result = await ingest(payload);
    expect(result.outcome).toBe("suspended");
    if (result.outcome !== "suspended") return;
    expect(result.reason).toBe("FORWARDED");

    const row = await prisma.suspendedIntake.findUniqueOrThrow({ where: { id: result.suspendedId } });
    expect(row.candidateRequesterEmail).toBe(CLIENT_EMAIL);
  });

  // -------------------------------------------------------------------------
  // Releasing a forward against the parsed candidate
  // -------------------------------------------------------------------------

  describe("resolveForwardedRelease", () => {
    async function heldForward(from: string, marker: string): Promise<string> {
      const result = await ingest(forwardPayload({ from, messageId: `${RUN}.${marker}@example.com` }));
      if (result.outcome !== "suspended") throw new Error("expected a suspended outcome");
      return result.suspendedId;
    }

    it("allows the parsed candidate when an authenticated, active staff member forwarded it", async () => {
      const { resolveForwardedRelease } = mods();
      const id = await heldForward(STAFF_EMAIL, "release-ok");
      const decision = await resolveForwardedRelease({ suspendedId: id, requestedRequesterEmail: CLIENT_EMAIL });
      expect(decision).toEqual({ allowed: true, requesterEmail: CLIENT_EMAIL, forwardedBy: STAFF_EMAIL });
    });

    it("refuses an address that was not the one parsed — that is changeRequesterEmail's job", async () => {
      const { resolveForwardedRelease } = mods();
      const id = await heldForward(STAFF_EMAIL, "release-mismatch");
      const decision = await resolveForwardedRelease({
        suspendedId: id,
        requestedRequesterEmail: `attacker.${RUN}@fastmail.test`,
      });
      expect(decision).toEqual({ allowed: false, refusal: "CANDIDATE_MISMATCH" });
    });

    it("refuses a forward from outside the firm — that is the outsider's own message", async () => {
      const { resolveForwardedRelease } = mods();
      const id = await heldForward(`stranger.${RUN}@outside.test`, "release-outsider");
      const decision = await resolveForwardedRelease({ suspendedId: id, requestedRequesterEmail: CLIENT_EMAIL });
      expect(decision).toEqual({ allowed: false, refusal: "SENDER_NOT_STAFF" });
    });

    it("refuses a forward from a deactivated account", async () => {
      const { resolveForwardedRelease } = mods();
      const id = await heldForward(INACTIVE_EMAIL, "release-inactive");
      const decision = await resolveForwardedRelease({ suspendedId: id, requestedRequesterEmail: CLIENT_EMAIL });
      expect(decision).toEqual({ allowed: false, refusal: "SENDER_NOT_STAFF" });
    });

    it("refuses a hold that is not a forward at all", async () => {
      const { prisma, resolveForwardedRelease } = mods();
      const other = await prisma.suspendedIntake.findFirst({
        where: { reason: { not: "FORWARDED" } },
        select: { id: true },
      });
      if (other === null) return;
      const decision = await resolveForwardedRelease({ suspendedId: other.id, requestedRequesterEmail: CLIENT_EMAIL });
      expect(decision).toEqual({ allowed: false, refusal: "NOT_FORWARDED" });
    });

    it("refuses an id that names nothing", async () => {
      const { resolveForwardedRelease } = mods();
      const decision = await resolveForwardedRelease({
        suspendedId: `it_missing_${RUN}`,
        requestedRequesterEmail: CLIENT_EMAIL,
      });
      expect(decision).toEqual({ allowed: false, refusal: "NOT_FORWARDED" });
    });
  });

  // -------------------------------------------------------------------------
  // Bounces
  // -------------------------------------------------------------------------

  it("moves the named delivery SENT → BOUNCED with MESSAGE_BOUNCED, even though the DSN is held", async () => {
    const { prisma } = mods();
    const dsnBody = [
      "The response was:",
      "550 5.1.1 The email account that you tried to reach does not exist.",
      "",
      `Final-Recipient: rfc822; ${BOUNCE_ADDRESS}`,
      "Action: failed",
      "Status: 5.1.1",
      "",
      `Message-ID: ${OUR_MESSAGE_ID}`,
    ].join("\n");

    const result = await ingest({
      mailbox: SERVICE_MAILBOX,
      messageId: `${RUN}.dsn@googlemail.com`,
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      subject: "Delivery Status Notification (Failure)",
      textBody: dsnBody,
      headers: {
        "delivered-to": SERVICE_MAILBOX,
        from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        subject: "Delivery Status Notification (Failure)",
        "content-type": 'multipart/report; report-type=delivery-status; boundary="000"',
      },
      rawRef: `n8n:exec-dsn-${RUN}`,
    });

    // The DSN itself is machine mail and is held, as it always was.
    expect(result.outcome).toBe("suspended");

    const delivery = await prisma.messageDelivery.findUniqueOrThrow({ where: { messageId: OUR_MESSAGE_ID } });
    expect(delivery.status).toBe("BOUNCED");
    expect(delivery.bounceType).toBe("hard");
    expect(delivery.bouncedAt).not.toBeNull();

    const audit = await auditFor(prisma, "MESSAGE_BOUNCED", delivery.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].entityType).toBe("MESSAGE_DELIVERY");
    expect(audit[0].ticketId).toBe(BOUNCE_TICKET);
    expect(audit[0].oldValue).toBe("SENT");
    expect(audit[0].newValue).toBe("BOUNCED");
    const metadata = audit[0].metadata as Record<string, unknown>;
    expect(metadata.bounceType).toBe("hard");
    expect(metadata.dsnCode).toBe("5.1.1");
    expect(metadata.via).toBe("email");

    // A HARD BOUNCE SUPPRESSES NOTHING. The address is a candidate an administrator confirms.
    expect(await prisma.requesterSuppression.count({ where: { email: BOUNCE_ADDRESS } })).toBe(0);
  });

  it("writes no second MESSAGE_BOUNCED row when the same DSN is redelivered", async () => {
    const { prisma } = mods();
    const delivery = await prisma.messageDelivery.findUniqueOrThrow({ where: { messageId: OUR_MESSAGE_ID } });
    const before = (await auditFor(prisma, "MESSAGE_BOUNCED", delivery.id)).length;

    await ingest({
      mailbox: SERVICE_MAILBOX,
      messageId: `${RUN}.dsn-replay@googlemail.com`,
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      subject: "Delivery Status Notification (Failure)",
      textBody: `Action: failed\nStatus: 5.1.1\n\nMessage-ID: ${OUR_MESSAGE_ID}`,
      headers: {
        "delivered-to": SERVICE_MAILBOX,
        from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        subject: "Delivery Status Notification (Failure)",
        "content-type": 'multipart/report; report-type=delivery-status; boundary="000"',
      },
      rawRef: `n8n:exec-dsn2-${RUN}`,
    });

    expect(await auditFor(prisma, "MESSAGE_BOUNCED", delivery.id)).toHaveLength(before);
  });

  it("transitions nothing for a DSN about somebody else's message", async () => {
    const { prisma } = mods();
    const before = await prisma.messageDelivery.count({ where: { status: "BOUNCED" } });

    const result = await ingest({
      mailbox: SERVICE_MAILBOX,
      messageId: `${RUN}.dsn-foreign@googlemail.com`,
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      subject: "Delivery Status Notification (Failure)",
      textBody: `Action: failed\nStatus: 5.1.1\n\nMessage-ID: <not.ours.${RUN}@elsewhere.test>`,
      headers: {
        "delivered-to": SERVICE_MAILBOX,
        from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        subject: "Delivery Status Notification (Failure)",
        "content-type": 'multipart/report; report-type=delivery-status; boundary="000"',
      },
      rawRef: `n8n:exec-dsn3-${RUN}`,
    });

    expect(result.outcome).toBe("suspended");
    expect(await prisma.messageDelivery.count({ where: { status: "BOUNCED" } })).toBe(before);
  });
});
