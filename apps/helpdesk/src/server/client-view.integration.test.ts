/**
 * DB-gated end-to-end proof of I1 (docs/ARCHITECTURE.md §g shared convention 10). Runs only with
 * TEST_DATABASE_URL, against the separate test database — immutability triggers make every Comment and
 * AuditLog row permanent, so this must NEVER point at the dev database. Seeds its own user, queue, ticket
 * and comments (tolerating rows left by earlier runs), then invokes the real route handler:
 *   200  valid bearer + matching X-Requester-Email → body lacks the INTERNAL sentinel, one message, a
 *        CLIENT_API_READ row;
 *   404  wrong email → AUTHZ_DENIED "client:requester-mismatch" with ticketId set and actorEmail client:<wrong>;
 *   404  unknown id → denial row with ticketId null and entityId = the requested id;
 *   401  no / bad bearer → ONE coalesced AUTHZ_DENIED_COALESCED row per client IP per window
 *       , and the caller-controlled id never reaches the ledger at all.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_FORBIDDEN_KEYS } from "@/types/domain";
import type { ClientTicketView } from "@/types/domain";

const TEST_URL = process.env.TEST_DATABASE_URL;
const TOKEN = "it-client-api-token-0123456789abcdefghijklmnop";
if (TEST_URL) {
  // The Prisma datasource reads DATABASE_URL and env.ts is parsed at import: set both BEFORE the first import.
  process.env.DATABASE_URL = TEST_URL;
  process.env.CLIENT_API_TOKEN = TOKEN;
  delete process.env.PUBLIC_DATABASE_URL;
}
const dbModule = TEST_URL ? await import("@/lib/db") : null;
const viewModule = TEST_URL ? await import("@/server/client-view") : null;
const routeModule = TEST_URL ? await import("@/app/api/client/tickets/[id]/route") : null;
/** the by-number route must agree with the by-id route, so this file drives both. */
const byNumberModule = TEST_URL ? await import("@/app/api/client/tickets/by-number/[number]/route") : null;
const throttleModule = TEST_URL ? await import("@/lib/denial-throttle") : null;

function mods() {
  if (!dbModule || !viewModule || !routeModule || !byNumberModule || !throttleModule) {
    throw new Error("DB-gated test invoked without TEST_DATABASE_URL");
  }
  return {
    ...dbModule,
    ...viewModule,
    ...throttleModule,
    GET: routeModule.GET,
    GET_BY_NUMBER: byNumberModule.GET,
  };
}

const RUN = randomUUID().slice(0, 8);
const USER_ID = "it_cv_user_cs";
const USER_EMAIL = "cv.staff@wm-helpdesk.local";
const TICKET_ID = "it_cv_ticket_client_view";
const REQUESTER_EMAIL = "client.view@example.com";
const INTERNAL_COMMENT_ID = "it_cv_comment_internal";
const PUBLIC_COMMENT_ID = "it_cv_comment_public";
const INTERNAL_SENTINEL = "INTERNAL_SENTINEL_7f3a";
const INTERNAL_BODY = `${INTERNAL_SENTINEL} — INTERNAL — not for client; staff-only note`;
const PUBLIC_BODY = "We received your request and will confirm by phone.\n\n---\nGeneral service disclaimer text";

// --- Decision #117 fixtures: the opening entry. Four more tickets, each isolating one branch of the
// --- gate, all owned by the same requester so the identity check is held constant across them.
const EMAIL_TICKET_ID = "it_cv_ticket_email_opening";
const EMAIL_INTERNAL_COMMENT_ID = "it_cv_comment_email_internal";
const EMAIL_PUBLIC_COMMENT_ID = "it_cv_comment_email_public";
const BARE_TICKET_ID = "it_cv_ticket_email_no_comments";
const EMPTY_DESC_TICKET_ID = "it_cv_ticket_email_empty_description";
const VOICEMAIL_TICKET_ID = "it_cv_ticket_voicemail_opening";
const RELEASED_TICKET_ID = "it_cv_ticket_released_hold";
/**
 * A released held-mail body in the shape `releaseDescription` composes: the client's stored preview,
 * then the desk's provenance block. `suspended-intake.integration.test.ts` runs the REAL composer end
 * to end; this fixture exists so the HTTP route itself is proved on the same shape.
 */
