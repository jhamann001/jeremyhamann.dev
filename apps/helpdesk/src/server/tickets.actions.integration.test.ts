/**
 * DB-gated (docs/ARCHITECTURE.md §g shared convention 10; TEST_DATABASE_URL only — never the dev DB,
 * the immutability triggers make every Comment and AuditLog row permanent). Proves the transactional
 * invariants of the three Wave A ticket mutations (#66):
 *
 *  - `recordClientContact` stamps `firstRespondedAt` EXACTLY ONCE, under the existing conditional
 *    guard, and writes its INTERNAL note plus `CLIENT_CONTACT_RECORDED` in the same transaction.
 *  - `updateTicketFields` stamps `complaintFiledAt` the first time `isComplaint` goes true and never
 *    re-stamps it, normalizes `requesterEmail`, and refuses to leave a ticket with neither an email
 *    nor a phone (the DB CHECK, refused in the app so the form can render it).
 *  - `assignToMe` is `assignTicket` aimed at the viewer: §b.4 eligibility, §b.6 NEW → OPEN, one
 *    `TICKET_ASSIGNED` row, and the version token is honored.
 *  - (security) re-pointing `requesterEmail` — the client API's authorization subject and
 *    the destination of every outbound reply — is refused by `updateTicketFields` and only happens
 *    through `changeRequesterEmail`, which needs `queue:write`, a literal confirmation and a recorded
 *    (sanitized) reason, and is refused outright on a complaint or an escalated ticket.
 *  - (security) the same is true of the TWO-STEP redirect: CLEAR then ADOPT through
 *    `updateTicketFields` no longer composes into one. The ADOPT half is refused once the ledger shows
 *    an address was dropped, the CLEAR half meets the complaint / escalation refusal, and the
 *    re-adoption goes through `changeRequesterEmail` with the same confirmation, reason and marker.
 *  - `changeTicketStatus` RECORDS the outcome (`Ticket.resolution`, CONTRACT
 *    §1.1) in the same transaction as the status: the four operator values only, on the two ending
 *    transitions only, write-once per resolve cycle, cleared on a reopen, and each write audited as
 *    its own `TICKET_FIELD_CHANGED` row.
 *
 * `@/lib/session` and `@/lib/request-context` are mocked so the real actions run against the real test
 * database with a viewer this test controls.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionResult, OktaGroup, RequestContext, Viewer } from "@/types/domain";
import { CLIENT_CONTACT_NOTE_PREFIX } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const RUN = randomUUID().slice(0, 8);
const OPS_USER_ID = `it_ta_ops_${RUN}`;
const COMPLIANCE_USER_ID = `it_ta_co_${RUN}`;

const hoisted = vi.hoisted(() => ({ viewer: null as unknown as Viewer, ctx: null as unknown as RequestContext }));

function viewerOf(id: string, groups: OktaGroup[]): Viewer {
  return { id, email: `${id}@wm-helpdesk.local`, name: `Actions ${groups[0]}`, image: null, groups, isDev: false };
}

hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
hoisted.ctx = {
  ipAddress: "203.0.113.77",
  userAgent: `it-ticket-actions/${RUN}`,
  requestId: `it-ticket-actions-${RUN}`,
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
const actionsModule = TEST_URL ? await import("@/server/tickets.actions") : null;
const readsModule = TEST_URL ? await import("@/server/tickets") : null;

function mods() {
  if (!dbModule || !actionsModule || !readsModule) throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  return { prisma: dbModule.prisma, ...actionsModule, requesterEmailChangedAt: readsModule.requesterEmailChangedAt };
}

/** Narrows an ActionResult, failing the test with the real code when it is an error. */
function ok<T>(r: ActionResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.data;
}

let ticketSeq = 0;

/** A fresh OPEN ticket in OPERATIONS with no first response yet. */
async function newTicket(
  overrides: {
    status?: "NEW" | "OPEN";
    requesterPhone?: string | null;
    /** `null` builds the phone-only ticket; omit for the default fixture address. */
    requesterEmail?: string | null;
    isComplaint?: boolean;
    escalationTarget?: "NONE" | "COMPLIANCE" | "FRAUD" | "OPERATIONS" | "ADVISOR";
    /**
     * Default WIRE_TRANSFER, which is one of the five `MONEY_MOVEMENT_CATEGORIES` and therefore held
     * at the RESOLVED edge by the identity gate. The status tests pass a category
     * OUTSIDE the five so they exercise the outcome rules rather than the gate.
     */
    category?: "WIRE_TRANSFER" | "PLANNING_UPDATE";
    /**
     * Decision #117. Omitted, the row takes the schema default `STAFF_FORM` — an operator's account of
     * the request, freely editable. `EMAIL` / `CLIENT_APP` is the client's OWN opening message, which
     * the client API renders back to them and `updateTicketFields` therefore refuses to overwrite.
     */
    source?: "EMAIL" | "CLIENT_APP" | "STAFF_FORM" | "PHONE" | "VOICEMAIL";
  } = {},
): Promise<{
  id: string;
  version: number;
}> {
  const { prisma } = mods();
  const id = `it_ta_ticket_${RUN}_${ticketSeq++}`;
  const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "OPERATIONS" } });
  const createdAt = new Date("2026-09-19T09:00:00.000Z");
  const t = await prisma.ticket.create({
    data: {
      id,
      subject: `Actions fixture ${id}`,
      description: "Original description",
      requesterName: "Margaret Thompson",
      requesterEmail:
        overrides.requesterEmail === undefined ? `actions.${id}@example.com` : overrides.requesterEmail,
      requesterPhone: overrides.requesterPhone ?? null,
      isComplaint: overrides.isComplaint ?? false,
      escalationTarget: overrides.escalationTarget ?? "NONE",
      category: overrides.category ?? "WIRE_TRANSFER",
      priority: "URGENT",
      status: overrides.status ?? "OPEN",
      source: overrides.source ?? "STAFF_FORM",
      queue: { connect: { id: queue.id } },
      createdBy: { connect: { id: OPS_USER_ID } },
      slaFirstResponseMinutes: 30,
      slaResolutionMinutes: 120,
      firstResponseDueAt: new Date(createdAt.getTime() + 30 * 60_000),
      resolutionDueAt: new Date(createdAt.getTime() + 120 * 60_000),
      createdAt,
    },
    select: { id: true, version: true },
  });
  return t;
}