const RELEASED_DESCRIPTION = [
  "Please wire the whole balance to my new account.",
  "",
  "--",
  "Released from held inbound mail.",
  "Held because: UNAUTHENTICATED. Received 2026-09-16T11:59:00.000Z at RELEASE_MAILBOX_SENTINEL_3c7d@example.com from nadia@fidelity.test.",
  "Message-ID: <abc@fidelity.test>. Raw message reference: RELEASE_RAWREF_SENTINEL_3c7d.",
  "SENDER NOT VERIFIED: this message failed sender authentication, so the address above is unproven.",
  "Forwarded to the desk by RELEASE_STAFF_SENTINEL_3c7d@example.com.",
  "Reviewer note: RELEASE_NOTE_SENTINEL_3c7d — called back and confirmed",
].join("\n");
/** What the client actually wrote. It must come back to them, first, and attributed to them. */
const CLIENT_OWN_WORDS = "CLIENT_OWN_WORDS_4b1e — I sent the wire form on Tuesday and have heard nothing since.";
/**
 * A voicemail description as the phone system workflow really composes it: the transcript, then desk-internal
 * material. This is the string the VOICEMAIL exclusion exists to keep off a client surface.
 */
const VOICEMAIL_DESCRIPTION = [
  "Voicemail transcript (phone system):",
  "",
  "Hi, it is about my transfer, please call me back.",
  "",
  "Caller: +15551234567",
  "Line: CS inbound VOICEMAIL_LINE_SENTINEL_9a2f",
  "Duration: 34s",
  "Recording: https://example.invalid/recordings/VOICEMAIL_RECORDING_SENTINEL_9a2f",
].join("\n");

function requestFor(id: string, headers: Record<string, string>, caseTag: string): { req: Request; requestId: string } {
  const requestId = `itcv-${caseTag}-${RUN}`;
  const req = new Request(`http://localhost/api/client/tickets/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { "x-request-id": requestId, "user-agent": `it-client-view/${RUN}`, ...headers },
  });
  return { req, requestId };
}

/** Whole-row text for "this string is nowhere on the permanent row" assertions (`seq` is a BigInt). */
function rowText(row: unknown): string {
  return JSON.stringify(row, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.add(k);
    collectKeys(v, out);
  }
  return out;
}

describe.skipIf(!TEST_URL)("client view integration (TEST_DATABASE_URL)", () => {
  beforeAll(async () => {
    const { prisma } = mods();
    await prisma.queue.upsert({
      where: { key: "CLIENT_SERVICE" },
      update: {},
      create: { key: "CLIENT_SERVICE", name: "Client Service", description: "integration fixture", sortOrder: 2 },
    });
    const queue = await prisma.queue.findUniqueOrThrow({ where: { key: "CLIENT_SERVICE" } });
    await prisma.user.upsert({
      where: { id: USER_ID },
      update: { groups: ["client_services"], isActive: true },
      create: {
        id: USER_ID,
        email: USER_EMAIL,
        name: "Casey Service (it)",
        groups: ["client_services"],
        emailVerified: new Date(),
        isActive: true,
      },
    });
    const createdAt = new Date("2026-09-16T09:00:00.000Z");
    await prisma.ticket.upsert({
      where: { id: TICKET_ID },
      update: {},
      create: {
        id: TICKET_ID,
        subject: "Portal reset for client view probe",
        description: "Staff-only description — must never reach the client API",
        requesterName: "Client View Requester",
        requesterEmail: REQUESTER_EMAIL,
        category: "PORTAL_RESET",
        priority: "HIGH",
        status: "OPEN",
        queue: { connect: { id: queue.id } },
        createdBy: { connect: { id: USER_ID } },
        slaFirstResponseMinutes: 60,
        slaResolutionMinutes: 480,
        firstResponseDueAt: new Date(createdAt.getTime() + 60 * 60_000),
        resolutionDueAt: new Date(createdAt.getTime() + 480 * 60_000),
      },
    });
    // Comments are immutable (no upsert through the extension): find-or-create.
    if ((await prisma.comment.findUnique({ where: { id: INTERNAL_COMMENT_ID } })) === null) {
      await prisma.comment.create({
        data: {
          id: INTERNAL_COMMENT_ID,
          body: INTERNAL_BODY,
          visibility: "INTERNAL",
          disclaimerKey: "NONE",
          ticket: { connect: { id: TICKET_ID } },
          author: { connect: { id: USER_ID } },
        },
      });
    }
    if ((await prisma.comment.findUnique({ where: { id: PUBLIC_COMMENT_ID } })) === null) {
      await prisma.comment.create({
        data: {
          id: PUBLIC_COMMENT_ID,
          body: PUBLIC_BODY,
          visibility: "PUBLIC",
          disclaimerKey: "GENERAL_SERVICE",
          ticket: { connect: { id: TICKET_ID } },
          author: { connect: { id: USER_ID } },
        },
      });
    }

    // --- Decision #117 fixtures ---------------------------------------------------------------
    const ticketFixture = (
      id: string,
      source: "EMAIL" | "VOICEMAIL",
      description: string,
      subject: string,
      externalId?: string,
    ) => ({
      externalId,
      id,
      subject,
      description,
      source,
      requesterName: "Client View Requester",
      requesterEmail: REQUESTER_EMAIL,
      category: "WIRE_TRANSFER" as const,
      priority: "HIGH" as const,
      status: "OPEN" as const,
      queue: { connect: { id: queue.id } },
      createdBy: { connect: { id: USER_ID } },
      slaFirstResponseMinutes: 60,
      slaResolutionMinutes: 480,
      firstResponseDueAt: new Date(createdAt.getTime() + 60 * 60_000),
      resolutionDueAt: new Date(createdAt.getTime() + 480 * 60_000),
      createdAt,
    });

    await prisma.ticket.upsert({
      where: { id: EMAIL_TICKET_ID },
      update: {},
      create: ticketFixture(EMAIL_TICKET_ID, "EMAIL", CLIENT_OWN_WORDS, "Wire form sent Tuesday"),
    });
    await prisma.ticket.upsert({
      where: { id: BARE_TICKET_ID },
      update: {},
      create: ticketFixture(BARE_TICKET_ID, "EMAIL", CLIENT_OWN_WORDS, "Nobody has replied yet"),
    });
    await prisma.ticket.upsert({
      where: { id: EMPTY_DESC_TICKET_ID },
      update: {},
      create: ticketFixture(EMPTY_DESC_TICKET_ID, "EMAIL", "", "An email with no body at all"),
    });
    await prisma.ticket.upsert({
      where: { id: VOICEMAIL_TICKET_ID },
      update: {},
      create: ticketFixture(VOICEMAIL_TICKET_ID, "VOICEMAIL", VOICEMAIL_DESCRIPTION, "Voicemail from +15551234567"),
    });
    await prisma.ticket.upsert({
      where: { id: RELEASED_TICKET_ID },
      update: {},
      create: ticketFixture(
        RELEASED_TICKET_ID,
        "EMAIL",
        RELEASED_DESCRIPTION,
        "Wire the balance out today",
        `intake-release.it_cv_${RUN}`,
      ),
    });

    if ((await prisma.comment.findUnique({ where: { id: EMAIL_INTERNAL_COMMENT_ID } })) === null) {
      await prisma.comment.create({
        data: {
          id: EMAIL_INTERNAL_COMMENT_ID,
          body: INTERNAL_BODY,
          visibility: "INTERNAL",
          disclaimerKey: "NONE",
          ticket: { connect: { id: EMAIL_TICKET_ID } },
          author: { connect: { id: USER_ID } },
        },
      });
    }
    if ((await prisma.comment.findUnique({ where: { id: EMAIL_PUBLIC_COMMENT_ID } })) === null) {
      await prisma.comment.create({
        data: {
          id: EMAIL_PUBLIC_COMMENT_ID,
          body: PUBLIC_BODY,
          visibility: "PUBLIC",
          disclaimerKey: "GENERAL_SERVICE",
          // Explicitly AFTER the ticket, so "the opening entry comes first" is a claim about order
          // and not an accident of two rows sharing a timestamp.
          createdAt: new Date(createdAt.getTime() + 30 * 60_000),
          ticket: { connect: { id: EMAIL_TICKET_ID } },
          author: { connect: { id: USER_ID } },
        },
      });
    }
  });

  afterAll(async () => {
    if (!dbModule) return;
    await dbModule.prisma.$disconnect();
    await dbModule.publicDb.$disconnect();
  });

  // The coalescing window is process-global and keyed by route + client IP, and every request here
  // arrives from the same (absent) address. Reset it so each test opens its own window; the test that
  // proves coalescing does its own repeat probes deliberately.
  beforeEach(() => {
    if (!throttleModule) return;
    throttleModule.resetDenialThrottle();
  });

  it("selectPublicComments reads only PUBLIC rows from the view and exposes neither visibility nor authorId", async () => {
    const { selectPublicComments } = mods();
    const rows = await selectPublicComments(TICKET_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(PUBLIC_COMMENT_ID);
    expect(rows[0].body).toBe(PUBLIC_BODY);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    // Wave A added exactly ONE column: authorKind, a three-value enum that says
    // whether the requester wrote the message. `visibility` and `authorId` are still absent, and
    // this assertion is the thing that fails if anyone widens the view again.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "authorKind",
      "body",
      "createdAt",
      "disclaimerKey",
      "id",
      // the view gained `retracted`, a boolean, and blanks `body` when it is
      // true. Still no `visibility` and no `authorId`, and this assertion is still the thing that
      // fails if anyone widens the view again.
      "retracted",
      "ticketId",
    ]);
    expect(rows[0].authorKind).toBe("STAFF");
    expect(JSON.stringify(rows)).not.toContain(INTERNAL_SENTINEL);
    expect(JSON.stringify(rows)).not.toContain(USER_ID);
  });

  it("a REQUESTER-authored PUBLIC row renders as \"You\" and never as a staff identity (I1, Decision #65)", async () => {
    const { toClientTicketView, authorDisplayFor, assertNoInternalLeak, selectPublicComments } = mods();
    expect(authorDisplayFor("REQUESTER")).toBe("You");
    expect(authorDisplayFor("STAFF")).toBe("Your Service Team");
    expect(authorDisplayFor("SYSTEM")).toBe("Your Service Team");

    const rows = await selectPublicComments(TICKET_ID);
    const view = toClientTicketView(
      {
        id: TICKET_ID,
        number: 1,
        subject: "s",
        status: "OPEN",
        priority: "STANDARD",
        category: "OTHER",
        createdAt: new Date(),
        updatedAt: new Date(),
        resolvedAt: null,
      },
      rows,
      // Decision #117 (amended): the opening entry is the third argument, read from the
      // "ClientVisibleOpeningMessage" view. This ticket is STAFF_FORM, so the view holds no row for it
      // and `null` is exactly what the read path would pass — this assertion about AUTHORSHIP keeps
      // reading exactly the one comment it always read. The opening entry is proved separately below.
      null,
    );
    expect(view.messages[0].authorDisplay).toBe("Your Service Team");
    // The DTO carries the display string and nothing else about authorship.
    expect(Object.keys(view.messages[0]).sort()).toEqual([
      "authorDisplay",
      "body",
      "createdAt",
      "disclaimerKey",
      "id",
      // The one Wave B fact a client is owed: THAT a message was withdrawn, never what it said.
      "retracted",
    ]);
    expect(() => assertNoInternalLeak(view)).not.toThrow();
  });

  it("200: valid bearer + matching requester → view without the sentinel, one message, CLIENT_API_READ written", async () => {
    const { GET, prisma } = mods();
    const { req, requestId } = requestFor(
      TICKET_ID,
      { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL.toUpperCase() },
      "ok",
    );
    const res = await GET(req, { params: Promise.resolve({ id: TICKET_ID }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(INTERNAL_SENTINEL);
    expect(text).not.toContain("not for client");
    expect(text).not.toContain("Staff-only description");
    expect(text).not.toContain(USER_EMAIL);
    expect(text).not.toContain(REQUESTER_EMAIL);
    const body = JSON.parse(text) as ClientTicketView;
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].body).toBe(PUBLIC_BODY);
    expect(body.messages[0].authorDisplay).toBe("Your Service Team");
    expect(body.messages[0].disclaimerKey).toBe("GENERAL_SERVICE");
    expect(body.reference).toMatch(/^HD-\d+$/);
    expect(body.subject).toBe("Portal reset for client view probe");
    const keys = collectKeys(body);
    for (const forbidden of CLIENT_FORBIDDEN_KEYS) expect(keys.has(forbidden), forbidden).toBe(false);

    const rows = await prisma.auditLog.findMany({ where: { requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("CLIENT_API_READ");
    expect(rows[0].actorEmail).toBe(`client:${REQUESTER_EMAIL}`);
    expect(rows[0].actorId).toBeNull();
    expect(rows[0].ticketId).toBe(TICKET_ID);
    expect(rows[0].entityId).toBe(TICKET_ID);
    expect(rows[0].entityType).toBe("TICKET");
    expect(rows[0].ipAddress).toBe("unknown");
    expect(rows[0].userAgent).toBe(`it-client-view/${RUN}`);
  });

  it("404: requester mismatch → AUTHZ_DENIED client:requester-mismatch with ticketId set and actorEmail client:<wrong>", async () => {
    const { GET, prisma } = mods();
    const wrong = "wrong.person@example.com";
    const { req, requestId } = requestFor(TICKET_ID, { authorization: `Bearer ${TOKEN}`, "x-requester-email": wrong }, "mismatch");
    const res = await GET(req, { params: Promise.resolve({ id: TICKET_ID }) });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "not_found" });
    expect(text).not.toContain(INTERNAL_SENTINEL);

    const rows = await prisma.auditLog.findMany({ where: { requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("AUTHZ_DENIED");
    expect(rows[0].newValue).toBe("client:requester-mismatch");
    expect(rows[0].fieldChanged).toBe("capability");
    expect(rows[0].ticketId).toBe(TICKET_ID);
    expect(rows[0].entityId).toBe(TICKET_ID);
    expect(rows[0].entityType).toBe("TICKET");
    expect(rows[0].actorEmail).toBe(`client:${wrong}`);
    expect(rows[0].actorId).toBeNull();
  });

  it("404: unknown ticket id → denial row with ticketId null and entityId = the requested id", async () => {
    const { GET, prisma } = mods();
    const unknownId = `no_such_ticket_${RUN}`;
    const { req, requestId } = requestFor(unknownId, { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL }, "unknown");
    const res = await GET(req, { params: Promise.resolve({ id: unknownId }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });

    const rows = await prisma.auditLog.findMany({ where: { requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("AUTHZ_DENIED");
    expect(rows[0].newValue).toBe("client:requester-mismatch");
    expect(rows[0].ticketId).toBeNull();
    expect(rows[0].entityId).toBe(unknownId);
    expect(rows[0].actorEmail).toBe(`client:${REQUESTER_EMAIL}`);
  });

  it("401: no bearer and no email → one coalesced row naming the ROUTE, not the requested ticket", async () => {
    const { GET, prisma } = mods();
    const { req, requestId } = requestFor(TICKET_ID, {}, "anon");
    const res = await GET(req, { params: Promise.resolve({ id: TICKET_ID }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });

    const rows = await prisma.auditLog.findMany({ where: { requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("AUTHZ_DENIED_COALESCED");
    expect(rows[0].newValue).toBe("client:unauthenticated x1");
    expect(rows[0].actorEmail).toBe("client:anonymous");
    expect(rows[0].ticketId).toBeNull();
    expect(rows[0].entityType).toBe("ENDPOINT");
    // The entity is the ROUTE PATTERN. The caller-controlled id is not recorded at all on this path —
    // strictly stronger than bounding it, and what makes the coalescing possible.
    expect(rows[0].entityId).toBe("/api/client/tickets/[id]");
    expect(rows[0].metadata).toMatchObject({ count: 1, route: "/api/client/tickets/[id]" });
  });

  it("a burst of unauthenticated probes writes ONE row that carries the count (Decision #71)", async () => {
    const { GET, prisma } = mods();
    const probes = 5;
    const requestIds: string[] = [];
    for (let i = 0; i < probes; i++) {
      const { req, requestId } = requestFor(`${TICKET_ID}-burst-${i}`, {}, `burst${i}`);
      requestIds.push(requestId);
      expect((await GET(req, { params: Promise.resolve({ id: `${TICKET_ID}-burst-${i}` }) })).status).toBe(401);
    }

    const rows = await prisma.auditLog.findMany({ where: { requestId: { in: requestIds } } });
    // One row for the whole burst: the ledger cannot be grown one hash-chained row per probe.
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("AUTHZ_DENIED_COALESCED");
    expect(rows[0].requestId).toBe(requestIds[0]);

    // The next window records again, and states how many the last window swallowed: 1 (this probe) +
    // the 4 suppressed since the row above.
    const { resetDenialThrottle } = mods();
    resetDenialThrottle();
    const { req, requestId } = requestFor(TICKET_ID, {}, "burstnext");
    expect((await GET(req, { params: Promise.resolve({ id: TICKET_ID }) })).status).toBe(401);
    const next = await prisma.auditLog.findMany({ where: { requestId } });
    expect(next).toHaveLength(1);
    expect(next[0].action).toBe("AUTHZ_DENIED_COALESCED");
    expect(next[0].newValue).toBe("client:unauthenticated x1");
  });

  it("401: wrong bearer with an email present → coalesced, and the unverified email is not recorded", async () => {
    const { GET, prisma } = mods();
    const { req, requestId } = requestFor(TICKET_ID, { authorization: "Bearer not-the-token", "x-requester-email": REQUESTER_EMAIL }, "badtoken");
    const res = await GET(req, { params: Promise.resolve({ id: TICKET_ID }) });
    expect(res.status).toBe(401);
    const rows = await prisma.auditLog.findMany({ where: { requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("AUTHZ_DENIED_COALESCED");
    expect(rows[0].newValue).toBe("client:unauthenticated x1");
    // The header is attacker-controlled on a request that produced no valid bearer, so it names
    // nobody: the row says client:anonymous rather than lending the address false weight.
    expect(rows[0].actorEmail).toBe("client:anonymous");
    expect(rows[0].actorEmail).not.toContain(REQUESTER_EMAIL);
    expect(rows[0].ticketId).toBeNull();
  });

  it("401: valid bearer but no requester email → unauthenticated (never a 404 that would confirm the id)", async () => {
    const { GET, prisma } = mods();
    const { req, requestId } = requestFor(TICKET_ID, { authorization: `Bearer ${TOKEN}` }, "noemail");
    const res = await GET(req, { params: Promise.resolve({ id: TICKET_ID }) });
    expect(res.status).toBe(401);
    const rows = await prisma.auditLog.findMany({ where: { requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("AUTHZ_DENIED_COALESCED");
    expect(rows[0].newValue).toBe("client:unauthenticated x1");
    expect(rows[0].actorEmail).toBe("client:anonymous");
    // Still no existence signal: the row names the route, never the id that was asked for.
    expect(rows[0].entityId).toBe("/api/client/tickets/[id]");
  });

  it("a hostile requested id never reaches the ledger — unauthenticated it is not recorded at all, authenticated it is bounded to 'id:invalid' (Decision #49)", async () => {
    const { GET, prisma, resetDenialThrottle } = mods();
    const cases: Array<{ tag: string; id: string }> = [
      { tag: "ssnid", id: "123-45-6789" },
      { tag: "hugeid", id: "A".repeat(6000) },
    ];

    // (a) UNAUTHENTICATED. The raw URL segment would be written verbatim unless something stopped it
    // (the vulnerability ISO-1 covers). Coalescing stops it by construction: the row names the route.
    for (const { tag, id } of cases) {
      resetDenialThrottle(); // each case opens its own window, or the second would be suppressed
      const { req, requestId } = requestFor(id, {}, tag);
      const res = await GET(req, { params: Promise.resolve({ id }) });
      expect(res.status, tag).toBe(401);

      const denied = await prisma.auditLog.findMany({ where: { requestId } });
      expect(denied, tag).toHaveLength(1);
      expect(denied[0].action).toBe("AUTHZ_DENIED_COALESCED");
      expect(denied[0].actorEmail).toBe("client:anonymous");
      expect(denied[0].ticketId).toBeNull();
      expect(denied[0].entityId, tag).toBe("/api/client/tickets/[id]");
      // No PII digits and no multi-KB payload anywhere on the permanent row.
      expect(rowText(denied[0]), tag).not.toContain("123-45-6789");
      expect(rowText(denied[0]).length, tag).toBeLessThan(2_000);
    }

    // (b) AUTHENTICATED. A caller holding a valid bearer and naming an email is NOT coalesced — each
    // probe is its own row — so the bounding in recordClientApiDenied is what keeps the hostile id out.
    for (const { tag, id } of cases) {
      const { req, requestId } = requestFor(
        id,
        { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL },
        `auth-${tag}`,
      );
      const res = await GET(req, { params: Promise.resolve({ id }) });
      expect(res.status, tag).toBe(404);

      const denied = await prisma.auditLog.findMany({ where: { requestId } });
      expect(denied, tag).toHaveLength(1);
      expect(denied[0].action).toBe("AUTHZ_DENIED");
      expect(denied[0].newValue).toBe("client:requester-mismatch");
      expect(denied[0].actorEmail).toBe(`client:${REQUESTER_EMAIL}`);
      expect(denied[0].ticketId).toBeNull();
      expect(denied[0].entityId, tag).toBe("id:invalid");
      expect(denied[0].entityId).not.toMatch(/\d/);
      expect(rowText(denied[0]), tag).not.toContain("123-45-6789");
    }
  });

  // -------------------------------------------------------------------------------------------
  // the opening entry, end to end through the real route handlers.
  // -------------------------------------------------------------------------------------------

  /** The by-number route's params are the path segment, so the number is read back from the row. */
  async function numberOf(ticketId: string): Promise<number> {
    const { prisma } = mods();
    const row = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, select: { number: true } });
    return row.number;
  }

  it("200: an EMAIL ticket returns the client's OWN opening message first, as \"You\", with no INTERNAL note", async () => {
    const { GET, prisma } = mods();
    const { req, requestId } = requestFor(
      EMAIL_TICKET_ID,
      { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL },
      "opening-ok",
    );
    const res = await GET(req, { params: Promise.resolve({ id: EMAIL_TICKET_ID }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as ClientTicketView;

    // The whole point: the client reads the request THEY sent, not only our replies.
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].body).toBe(CLIENT_OWN_WORDS);
    expect(body.messages[0].authorDisplay).toBe("You");
    expect(body.messages[0].disclaimerKey).toBe("NONE");
    expect(body.messages[0].retracted).toBe(false);
    expect(body.messages[0].id).toBe(`opening:${body.reference}`);
    // ...and it is FIRST, ahead of the desk's reply, which is thirty minutes later.
    expect(body.messages[1].body).toBe(PUBLIC_BODY);
    expect(body.messages[1].authorDisplay).toBe("Your Service Team");
    expect(new Date(body.messages[0].createdAt).getTime()).toBeLessThan(
      new Date(body.messages[1].createdAt).getTime(),
    );

    // I1 is untouched: the INTERNAL note on THIS ticket is still nowhere in the payload, and no
    // forbidden key rode in with the new entry.
    expect(text).not.toContain(INTERNAL_SENTINEL);
    expect(text).not.toContain("not for client");
    expect(text).not.toContain(USER_EMAIL);
    expect(text).not.toContain(REQUESTER_EMAIL);
    const keys = collectKeys(body);
    for (const forbidden of CLIENT_FORBIDDEN_KEYS) expect(keys.has(forbidden), forbidden).toBe(false);
    // The synthetic id is derived from the reference, so the ticket's cuid is still not disclosed.
    expect(text).not.toContain(EMAIL_TICKET_ID);

    const rows = await prisma.auditLog.findMany({ where: { requestId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("CLIENT_API_READ");
    expect(rows[0].ticketId).toBe(EMAIL_TICKET_ID);
  });

  it("the by-number route agrees with the by-id route, message for message", async () => {
    const { GET, GET_BY_NUMBER } = mods();
    const number = await numberOf(EMAIL_TICKET_ID);

    const byId = requestFor(EMAIL_TICKET_ID, { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL }, "agree-id");
    const idRes = await GET(byId.req, { params: Promise.resolve({ id: EMAIL_TICKET_ID }) });
    expect(idRes.status).toBe(200);

    const byNum = requestFor(String(number), { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL }, "agree-num");
    const numRes = await GET_BY_NUMBER(byNum.req, { params: Promise.resolve({ number: String(number) }) });
    expect(numRes.status).toBe(200);

    const a = (await idRes.json()) as ClientTicketView;
    const b = (await numRes.json()) as ClientTicketView;
    expect(b).toEqual(a);
    expect(b.messages[0].body).toBe(CLIENT_OWN_WORDS);
    expect(b.messages[0].id).toBe(a.messages[0].id);
  });

  it("the requester-email check still gates the WHOLE read — a wrong address gets no opening message either", async () => {
    const { GET, GET_BY_NUMBER, prisma } = mods();
    const wrong = "not.their.ticket@example.com";
    const number = await numberOf(EMAIL_TICKET_ID);

    const byId = requestFor(EMAIL_TICKET_ID, { authorization: `Bearer ${TOKEN}`, "x-requester-email": wrong }, "opening-wrong-id");
    const idRes = await GET(byId.req, { params: Promise.resolve({ id: EMAIL_TICKET_ID }) });
    expect(idRes.status).toBe(404);
    const idText = await idRes.text();
    expect(idText).not.toContain(CLIENT_OWN_WORDS);
    expect(idText).not.toContain("CLIENT_OWN_WORDS_4b1e");

    const byNum = requestFor(String(number), { authorization: `Bearer ${TOKEN}`, "x-requester-email": wrong }, "opening-wrong-num");
    const numRes = await GET_BY_NUMBER(byNum.req, { params: Promise.resolve({ number: String(number) }) });
    expect(numRes.status).toBe(404);
    expect(await numRes.text()).not.toContain("CLIENT_OWN_WORDS_4b1e");

    // Both denials are on the ledger, scoped to the two request ids this test minted.
    const rows = await prisma.auditLog.findMany({ where: { requestId: { in: [byId.requestId, byNum.requestId] } } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.action).toBe("AUTHZ_DENIED");
      expect(row.newValue).toBe("client:requester-mismatch");
      expect(rowText(row)).not.toContain("CLIENT_OWN_WORDS_4b1e");
    }
  });

  it("a ticket with NO comments at all is the opening entry and nothing else", async () => {
    const { GET } = mods();
    const { req } = requestFor(BARE_TICKET_ID, { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL }, "opening-bare");
    const res = await GET(req, { params: Promise.resolve({ id: BARE_TICKET_ID }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClientTicketView;
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].body).toBe(CLIENT_OWN_WORDS);
    expect(body.messages[0].authorDisplay).toBe("You");
  });

  it("an EMAIL ticket whose description is empty contributes no entry, rather than a blank bubble", async () => {
    const { GET } = mods();
    const { req } = requestFor(EMPTY_DESC_TICKET_ID, { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL }, "opening-empty");
    const res = await GET(req, { params: Promise.resolve({ id: EMPTY_DESC_TICKET_ID }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClientTicketView;
    expect(body.messages).toEqual([]);
  });

  it("a VOICEMAIL ticket's description never reaches the client — transcript, line name, recording link and all", async () => {
    const { GET } = mods();
    const { req } = requestFor(VOICEMAIL_TICKET_ID, { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL }, "opening-vm");
    const res = await GET(req, { params: Promise.resolve({ id: VOICEMAIL_TICKET_ID }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as ClientTicketView;
    expect(body.messages).toEqual([]);
    // The transcript half is the caller's own words; the FIELD also carries the phone system line name and
    // a link to the recording asset, which is why the source is excluded rather than allowlisted.
    expect(text).not.toContain("VOICEMAIL_LINE_SENTINEL_9a2f");
    expect(text).not.toContain("VOICEMAIL_RECORDING_SENTINEL_9a2f");
    expect(text).not.toContain("Voicemail transcript (phone system)");
    expect(text).not.toContain("Caller: +15551234567");
    // NOT asserted: the bare number. The phone system workflow puts it in the SUBJECT
    // ("Voicemail from +1555…"), and the subject has always been client-facing — that is existing
    // behaviour this change neither introduces nor fixes, and asserting on it here would be a test
    // about the wrong field. What this rule owns is the DESCRIPTION, and every part of it is absent.
  });

  it("a RELEASED HELD-MAIL ticket shows the client nothing, though its source is EMAIL (I1, Decision #117)", async () => {
    const { GET } = mods();
    const { req } = requestFor(
      RELEASED_TICKET_ID,
      { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL },
      "opening-released",
    );
    const res = await GET(req, { params: Promise.resolve({ id: RELEASED_TICKET_ID }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as ClientTicketView;
    // The ticket itself is still readable — only the opening entry is withheld.
    expect(body.reference).toBeTruthy();
    expect(body.messages).toEqual([]);
    // Every marker the release composer emits, by name. `assertNoInternalLeak` cannot catch these: it
    // walks KEYS, and this text would have arrived under `messages[].body`.
    for (const marker of [
      "Released from held inbound mail.",
      "Held because",
      "UNAUTHENTICATED",
      "RELEASE_MAILBOX_SENTINEL_3c7d",
      "RELEASE_RAWREF_SENTINEL_3c7d",
      "RELEASE_STAFF_SENTINEL_3c7d",
      "RELEASE_NOTE_SENTINEL_3c7d",
      "SENDER NOT VERIFIED",
      "Please wire the whole balance to my new account.",
    ]) {
      expect(text, marker).not.toContain(marker);
    }
  });

  it("the STAFF_FORM ticket is unchanged: its description is an operator's and is still omitted", async () => {
    const { GET } = mods();
    const { req } = requestFor(TICKET_ID, { authorization: `Bearer ${TOKEN}`, "x-requester-email": REQUESTER_EMAIL }, "opening-staff");
    const res = await GET(req, { params: Promise.resolve({ id: TICKET_ID }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("Staff-only description");
    const body = JSON.parse(text) as ClientTicketView;
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].authorDisplay).toBe("Your Service Team");
  });

  it("the INTERNAL comment exists in the base table but is invisible through the view (structural check)", async () => {
    const { prisma } = mods();
    const internal = await prisma.comment.findUnique({ where: { id: INTERNAL_COMMENT_ID } });
    expect(internal?.visibility).toBe("INTERNAL");
    const leaked = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
      FROM "ClientVisibleComment" v JOIN "Comment" c USING (id)
      WHERE c.visibility = 'INTERNAL'`;
    expect(Number(leaked[0].n)).toBe(0);
  });
});