async function auditFor(ticketId: string, action: string) {
  const { prisma } = mods();
  return prisma.auditLog.findMany({ where: { ticketId, action: action as never }, orderBy: { seq: "asc" } });
}

describe.skipIf(!TEST_URL)("Wave A ticket actions (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "OPERATIONS" },
      update: {},
      create: { key: "OPERATIONS", name: "Operations", description: "integration fixture", sortOrder: 1 },
    });
    for (const [id, groups] of [
      [OPS_USER_ID, ["ops_team"]],
      [COMPLIANCE_USER_ID, ["compliance_officers"]],
    ] as const) {
      await prisma.user.upsert({
        where: { id },
        update: { groups: [...groups], isActive: true },
        create: {
          id,
          email: `${id}@wm-helpdesk.local`,
          name: `Actions ${groups[0]}`,
          groups: [...groups],
          emailVerified: new Date(),
          isActive: true,
        },
      });
    }
  });

  afterAll(async () => {
    if (dbModule) await dbModule.prisma.$disconnect();
  });

  describe("recordClientContact (Decision #66)", () => {
    it("credits the callback as the first response, writes the prefixed INTERNAL note, and audits both in one transaction", async () => {
      const { prisma, recordClientContact } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();

      const out = ok(
        await recordClientContact({
          ticketId: t.id,
          version: t.version,
          channel: "PHONE",
          note: "Called Margaret back; wire confirmed verbally.",
        }),
      );
      expect(out.firstResponseStamped).toBe(true);
      expect(out.version).toBe(t.version + 1);

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.firstRespondedAt).not.toBeNull();
      expect(after.version).toBe(t.version + 1);

      const comment = await prisma.comment.findUniqueOrThrow({ where: { id: out.commentId } });
      expect(comment.visibility).toBe("INTERNAL");
      expect(comment.authorKind).toBe("STAFF");
      expect(comment.authorId).toBe(OPS_USER_ID);
      expect(comment.body).toBe(`${CLIENT_CONTACT_NOTE_PREFIX} [PHONE]\n\nCalled Margaret back; wire confirmed verbally.`);

      const recorded = await auditFor(t.id, "CLIENT_CONTACT_RECORDED");
      expect(recorded).toHaveLength(1);
      expect(recorded[0].fieldChanged).toBe("channel");
      expect(recorded[0].oldValue).toBeNull();
      expect(recorded[0].newValue).toBe("PHONE");
      expect((recorded[0].metadata as { commentId?: string }).commentId).toBe(out.commentId);

      expect(await auditFor(t.id, "COMMENT_ADDED_INTERNAL")).toHaveLength(1);
      const stamped = await auditFor(t.id, "TICKET_FIELD_CHANGED");
      expect(stamped.filter((r) => r.fieldChanged === "firstRespondedAt")).toHaveLength(1);
    });

    it("a second contact never re-stamps the first response (the conditional guard, I13)", async () => {
      const { prisma, recordClientContact } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();

      const first = ok(
        await recordClientContact({ ticketId: t.id, version: t.version, channel: "VOICEMAIL_RETURNED", note: "LVM" }),
      );
      const stampedAt = (await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).firstRespondedAt;

      const second = ok(
        await recordClientContact({ ticketId: t.id, version: first.version, channel: "IN_PERSON", note: "Stopped by" }),
      );
      expect(second.firstResponseStamped).toBe(false);

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.firstRespondedAt).toEqual(stampedAt);
      expect(await auditFor(t.id, "CLIENT_CONTACT_RECORDED")).toHaveLength(2);
      const fieldRows = await auditFor(t.id, "TICKET_FIELD_CHANGED");
      expect(fieldRows.filter((r) => r.fieldChanged === "firstRespondedAt")).toHaveLength(1);
    });

    it("a stale version conflicts and writes nothing", async () => {
      const { prisma, recordClientContact } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();
      ok(await recordClientContact({ ticketId: t.id, version: t.version, channel: "SMS", note: "Texted" }));

      const stale = await recordClientContact({ ticketId: t.id, version: t.version, channel: "SMS", note: "Again" });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.code).toBe("CONFLICT");
      expect(await prisma.comment.count({ where: { ticketId: t.id } })).toBe(1);
    });

    it("compliance_officers cannot credit a response — read-plus-annotate is unchanged (§b rule 2)", async () => {
      const { prisma, recordClientContact } = mods();
      const t = await newTicket();
      hoisted.viewer = viewerOf(COMPLIANCE_USER_ID, ["compliance_officers"]);

      const r = await recordClientContact({ ticketId: t.id, version: t.version, channel: "PHONE", note: "Reviewed" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("FORBIDDEN");
      expect(await prisma.comment.count({ where: { ticketId: t.id } })).toBe(0);
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).firstRespondedAt).toBeNull();

      const denials = await auditFor(t.id, "AUTHZ_DENIED");
      expect(denials.length).toBeGreaterThan(0);
    });
  });

  /**
   * Decision #117. The client API returns `Ticket.description` as the FIRST entry of the client's own
   * thread, attributed to them as "You". `source` proves how a ticket ARRIVED; it cannot prove the
   * CURRENT value of the field is still what the client sent — and `description` is an ordinary
   * writable column behind plain `queue:write`, listed in TICKET_DIFFED_COLUMNS with its own
   * "changed description" activity line. Without a refusal, an associate tidying an emailed ticket
   * would have had their sentence served back to the client as the client's own words.
   */
  describe("updateTicketFields — a client's own opening message is not the desk's to edit (Decision #117)", () => {
    for (const source of ["EMAIL", "CLIENT_APP"] as const) {
      it(`refuses a description edit on a ${source} ticket, and writes nothing`, async () => {
        const { prisma, updateTicketFields } = mods();
        hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
        const t = await newTicket({ source });

        const res = await updateTicketFields({
          ticketId: t.id,
          version: t.version,
          description: "Client wants a wire. NOTE: flagged for fraud review, do not disclose.",
        });
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.code).toBe("VALIDATION");

        const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.description).toBe("Original description");
        // Refused BEFORE the write, so the version never moved and no diff row was raised.
        expect(after.version).toBe(t.version);
        expect(await auditFor(t.id, "TICKET_FIELD_CHANGED")).toEqual([]);
      });

      it(`still allows every OTHER field on a ${source} ticket`, async () => {
        const { prisma, updateTicketFields } = mods();
        hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
        const t = await newTicket({ source });

        ok(await updateTicketFields({ ticketId: t.id, version: t.version, subject: "Wire status — chased" }));
        const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.subject).toBe("Wire status — chased");
        expect(after.description).toBe("Original description");
      });
    }

    it("leaves an operator-authored ticket freely editable — the properties panel is unchanged there", async () => {
      const { prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      for (const source of ["STAFF_FORM", "PHONE", "VOICEMAIL"] as const) {
        const t = await newTicket({ source });
        ok(await updateTicketFields({ ticketId: t.id, version: t.version, description: `Tidied (${source})` }));
        const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.description, source).toBe(`Tidied (${source})`);
      }
    });
  });

  describe("updateTicketFields — the Wave A columns", () => {
    it("stamps complaintFiledAt the first time isComplaint goes true, and never re-stamps it (Decision #64)", async () => {
      const { prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();

      const v1 = ok(await updateTicketFields({ ticketId: t.id, version: t.version, isComplaint: true }));
      const flagged = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(flagged.isComplaint).toBe(true);
      expect(flagged.complaintFiledAt).not.toBeNull();
      const filedAt = flagged.complaintFiledAt;

      const rows = await auditFor(t.id, "TICKET_FIELD_CHANGED");
      expect(rows.map((r) => r.fieldChanged).sort()).toEqual(["complaintFiledAt", "isComplaint"]);
      expect(rows.find((r) => r.fieldChanged === "isComplaint")?.oldValue).toBe("false");
      expect(rows.find((r) => r.fieldChanged === "isComplaint")?.newValue).toBe("true");

      const v2 = ok(await updateTicketFields({ ticketId: t.id, version: v1.version, isComplaint: false }));
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).complaintFiledAt).toEqual(filedAt);

      ok(await updateTicketFields({ ticketId: t.id, version: v2.version, isComplaint: true }));
      const reflagged = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(reflagged.isComplaint).toBe(true);
      expect(reflagged.complaintFiledAt).toEqual(filedAt);
    });

    it("normalizes an adopted requesterEmail and diffs the other Wave A columns into TICKET_FIELD_CHANGED rows", async () => {
      const { prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      // A phone-only ticket getting its FIRST address: an adoption, not a redirect, so it stays on
      // `updateTicketFields`. The redirect path has its own describe block below.
      const t = await newTicket({ requesterEmail: null, requesterPhone: "+15550009999" });

      ok(
        await updateTicketFields({
          ticketId: t.id,
          version: t.version,
          requesterEmail: "  Margaret.Thompson@EXAMPLE.com ",
          requesterPhone: "+1 (555) 123-4567",
          escalationTarget: "COMPLIANCE",
          followUpAt: "2026-10-01T09:00:00Z",
          externalRef: "ACAT-778812",
          brand: "CEDAR_RIDGE_DIRECT",
        }),
      );

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.requesterEmail).toBe("margaret.thompson@example.com");
      expect(after.requesterPhone).toBe("+15551234567");
      expect(after.escalationTarget).toBe("COMPLIANCE");
      expect(after.followUpAt?.toISOString()).toBe("2026-10-01T09:00:00.000Z");
      expect(after.externalRef).toBe("ACAT-778812");
      expect(after.brand).toBe("CEDAR_RIDGE_DIRECT");

      const changed = (await auditFor(t.id, "TICKET_FIELD_CHANGED")).map((r) => r.fieldChanged).sort();
      expect(changed).toEqual([
        "brand",
        "escalationTarget",
        "externalRef",
        "followUpAt",
        "requesterEmail",
        "requesterPhone",
      ]);
    });

    it("refuses to leave a ticket with neither an email nor a phone (DB CHECK, refused in the app)", async () => {
      const { prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();

      const r = await updateTicketFields({ ticketId: t.id, version: t.version, requesterEmail: null });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("VALIDATION");
        expect(r.fieldErrors?.requesterEmail?.length).toBeGreaterThan(0);
      }
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).requesterEmail).not.toBeNull();
    });

    it("clearing the email is allowed when a phone remains — the phone-only ticket (Decision #62)", async () => {
      const { prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ requesterPhone: "+15550001111" });

      ok(await updateTicketFields({ ticketId: t.id, version: t.version, requesterEmail: null }));
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.requesterEmail).toBeNull();
      expect(after.requesterPhone).toBe("+15550001111");
    });
  });

  /**
   * Fix round 1 (security). `Ticket.requesterEmail` is the authorization subject of the client API
   * (`/api/client/tickets/[id]` compares it for equality with `X-Requester-Email`) and the destination
   * of every outbound reply, so re-pointing it at another address is an access-control decision. These
   * prove the split: adopt and clear stay on `updateTicketFields`; a REDIRECT only happens through
   * `changeRequesterEmail`, with a confirmation and a recorded reason, and never on a complaint or an
   * escalated ticket.
   */
  describe("requester-address redirect is privileged", () => {
    it("updateTicketFields refuses to re-point an existing address, and writes nothing", async () => {
      const { prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();
      const before = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });

      const r = await updateTicketFields({
        ticketId: t.id,
        version: t.version,
        requesterEmail: "attacker@elsewhere.example",
        subject: "A subject edit riding along with the redirect",
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("VALIDATION");
        expect(r.fieldErrors?.requesterEmail?.length).toBeGreaterThan(0);
      }

      // The whole transaction is refused: the subject edit in the same call did not land either.
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.requesterEmail).toBe(before.requesterEmail);
      expect(after.subject).toBe(before.subject);
      expect(after.version).toBe(before.version);
      expect(await auditFor(t.id, "TICKET_FIELD_CHANGED")).toHaveLength(0);
    });

    it("changeRequesterEmail re-points the address and records the reason on a marked audit row", async () => {
      const { prisma, changeRequesterEmail } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();
      const before = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });

      const out = ok(
        await changeRequesterEmail({
          ticketId: t.id,
          version: t.version,
          requesterEmail: "  Margaret.Thompson@EXAMPLE.com ",
          reason: "Client confirmed the address was mistyped at intake; verified on the recorded call.",
          confirm: true,
        }),
      );
      expect(out.changed).toBe(true);
      expect(out.requesterEmail).toBe("margaret.thompson@example.com");
      expect(out.version).toBe(t.version + 1);

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.requesterEmail).toBe("margaret.thompson@example.com");
      expect(after.version).toBe(t.version + 1);

      const rows = (await auditFor(t.id, "TICKET_REQUESTER_EMAIL_CHANGED")).filter((r) => r.fieldChanged === "requesterEmail");
      expect(rows).toHaveLength(1);
      // Old and new live in the hash-chained columns; the marker and the reason ride in metadata.
      expect(rows[0].oldValue).toBe(before.requesterEmail);
      expect(rows[0].newValue).toBe("margaret.thompson@example.com");
      const meta = rows[0].metadata as {
        privileged?: string;
        confirmed?: boolean;
        reason?: string;
        grantsClientApiAccess?: boolean;
      };
      expect(meta.privileged).toBe("REQUESTER_EMAIL_CHANGED");
      expect(meta.confirmed).toBe(true);
      expect(meta.grantsClientApiAccess).toBe(true);
      expect(meta.reason).toContain("mistyped at intake");
    });

    it("requesterEmailChangedAt reports the redirect, and stays null for an ADOPTED first address", async () => {
      const { changeRequesterEmail, prisma, requesterEmailChangedAt, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);

      // A phone-only ticket that ADOPTS a first address has nothing redirected: the
      // banner must not fire on it, which is what the non-null `oldValue` filter is there for.
      const phoneOnly = await newTicket({ requesterEmail: null, requesterPhone: "+15125550142" });
      expect(await requesterEmailChangedAt(phoneOnly.id)).toBeNull();
      ok(
        await updateTicketFields({
          ticketId: phoneOnly.id,
          version: phoneOnly.version,
          requesterEmail: "adopted.first.address@example.com",
        }),
      );
      expect(await requesterEmailChangedAt(phoneOnly.id)).toBeNull();

      const t = await newTicket();
      expect(await requesterEmailChangedAt(t.id)).toBeNull();
      ok(
        await changeRequesterEmail({
          ticketId: t.id,
          version: t.version,
          requesterEmail: "banner.probe@example.com",
          reason: "Client asked us to correspond with their new work address from now on.",
          confirm: true,
        }),
      );

      const at = await requesterEmailChangedAt(t.id);
      expect(at).not.toBeNull();
      const row = (await auditFor(t.id, "TICKET_REQUESTER_EMAIL_CHANGED")).filter((r) => r.fieldChanged === "requesterEmail");
      expect(row).toHaveLength(1);
      expect(at?.toISOString()).toBe(row[0].occurredAt.toISOString());
      // Unaudited read: it returns a timestamp, so it must not have written a view row of its own.
      expect(await prisma.auditLog.count({ where: { ticketId: t.id, action: "TICKET_VIEWED" } })).toBe(0);
    });

    it("sanitizes the reason before it reaches the ledger (I4)", async () => {
      const { changeRequesterEmail } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();

      ok(
        await changeRequesterEmail({
          ticketId: t.id,
          version: t.version,
          requesterEmail: "redirect.sanitized@example.com",
          reason: "Mail to the old address bounced; account number 123456789012 confirmed by phone.",
          confirm: true,
        }),
      );

      const rows = (await auditFor(t.id, "TICKET_REQUESTER_EMAIL_CHANGED")).filter((r) => r.fieldChanged === "requesterEmail");
      const reason = (rows[0].metadata as { reason?: string }).reason ?? "";
      expect(reason).not.toContain("123456789012");
      expect(reason).toContain("[REDACTED:");
      // The PII_REDACTED row is written in the same transaction, counts only, never the value.
      const pii = await auditFor(t.id, "PII_REDACTED");
      expect(pii).toHaveLength(1);
      expect(pii[0].fieldChanged).toBe("reason");
      expect(pii[0].newValue).toMatch(/ACCOUNT=[1-9]/);
    });

    it("refuses the redirect on a complaint, at any group", async () => {
      const { prisma, changeRequesterEmail } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ isComplaint: true });

      const r = await changeRequesterEmail({
        ticketId: t.id,
        version: t.version,
        requesterEmail: "elsewhere@example.com",
        reason: "Client says to use the new address from now on.",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("VALIDATION");
        expect(r.fieldErrors?.requesterEmail?.[0]).toContain("complaint");
      }
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.requesterEmail).not.toBe("elsewhere@example.com");
      expect(after.version).toBe(t.version);
    });

    it("refuses the redirect on an escalated ticket", async () => {
      const { prisma, changeRequesterEmail } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ escalationTarget: "FRAUD" });

      const r = await changeRequesterEmail({
        ticketId: t.id,
        version: t.version,
        requesterEmail: "elsewhere@example.com",
        reason: "Client says to use the new address from now on.",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("VALIDATION");
        expect(r.fieldErrors?.requesterEmail?.[0]).toContain("FRAUD");
      }
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).version).toBe(t.version);
    });

    it("refuses an unconfirmed call and a throwaway reason", async () => {
      const { prisma, changeRequesterEmail } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();

      const unconfirmed = await changeRequesterEmail({
        ticketId: t.id,
        version: t.version,
        requesterEmail: "elsewhere@example.com",
        reason: "Client asked for the change on today's call.",
        confirm: false as unknown as true,
      });
      expect(unconfirmed.ok).toBe(false);
      if (!unconfirmed.ok) expect(unconfirmed.code).toBe("VALIDATION");

      const thin = await changeRequesterEmail({
        ticketId: t.id,
        version: t.version,
        requesterEmail: "elsewhere@example.com",
        reason: "typo",
        confirm: true,
      });
      expect(thin.ok).toBe(false);
      if (!thin.ok) {
        expect(thin.code).toBe("VALIDATION");
        expect(thin.fieldErrors?.reason?.length).toBeGreaterThan(0);
      }

      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).version).toBe(t.version);
    });

    it("sends adoption back to updateTicketFields rather than duplicating the first-address path", async () => {
      const { prisma, changeRequesterEmail } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ requesterEmail: null, requesterPhone: "+15550002222" });

      const r = await changeRequesterEmail({
        ticketId: t.id,
        version: t.version,
        requesterEmail: "first.address@example.com",
        reason: "Client supplied an email address on today's call.",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("VALIDATION");
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).requesterEmail).toBeNull();
    });

    it("is a no-op when the address is already the stored one, and writes no audit row", async () => {
      const { prisma, changeRequesterEmail } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();
      const current = (await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).requesterEmail as string;

      const out = ok(
        await changeRequesterEmail({
          ticketId: t.id,
          version: t.version,
          requesterEmail: current.toUpperCase(),
          reason: "Re-confirming the address already on file after a callback.",
          confirm: true,
        }),
      );
      expect(out.changed).toBe(false);
      expect(out.version).toBe(t.version);
      expect(await auditFor(t.id, "TICKET_FIELD_CHANGED")).toHaveLength(0);
    });

    it("conflicts on a stale version and writes nothing", async () => {
      const { prisma, changeRequesterEmail } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();

      ok(
        await changeRequesterEmail({
          ticketId: t.id,
          version: t.version,
          requesterEmail: "redirect.one@example.com",
          reason: "First redirect, confirmed with the client by phone.",
          confirm: true,
        }),
      );

      const stale = await changeRequesterEmail({
        ticketId: t.id,
        version: t.version,
        requesterEmail: "redirect.two@example.com",
        reason: "Second redirect from a stale screen, should not land.",
        confirm: true,
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.code).toBe("CONFLICT");
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).requesterEmail).toBe(
        "redirect.one@example.com",
      );
    });

    it("still requires WRITE on the queue — compliance_officers is refused and the denial is recorded", async () => {
      const { prisma, changeRequesterEmail } = mods();
      const t = await newTicket();
      hoisted.viewer = viewerOf(COMPLIANCE_USER_ID, ["compliance_officers"]);

      const r = await changeRequesterEmail({
        ticketId: t.id,
        version: t.version,
        requesterEmail: "elsewhere@example.com",
        reason: "Reviewing the file and updating the address.",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("FORBIDDEN");
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).requesterEmail).not.toBe(
        "elsewhere@example.com",
      );
      expect((await auditFor(t.id, "AUTHZ_DENIED")).length).toBeGreaterThan(0);
    });
  });

  /**
   * Fix round 2 (security). The round-1 split refused a REDIRECT but permitted CLEAR and ADOPT
   * independently, so two ordinary `updateTicketFields` calls composed into exactly the redirect it
   * fenced — bypassing the confirmation, the reason, the complaint/escalation refusal and the
   * `privileged` audit marker. These prove the pair is now one decision.
   */
  describe("CLEAR-then-ADOPT cannot compose into a redirect", () => {
    it("refuses the whole sequence on a complaint ticket, at the first step and the second", async () => {
      const { prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ isComplaint: true, requesterPhone: "+14155550123" });
      const before = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });

      // Step 1 of the bypass: drop the address while the phone keeps the DB CHECK satisfied. The
      // correspondence record on a complaint is fixed, so this is refused now.
      const cleared = await updateTicketFields({ ticketId: t.id, version: t.version, requesterEmail: null });
      expect(cleared.ok).toBe(false);
      if (!cleared.ok) {
        expect(cleared.code).toBe("VALIDATION");
        expect(cleared.fieldErrors?.requesterEmail?.[0]).toContain("complaint");
      }

      // Step 2, attempted regardless: with the address still in place it is a plain REDIRECT.
      const adopted = await updateTicketFields({
        ticketId: t.id,
        version: t.version,
        requesterEmail: "attacker@elsewhere.example",
      });
      expect(adopted.ok).toBe(false);
      if (!adopted.ok) {
        expect(adopted.code).toBe("VALIDATION");
        expect(adopted.fieldErrors?.requesterEmail?.length).toBeGreaterThan(0);
      }

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.requesterEmail).toBe(before.requesterEmail);
      expect(after.version).toBe(before.version);
      expect((await auditFor(t.id, "TICKET_FIELD_CHANGED")).filter((r) => r.fieldChanged === "requesterEmail")).toHaveLength(
        0,
      );
    });

    it("refuses the clear on an escalated ticket too", async () => {
      const { prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ escalationTarget: "FRAUD", requesterPhone: "+14155550124" });

      const r = await updateTicketFields({ ticketId: t.id, version: t.version, requesterEmail: null });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("VALIDATION");
        expect(r.fieldErrors?.requesterEmail?.[0]).toContain("FRAUD");
      }
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).requesterEmail).not.toBeNull();
    });

    it("refuses the ADOPT half on an ordinary ticket once an address has already been dropped", async () => {
      const { prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ requesterPhone: "+14155550125" });

      // The clear itself stays ordinary on a ticket that is neither a complaint nor escalated.
      const v1 = ok(await updateTicketFields({ ticketId: t.id, version: t.version, requesterEmail: null }));
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).requesterEmail).toBeNull();

      // …but the ticket is no longer address-less by history, so this is the second half of a
      // redirect, not a first adoption.
      const r = await updateTicketFields({
        ticketId: t.id,
        version: v1.version,
        requesterEmail: "attacker@elsewhere.example",
        subject: "A subject edit riding along with the second half",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("VALIDATION");
        expect(r.fieldErrors?.requesterEmail?.[0]).toContain("Change requester address");
      }

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.requesterEmail).toBeNull();
      expect(after.subject).not.toContain("second half");
      expect(after.version).toBe(v1.version);
    });

    it("routes the re-adoption to changeRequesterEmail, which records it as a privileged two-step redirect", async () => {
      const { changeRequesterEmail, prisma, requesterEmailChangedAt, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ requesterPhone: "+14155550126" });
      const original = (await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).requesterEmail as string;

      const v1 = ok(await updateTicketFields({ ticketId: t.id, version: t.version, requesterEmail: null }));

      const out = ok(
        await changeRequesterEmail({
          ticketId: t.id,
          version: v1.version,
          requesterEmail: "Corrected.Address@Example.com",
          reason: "Address was mistyped at intake and cleared; corrected on the recorded callback.",
          confirm: true,
        }),
      );
      expect(out.changed).toBe(true);
      expect(out.requesterEmail).toBe("corrected.address@example.com");

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.requesterEmail).toBe("corrected.address@example.com");
      expect(after.version).toBe(v1.version + 1);

      // BOTH actions, in seq order: the CLEAR is an ordinary `updateTicketFields` edit and keeps
      // `TICKET_FIELD_CHANGED`; only the privileged re-adoption carries Wave B's dedicated action.
      // Reading them together is the point of the test — the two steps must not compose into a
      // redirect that nobody can see as one.
      const rows = [
        ...(await auditFor(t.id, "TICKET_FIELD_CHANGED")),
        ...(await auditFor(t.id, "TICKET_REQUESTER_EMAIL_CHANGED")),
      ]
        .filter((r) => r.fieldChanged === "requesterEmail")
        .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      // The clear's row, then the re-adoption's.
      expect(rows).toHaveLength(2);
      expect(rows[0].oldValue).toBe(original);
      expect(rows[0].newValue).toBeNull();
      const meta = rows[1].metadata as { privileged?: string; readoptedAfterClear?: boolean; previousEmail?: string };
      expect(meta.privileged).toBe("REQUESTER_EMAIL_CHANGED");
      expect(meta.readoptedAfterClear).toBe(true);
      // `oldValue` is faithfully null (that is what the column held); the address the ticket moved
      // away from is carried forward from the ledger so the row still names it.
      expect(rows[1].oldValue).toBeNull();
      expect(meta.previousEmail).toBe(original);

      // The banner fires from the clear onward, so a reader never sees the redirect half unflagged.
      expect(await requesterEmailChangedAt(t.id)).not.toBeNull();
    });

    it("refuses the re-adoption once the ticket has been escalated, so the two-step path meets the absolute rule", async () => {
      const { changeRequesterEmail, prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ requesterPhone: "+14155550127" });

      const v1 = ok(await updateTicketFields({ ticketId: t.id, version: t.version, requesterEmail: null }));
      const v2 = ok(await updateTicketFields({ ticketId: t.id, version: v1.version, escalationTarget: "FRAUD" }));

      const r = await changeRequesterEmail({
        ticketId: t.id,
        version: v2.version,
        requesterEmail: "attacker@elsewhere.example",
        reason: "Client asked us to use this address from now on, per today's call.",
        confirm: true,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("VALIDATION");
        expect(r.fieldErrors?.requesterEmail?.[0]).toContain("FRAUD");
      }

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.requesterEmail).toBeNull();
      expect(after.version).toBe(v2.version);
    });

    it("still lets a genuinely address-less ticket adopt its first address", async () => {
      const { prisma, updateTicketFields } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ requesterEmail: null, requesterPhone: "+14155550128" });

      ok(
        await updateTicketFields({
          ticketId: t.id,
          version: t.version,
          requesterEmail: "first.address.round.two@example.com",
        }),
      );
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).requesterEmail).toBe(
        "first.address.round.two@example.com",
      );
    });
  });

  describe("assignToMe", () => {
    it("assigns the viewer, auto-opens a NEW ticket (§b.6) and writes one TICKET_ASSIGNED row", async () => {
      const { prisma, assignToMe } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ status: "NEW" });

      const out = ok(await assignToMe({ ticketId: t.id, version: t.version }));
      expect(out.assignee.id).toBe(OPS_USER_ID);
      expect(out.version).toBe(t.version + 1);

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.assigneeId).toBe(OPS_USER_ID);
      expect(after.status).toBe("OPEN");

      const assigned = await auditFor(t.id, "TICKET_ASSIGNED");
      expect(assigned).toHaveLength(1);
      expect(assigned[0].oldValue).toBeNull();
      expect(assigned[0].newValue).toBe(OPS_USER_ID);
      const opened = await auditFor(t.id, "TICKET_STATUS_CHANGED");
      expect(opened).toHaveLength(1);
      expect(opened[0].newValue).toBe("OPEN");
    });

    it("is a no-op that still honors the token when the ticket is already mine", async () => {
      const { assignToMe } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket();

      const first = ok(await assignToMe({ ticketId: t.id, version: t.version }));
      const again = ok(await assignToMe({ ticketId: t.id, version: first.version }));
      expect(again.version).toBe(first.version);
      expect(await auditFor(t.id, "TICKET_ASSIGNED")).toHaveLength(1);

      const stale = await assignToMe({ ticketId: t.id, version: t.version });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.code).toBe("CONFLICT");
    });

    it("a viewer without WRITE on the queue is refused (§b.4)", async () => {
      const { prisma, assignToMe } = mods();
      const t = await newTicket();
      hoisted.viewer = viewerOf(COMPLIANCE_USER_ID, ["compliance_officers"]);

      const r = await assignToMe({ ticketId: t.id, version: t.version });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("FORBIDDEN");
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).assigneeId).toBeNull();
    });
  });

  /**
   * Fix round 1 (INVARIANTS/AUDIT/DATA). `Ticket.resolution` had no writer on any ordinary resolve
   * path, so four of its seven values were unreachable and `resolution-mix` could only ever answer
   * "Not recorded". These prove the writer, its three refusals and the reopen clear. Every assertion
   * is scoped to the tickets this run created (`it_ta_ticket_<RUN>_*`).
   */
  describe("changeTicketStatus — the recorded outcome (CONTRACT §1.1)", () => {
    async function resolutionRowsFor(ticketId: string) {
      return (await auditFor(ticketId, "TICKET_FIELD_CHANGED")).filter((r) => r.fieldChanged === "resolution");
    }

    it("writes the outcome with the status, in one transaction, with its own audited field row", async () => {
      const { prisma, changeTicketStatus } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ category: "PLANNING_UPDATE" });

      const out = ok(await changeTicketStatus({ ticketId: t.id, version: t.version, status: "RESOLVED", resolution: "ANSWERED" }));
      expect(out.status).toBe("RESOLVED");

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.resolution).toBe("ANSWERED");
      expect(after.resolvedAt).not.toBeNull();

      const rows = await resolutionRowsFor(t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].oldValue).toBe("NONE");
      expect(rows[0].newValue).toBe("ANSWERED");
      // The outcome row and the status row are the same transaction: one status change, both facts.
      expect(await auditFor(t.id, "TICKET_STATUS_CHANGED")).toHaveLength(1);
    });

    it("leaves the column NONE, and writes no outcome row, when the resolve does not name one", async () => {
      const { prisma, changeTicketStatus } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ category: "PLANNING_UPDATE" });

      ok(await changeTicketStatus({ ticketId: t.id, version: t.version, status: "RESOLVED" }));

      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).resolution).toBe("NONE");
      expect(await resolutionRowsFor(t.id)).toHaveLength(0);
    });

    it("records COMPLETED on the RESOLVED → CLOSED edge when the resolve left it unrecorded", async () => {
      const { prisma, changeTicketStatus } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ category: "PLANNING_UPDATE" });

      const resolved = ok(await changeTicketStatus({ ticketId: t.id, version: t.version, status: "RESOLVED" }));
      ok(await changeTicketStatus({ ticketId: t.id, version: resolved.version, status: "CLOSED", resolution: "COMPLETED" }));

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.resolution).toBe("COMPLETED");
      expect(after.closedAt).not.toBeNull();
      expect((await resolutionRowsFor(t.id)).map((r) => r.newValue)).toEqual(["COMPLETED"]);
    });

    it("refuses DUPLICATE, ENTERED_IN_ERROR and NONE — merge and void own those", async () => {
      const { prisma, changeTicketStatus } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);

      for (const value of ["DUPLICATE", "ENTERED_IN_ERROR", "NONE"] as const) {
        const t = await newTicket({ category: "PLANNING_UPDATE" });
        const r = await changeTicketStatus({ ticketId: t.id, version: t.version, status: "RESOLVED", resolution: value });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.code).toBe("VALIDATION");
          expect(r.fieldErrors?.resolution?.length).toBeGreaterThan(0);
        }
        // Refused as ONE decision: neither the status nor the outcome moved.
        const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.status).toBe("OPEN");
        expect(after.resolution).toBe("NONE");
        expect(await resolutionRowsFor(t.id)).toHaveLength(0);
      }
    });

    it("refuses an outcome on a transition that does not end the ticket", async () => {
      const { prisma, changeTicketStatus } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ category: "PLANNING_UPDATE" });

      const r = await changeTicketStatus({
        ticketId: t.id,
        version: t.version,
        status: "PENDING_CLIENT",
        resolution: "ANSWERED",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("VALIDATION");
        expect(r.fieldErrors?.resolution?.[0]).toContain("PENDING_CLIENT");
      }
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.status).toBe("OPEN");
      expect(after.resolution).toBe("NONE");
    });

    it("refuses to overwrite a recorded outcome, and takes the same one again as a no-op", async () => {
      const { prisma, changeTicketStatus } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ category: "PLANNING_UPDATE" });

      const resolved = ok(
        await changeTicketStatus({ ticketId: t.id, version: t.version, status: "RESOLVED", resolution: "ANSWERED" }),
      );

      const overwrite = await changeTicketStatus({
        ticketId: t.id,
        version: resolved.version,
        status: "CLOSED",
        resolution: "COMPLETED",
      });
      expect(overwrite.ok).toBe(false);
      if (!overwrite.ok) {
        expect(overwrite.code).toBe("VALIDATION");
        expect(overwrite.fieldErrors?.resolution?.[0]).toContain("ANSWERED");
      }
      expect((await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("RESOLVED");

      // Re-sending the SAME outcome is not a change: the close goes through and writes no second row.
      ok(await changeTicketStatus({ ticketId: t.id, version: resolved.version, status: "CLOSED", resolution: "ANSWERED" }));
      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.status).toBe("CLOSED");
      expect(after.resolution).toBe("ANSWERED");
      expect(await resolutionRowsFor(t.id)).toHaveLength(1);
    });

    it("clears the outcome on a reopen, and audits the clear", async () => {
      const { prisma, changeTicketStatus } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ category: "PLANNING_UPDATE" });

      const resolved = ok(
        await changeTicketStatus({ ticketId: t.id, version: t.version, status: "RESOLVED", resolution: "NO_RESPONSE" }),
      );
      ok(await changeTicketStatus({ ticketId: t.id, version: resolved.version, status: "OPEN" }));

      const after = await prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.resolution).toBe("NONE");
      expect(after.resolvedAt).toBeNull();

      expect((await resolutionRowsFor(t.id)).map((r) => [r.oldValue, r.newValue])).toEqual([
        ["NONE", "NO_RESPONSE"],
        ["NO_RESPONSE", "NONE"],
      ]);
    });

    it("writes no outcome row when a ticket that never had one is reopened", async () => {
      const { changeTicketStatus } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ category: "PLANNING_UPDATE" });

      const resolved = ok(await changeTicketStatus({ ticketId: t.id, version: t.version, status: "RESOLVED" }));
      ok(await changeTicketStatus({ ticketId: t.id, version: resolved.version, status: "OPEN" }));

      expect(await resolutionRowsFor(t.id)).toHaveLength(0);
    });
  });

  /**
   * Fix round 2 (QA). A follower's `/inbox` row is read by a person. Its preview used to interpolate
   * `Ticket.status` raw — "Status PENDING_CLIENT → RESOLVED" — which is the schema talking, and the
   * only surface in the app that spelled a status that way; the badge, the filters and the bulk bar
   * all say "Pending client". §7.3 is unaffected: a label is the same enum value, differently spelled.
   *
   * Scoped to the ticket this test creates and the follower it attaches to it.
   */
  describe("changeTicketStatus — the follower preview (§7.3)", () => {
    it("names both statuses with STATUS_LABELS, never the raw enum", async () => {
      const { prisma, changeTicketStatus } = mods();
      hoisted.viewer = viewerOf(OPS_USER_ID, ["ops_team"]);
      const t = await newTicket({ category: "PLANNING_UPDATE" });
      // Somebody OTHER than the actor: `notifyFromEvent` never notifies the person who acted.
      await prisma.ticketFollower.create({
        data: { ticketId: t.id, userId: COMPLIANCE_USER_ID, source: "MANUAL" },
      });

      const pending = ok(await changeTicketStatus({ ticketId: t.id, version: t.version, status: "PENDING_CLIENT" }));
      ok(
        await changeTicketStatus({
          ticketId: t.id,
          version: pending.version,
          status: "RESOLVED",
          resolution: "ANSWERED",
        }),
      );

      const previews = (
        await prisma.notification.findMany({
          where: { ticketId: t.id, userId: COMPLIANCE_USER_ID, kind: "FOLLOWED_UPDATE" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { preview: true },
        })
      ).map((n) => n.preview);

      expect(previews).toEqual(["Status Open → Pending client", "Status Pending client → Resolved"]);
      for (const preview of previews) {
        expect(preview).not.toContain("PENDING_CLIENT");
        expect(preview).not.toContain("RESOLVED");
      }
    });
  });
});
