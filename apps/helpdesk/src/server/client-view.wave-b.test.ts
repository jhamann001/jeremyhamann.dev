/**
 * `src/server/client-view.ts` — what slice B8 added.
 *
 * The Wave A guarantees (the branded view row, `assertNoInternalLeak`, the bearer) are proved in
 * `client-view.test.ts` and `client-view.integration.test.ts` and are untouched. This file covers the
 * three additions: the client VOCABULARY, the LIST, and the BY-NUMBER lookup — and in particular the
 * two properties those three must not lose, which are that every client payload carries a label
 * instead of a raw enum, and that a read of client material is on the ledger before it is served.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NODE_ENV: "test" as const,
    // Composed from its parts at run time: a literal `postgresql://USER:PASSWORD@HOST/DB` is a security scanner
    // secret finding in any tracked file, tests included, even for a database nothing dials.
    // `vi.hoisted` / `vi.mock` run before imports, so `@/test-support/db-url` cannot be called from in
    // here; this is that module's `unitDatabaseUrl()` written as one expression.
    DATABASE_URL: Object.assign(new URL("postgresql://localhost:5432/unit_never_connects"), {
      username: "unit",
      password: "unit",
    }).toString(),
    APP_ENV: "local" as const,
    CLIENT_API_TOKEN: "legacy-client-token-0123456789abcdefghij",
  },
  assertServingInvariants: vi.fn(),
}));

/** Loose signatures on purpose: a mock's job here is to record calls, not to re-declare Prisma. */
const mockDb = vi.hoisted(() => {
  const fn = () => vi.fn(async (...a: unknown[]): Promise<unknown> => void a);
  return {
    publicDb: {
      ticket: { findMany: fn(), findFirst: fn(), findUnique: fn(), count: fn() },
      $queryRaw: fn(),
    },
  };
});
vi.mock("@/lib/db", () => mockDb);

const mockAudit = vi.hoisted(() => ({
  recordClientApiRead: vi.fn(async (...a: unknown[]): Promise<unknown> => void a),
  recordClientApiDenied: vi.fn(async (...a: unknown[]): Promise<unknown> => void a),
}));
vi.mock("@/lib/audit", () => mockAudit);

const mockThrottle = vi.hoisted(() => ({
  recordUnauthenticatedClientDenial: vi.fn(async (...a: unknown[]): Promise<unknown> => void a),
}));
vi.mock("@/lib/denial-throttle", () => mockThrottle);

const mockTokens = vi.hoisted(() => ({
  verifyApiToken: vi.fn(async (...a: unknown[]): Promise<unknown> => (a.length, null)),
}));
vi.mock("@/lib/api-tokens", () => mockTokens);

const mockMachineAuth = vi.hoisted(() => ({
  enforceMachineRateLimit: vi.fn(async (...a: unknown[]): Promise<unknown> => (a.length, null)),
}));
vi.mock("@/lib/integration-auth", () => mockMachineAuth);

import { TICKET_CATEGORIES, TICKET_STATUSES } from "@/types/domain";
import type { RequestContext, TicketCategory, TicketStatus } from "@/types/domain";
import {
  CLIENT_CATEGORY_VOCABULARY,
  CLIENT_LIST_DEFAULT_PAGE_SIZE,
  CLIENT_LIST_MAX_PAGE_SIZE,
  CLIENT_STATUS_VOCABULARY,
  authorizeClientApiRequest,
  enforceClientApiRateLimit,
  clientListBounds,
  clientVocabularyFor,
  countClientTickets,
  getClientTicketByNumber,
  listClientTickets,
  toClientTicketView,
} from "@/server/client-view";

const CTX: RequestContext = {
  ipAddress: "203.0.113.4",
  userAgent: "vitest",
  requestId: "req-cv-1",
  isPrefetch: false,
};

function ticketRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "t_1",
    number: 1042,
    subject: "Wire to Fidelity",
    status: "OPEN",
    priority: "URGENT",
    category: "WIRE_TRANSFER",
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-02T10:00:00.000Z"),
    resolvedAt: null,
    requesterEmail: "client@example.com",
    // Decision #117 (amended): `source`, `description` and `externalId` are NOT selected here any
    // more — the client role is not granted them. The opening entry arrives from the
    // "ClientVisibleOpeningMessage" view instead; see `openingViewRow` and `mockQueryRaw`.
    ...over,
  };
}

function viewRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "c_1",
    ticketId: "t_1",
    body: "We have sent it.",
    disclaimerKey: "GENERAL_SERVICE",
    authorKind: "STAFF",
    retracted: false,
    createdAt: new Date("2026-09-02T09:00:00.000Z"),
    ...over,
  };
}

/**
 * Decision #117 (amended). A row as "ClientVisibleOpeningMessage" returns it — four columns, and only
 * for a ticket the view's WHERE admits. The default is the INCLUDED case, because the excluded case is
 * simply the absence of a row: `mockQueryRaw()` with no `opening` returns none, which is what the
 * database does for every STAFF_FORM, VOICEMAIL or released held-mail ticket.
 */
function openingViewRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ticketId: "t_1",
    source: "EMAIL",
    body: "I sent the wire form on Tuesday and have not heard back.",
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    ...over,
  };
}

/**
 * `publicDb.$queryRaw` now serves TWO views, so the mock answers by which one the SQL names rather
 * than returning one fixed array to both. The tagged template hands the mock its `TemplateStringsArray`
 * first, which is where the view name is.
 */
function mockQueryRaw(rows: { comments?: unknown[]; opening?: unknown[] } = {}): void {
  mockDb.publicDb.$queryRaw.mockImplementation(async (...args: unknown[]): Promise<unknown> => {
    const template = args[0] as { raw?: readonly string[] } | undefined;
    const sql = (template?.raw ?? []).join(" ");
    return sql.includes("ClientVisibleOpeningMessage") ? (rows.opening ?? []) : (rows.comments ?? []);
  });
}

/** The SQL of every `$queryRaw` call so far, one string per call. */
function queryRawSql(): string[] {
  return mockDb.publicDb.$queryRaw.mock.calls.map((call) => {
    const template = call[0] as { raw?: readonly string[] } | undefined;
    return (template?.raw ?? []).join(" ");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryRaw();
  mockDb.publicDb.ticket.findMany.mockResolvedValue([]);
  mockDb.publicDb.ticket.findFirst.mockResolvedValue(null);
  mockDb.publicDb.ticket.count.mockResolvedValue(0);
  mockTokens.verifyApiToken.mockResolvedValue(null);
  // clearAllMocks resets calls, not implementations: a rejection set by one test would leak.
  mockAudit.recordClientApiRead.mockResolvedValue(undefined);
  mockAudit.recordClientApiDenied.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------

describe("the client vocabulary", () => {
  it("covers every status and every category — a new enum value fails here, not at a client", () => {
    for (const s of TICKET_STATUSES) {
      expect(CLIENT_STATUS_VOCABULARY[s], `no client word for ${s}`).toBeTruthy();
    }
    for (const c of TICKET_CATEGORIES) {
      expect(CLIENT_CATEGORY_VOCABULARY[c], `no client word for ${c}`).toBeTruthy();
    }
    expect(Object.keys(CLIENT_STATUS_VOCABULARY).sort()).toEqual([...TICKET_STATUSES].sort());
    expect(Object.keys(CLIENT_CATEGORY_VOCABULARY).sort()).toEqual([...TICKET_CATEGORIES].sort());
  });

  it("never shows a client a raw enum value or an internal word", () => {
    const words = [...Object.values(CLIENT_STATUS_VOCABULARY), ...Object.values(CLIENT_CATEGORY_VOCABULARY)];
    for (const w of words) {
      expect(w, w).not.toMatch(/^[A-Z_]+$/);
      expect(w.toLowerCase(), w).not.toContain("internal");
      expect(w.toLowerCase(), w).not.toContain("queue");
    }
  });

  it("is deliberately narrower than the staff vocabulary: PENDING_INTERNAL reads as OPEN does", () => {
    expect(CLIENT_STATUS_VOCABULARY.PENDING_INTERNAL).toBe(CLIENT_STATUS_VOCABULARY.OPEN);
    expect(CLIENT_STATUS_VOCABULARY.PENDING_CLIENT).not.toBe(CLIENT_STATUS_VOCABULARY.OPEN);
  });

  it("names a complaint a complaint", () => {
    expect(CLIENT_CATEGORY_VOCABULARY.COMPLAINT.toLowerCase()).toContain("complaint");
  });

  it("clientVocabularyFor is the pure lookup the builder uses", () => {
    expect(clientVocabularyFor({ status: "RESOLVED", category: "ACAT" })).toEqual({
      statusLabel: CLIENT_STATUS_VOCABULARY.RESOLVED,
      categoryLabel: CLIENT_CATEGORY_VOCABULARY.ACAT,
    });
  });
});

describe("toClientTicketView", () => {
  const source = {
    id: "t_1",
    number: 1042,
    subject: "Wire to Fidelity",
    status: "PENDING_CLIENT" as TicketStatus,
    priority: "URGENT" as const,
    category: "WIRE_TRANSFER" as TicketCategory,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-02T10:00:00.000Z"),
    resolvedAt: null,
  };

  it("carries the labels beside the raw enums, so an app that switches on status still works", () => {
    // Decision #117 (amended): the third argument is the row the "ClientVisibleOpeningMessage" view
    // returns. `null` is a ticket with no opening entry — the desk-composed case — so these vocabulary
    // assertions keep reading an empty thread exactly as they did.
    const view = toClientTicketView(source, [], null);
    expect(view.status).toBe("PENDING_CLIENT");
    expect(view.statusLabel).toBe("Waiting on you");
    expect(view.category).toBe("WIRE_TRANSFER");
    expect(view.categoryLabel).toBe("Wire transfer");
    expect(view.reference).toBe("HD-1042");
  });

  it("labels a voided ticket as withdrawn rather than hiding it", () => {
    const view = toClientTicketView({ ...source, status: "VOIDED" }, [], null);
    expect(view.statusLabel).toBe("Withdrawn");
  });
});

describe("clientListBounds", () => {
  it("defaults, clamps and never throws on nonsense", () => {
    expect(clientListBounds(undefined)).toEqual({ page: 1, pageSize: CLIENT_LIST_DEFAULT_PAGE_SIZE });
    expect(clientListBounds({})).toEqual({ page: 1, pageSize: CLIENT_LIST_DEFAULT_PAGE_SIZE });
    expect(clientListBounds({ page: 3, pageSize: 5 })).toEqual({ page: 3, pageSize: 5 });
    expect(clientListBounds({ pageSize: 1_000_000 }).pageSize).toBe(CLIENT_LIST_MAX_PAGE_SIZE);
    expect(clientListBounds({ page: 0 }).page).toBe(1);
    expect(clientListBounds({ page: -4, pageSize: -1 })).toEqual({
      page: 1,
      pageSize: CLIENT_LIST_DEFAULT_PAGE_SIZE,
    });
    expect(clientListBounds({ page: 1.5, pageSize: Number.NaN }).page).toBe(1);
  });
});

describe("authorizeClientApiRequest", () => {
  const bearer = (value: string): Headers => new Headers({ authorization: `Bearer ${value}` });

  it("prefers a database credential over the legacy env bearer, so attribution is right from day one", async () => {
    mockTokens.verifyApiToken.mockResolvedValue({ id: "tok_1", scopes: ["CLIENT_READ"], requesterEmail: null });
    await expect(authorizeClientApiRequest(bearer("anything"), "client@example.com")).resolves.toEqual({
      kind: "token",
      tokenId: "tok_1",
    });
    expect(mockTokens.verifyApiToken.mock.calls[0][1]).toBe("CLIENT_READ");
  });

  it("falls back to the legacy shared bearer while it is still set", async () => {
    await expect(
      authorizeClientApiRequest(bearer("legacy-client-token-0123456789abcdefghij"), "client@example.com"),
    ).resolves.toEqual({ kind: "legacy" });
  });

  it("refuses a bearer that is neither", async () => {
    await expect(authorizeClientApiRequest(bearer("wrong"), "client@example.com")).resolves.toBeNull();
    await expect(authorizeClientApiRequest(new Headers(), "client@example.com")).resolves.toBeNull();
  });

  it("a requester-BOUND credential may only act for its own address", async () => {
    mockTokens.verifyApiToken.mockResolvedValue({
      id: "tok_1",
      scopes: ["CLIENT_READ"],
      requesterEmail: "Client@Example.com",
    });
    await expect(authorizeClientApiRequest(bearer("x"), "client@example.com")).resolves.toEqual({
      kind: "token",
      tokenId: "tok_1",
    });
    await expect(authorizeClientApiRequest(bearer("x"), "someone@else.test")).resolves.toBeNull();
    await expect(authorizeClientApiRequest(bearer("x"), null)).resolves.toBeNull();
  });

  /**
   * Fix round 2. `CLIENT_WRITE` used to be a scope no route enforced: the two POST surfaces took the
   * shared env bearer and never looked at a credential, so a requester-bound write token narrowed
   * nothing and `metadata ? 'tokenId'` said "still on the shared bearer" for every write, forever.
   * The scope the surface demands is now an argument, and it defaults to the contracted `CLIENT_READ`.
   */
  it("demands the scope the SURFACE named, defaulting to CLIENT_READ", async () => {
    mockTokens.verifyApiToken.mockResolvedValue({ id: "tok_1", scopes: ["CLIENT_WRITE"], requesterEmail: null });

    await authorizeClientApiRequest(bearer("x"), "client@example.com");
    expect(mockTokens.verifyApiToken.mock.calls.at(-1)?.[1]).toBe("CLIENT_READ");

    await authorizeClientApiRequest(bearer("x"), "client@example.com", "CLIENT_WRITE");
    expect(mockTokens.verifyApiToken.mock.calls.at(-1)?.[1]).toBe("CLIENT_WRITE");
  });

  it("refuses a credential that does not carry the demanded scope, and still falls back to the legacy bearer", async () => {
    // `verifyApiToken` is what enforces the grant, and it answers null for a scope the row lacks.
    mockTokens.verifyApiToken.mockResolvedValue(null);
    await expect(authorizeClientApiRequest(bearer("wrong"), "client@example.com", "CLIENT_WRITE")).resolves.toBeNull();
    await expect(
      authorizeClientApiRequest(bearer("legacy-client-token-0123456789abcdefghij"), "client@example.com", "CLIENT_WRITE"),
    ).resolves.toEqual({ kind: "legacy" });
  });
});

describe("enforceClientApiRateLimit", () => {
  it("spends a credential's own budget, naming the scope the surface demanded", async () => {
    await enforceClientApiRateLimit(CTX, "/api/client/tickets/[id]", { kind: "token", tokenId: "tok_1" }, "CLIENT_READ");
    const args = mockMachineAuth.enforceMachineRateLimit.mock.calls.at(-1) as unknown[];
    expect(args[1]).toBe("/api/client/tickets/[id]");
    expect(args[2]).toEqual({ kind: "token", tokenId: "tok_1", scopes: ["CLIENT_READ"] });
    expect(args[3]).toBe("client");
  });

  it("spends the shared per-surface budget for a caller still on the legacy bearer", async () => {
    await enforceClientApiRateLimit(CTX, "/api/client/tickets/[id]", { kind: "legacy" }, "CLIENT_WRITE");
    const args = mockMachineAuth.enforceMachineRateLimit.mock.calls.at(-1) as unknown[];
    expect(args[2]).toEqual({ kind: "legacy" });
    expect(args[3]).toBe("client");
  });

  it("hands the refusal straight back so the route can answer 429", async () => {
    const refusal = { resetAt: new Date("2026-09-20T12:01:00.000Z"), retryAfterSeconds: 31 };
    mockMachineAuth.enforceMachineRateLimit.mockResolvedValueOnce(refusal);
    await expect(
      enforceClientApiRateLimit(CTX, "/api/client/tickets/[id]", { kind: "legacy" }, "CLIENT_READ"),
    ).resolves.toBe(refusal);
  });
});

describe("listClientTickets", () => {
  it("returns nothing, and reads nothing, for a blank address", async () => {
    await expect(listClientTickets("   ", CTX)).resolves.toEqual([]);
    expect(mockDb.publicDb.ticket.findMany).not.toHaveBeenCalled();
  });

  it("matches the address case-insensitively and pages newest activity first", async () => {
    await listClientTickets("Client@Example.com", CTX, { page: 2, pageSize: 5 });
    const arg = mockDb.publicDb.ticket.findMany.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.where).toEqual({ requesterEmail: { equals: "client@example.com", mode: "insensitive" } });
    expect(arg.orderBy).toEqual([{ updatedAt: "desc" }, { number: "desc" }]);
    expect(arg.skip).toBe(5);
    expect(arg.take).toBe(5);
  });

  it("selects no relation key — publicDb would throw, and G8 scans for it", async () => {
    await listClientTickets("client@example.com", CTX);
    const select = (mockDb.publicDb.ticket.findMany.mock.calls[0][0] as { select: Record<string, unknown> }).select;
    for (const relation of ["queue", "createdBy", "assignee", "comments", "auditLogs"]) {
      expect(select[relation]).toBeUndefined();
    }
  });

  it("fetches every page's comments in ONE view query and buckets them by ticket", async () => {
    mockDb.publicDb.ticket.findMany.mockResolvedValue([
      ticketRow(),
      ticketRow({ id: "t_2", number: 1043, status: "RESOLVED", category: "ACAT" }),
    ]);
    mockQueryRaw({
      comments: [
        viewRow(),
        viewRow({ id: "c_2", ticketId: "t_2", body: "Transfer complete." }),
        viewRow({ id: "c_3", ticketId: "t_2", body: "Anything else?" }),
      ],
    });

    const views = await listClientTickets("client@example.com", CTX);
    // TWO queries for the whole page — one per view — not two per ticket. Decision #117 added the
    // second; a regression to a per-ticket loop shows up here as four.
    const sql = queryRawSql();
    expect(sql).toHaveLength(2);
    expect(sql.filter((q) => q.includes('FROM "ClientVisibleComment"'))).toHaveLength(1);
    expect(sql.filter((q) => q.includes('FROM "ClientVisibleOpeningMessage"'))).toHaveLength(1);
    expect(views.map((v) => v.reference)).toEqual(["HD-1042", "HD-1043"]);
    expect(views[0].messages).toHaveLength(1);
    expect(views[1].messages).toHaveLength(2);
    expect(views[1].statusLabel).toBe("Resolved");
    expect(views[1].categoryLabel).toBe("Account transfer");
  });

  it("audits one CLIENT_API_READ per ticket, and does it BEFORE returning (I3)", async () => {
    mockDb.publicDb.ticket.findMany.mockResolvedValue([ticketRow(), ticketRow({ id: "t_2", number: 1043 })]);
    await listClientTickets("client@example.com", CTX);
    expect(mockAudit.recordClientApiRead).toHaveBeenCalledTimes(2);
    expect(mockAudit.recordClientApiRead.mock.calls.map((c) => c[1])).toEqual(["t_1", "t_2"]);
  });

  it("serves nothing when the ledger write fails", async () => {
    mockDb.publicDb.ticket.findMany.mockResolvedValue([ticketRow()]);
    mockAudit.recordClientApiRead.mockRejectedValue(new Error("chain insert failed"));
    await expect(listClientTickets("client@example.com", CTX)).rejects.toThrow("chain insert failed");
  });

  it("refuses a view row that claims retraction while carrying a body", async () => {
    mockDb.publicDb.ticket.findMany.mockResolvedValue([ticketRow()]);
    mockQueryRaw({ comments: [viewRow({ retracted: true, body: "still here" })] });
    await expect(listClientTickets("client@example.com", CTX)).rejects.toThrow(/retracted comment arrived with a body/);
  });

  /**
   * Decision #117 (amended). The list read goes through the SAME builder as the two single-ticket
   * reads, so the opening entry cannot be present on one surface and missing on another — but the list
   * has its own reads, and one that forgot the view would silently drop the client's own message from
   * every "My requests" screen while the detail read kept showing it.
   *
   * The `"Ticket"` select must NOT carry `description`, `source` or `externalId`: the client role holds
   * no privilege on any of the three, so asking for one is a permission error in every environment
   * that has runtime roles, not a leak — but it is still a broken read, and it is the shape the first
   * version of this decision shipped.
   */
  it("reads the opening entry from the view, and asks \"Ticket\" for none of the gate columns (Decision #117)", async () => {
    mockDb.publicDb.ticket.findMany.mockResolvedValue([ticketRow()]);
    await listClientTickets("client@example.com", CTX);
    const select = (mockDb.publicDb.ticket.findMany.mock.calls[0][0] as { select: Record<string, unknown> }).select;
    for (const gated of ["description", "source", "externalId"]) {
      expect(select[gated], `"Ticket".${gated} is not granted to the client role`).toBeUndefined();
    }
    expect(queryRawSql().filter((q) => q.includes('FROM "ClientVisibleOpeningMessage"'))).toHaveLength(1);
  });

  it("renders the client's own opening message first on the row the view admits, and not on the other", async () => {
    const theirWords = "I still cannot sign in after the reset.";
    mockDb.publicDb.ticket.findMany.mockResolvedValue([ticketRow(), ticketRow({ id: "t_2", number: 1043 })]);
    // The view returns a row for t_1 and none for t_2 — which is what it does when t_2 is a STAFF_FORM,
    // a voicemail or a released held-mail ticket. The list must bucket by ticket id, not by position.
    mockQueryRaw({
      comments: [viewRow(), viewRow({ id: "c_2", ticketId: "t_2" })],
      opening: [openingViewRow({ source: "CLIENT_APP", body: theirWords })],
    });

    const views = await listClientTickets("client@example.com", CTX);
    expect(views[0].messages.map((m) => m.body)).toEqual([theirWords, "We have sent it."]);
    expect(views[0].messages[0].authorDisplay).toBe("You");
    expect(views[1].messages.map((m) => m.body)).toEqual(["We have sent it."]);
  });

  it("withholds the opening entry from a row the view refuses, and from a forged one too (Decision #117)", async () => {
    const deskComposed = "Snippet.\n\n--\nReleased from held inbound mail.\nReviewer note: LIST_RELEASE_SENTINEL_2f8c";
    mockDb.publicDb.ticket.findMany.mockResolvedValue([ticketRow()]);
    // What the DATABASE does with a released held-mail ticket: it is not in the view, so no row comes
    // back and the desk's review material is unreachable rather than unrendered.
    mockQueryRaw({ comments: [viewRow()], opening: [] });
    const withheld = await listClientTickets("client@example.com", CTX);
    expect(withheld[0].messages.map((m) => m.body)).toEqual(["We have sent it."]);

    // And the SECOND belt, which is all this module can contribute: a row carrying an excluded source
    // — which only a view rebuilt without its WHERE could produce — is dropped here as well.
    vi.clearAllMocks();
    mockAudit.recordClientApiRead.mockResolvedValue(undefined);
    mockDb.publicDb.ticket.findMany.mockResolvedValue([ticketRow()]);
    mockQueryRaw({ comments: [viewRow()], opening: [openingViewRow({ source: "STAFF_FORM", body: deskComposed })] });
    const forged = await listClientTickets("client@example.com", CTX);
    expect(forged[0].messages.map((m) => m.body)).toEqual(["We have sent it."]);
    expect(JSON.stringify(forged[0])).not.toContain("LIST_RELEASE_SENTINEL_2f8c");
    expect(JSON.stringify(forged[0])).not.toContain("Released from held inbound mail.");
  });
});

describe("countClientTickets", () => {
  it("counts the same population the list pages over", async () => {
    mockDb.publicDb.ticket.count.mockResolvedValue(7);
    await expect(countClientTickets("Client@Example.com")).resolves.toBe(7);
    expect(mockDb.publicDb.ticket.count.mock.calls[0][0]).toEqual({
      where: { requesterEmail: { equals: "client@example.com", mode: "insensitive" } },
    });
  });

  it("is zero for a blank address, without a query", async () => {
    await expect(countClientTickets("")).resolves.toBe(0);
    expect(mockDb.publicDb.ticket.count).not.toHaveBeenCalled();
  });
});

describe("getClientTicketByNumber", () => {
  it("returns the view, with vocabulary, for the requester's own ticket", async () => {
    mockDb.publicDb.ticket.findFirst.mockResolvedValue(ticketRow());
    mockQueryRaw({ comments: [viewRow()] });

    const view = await getClientTicketByNumber(1042, "Client@Example.com", CTX);
    expect(view?.reference).toBe("HD-1042");
    expect(view?.statusLabel).toBe("In progress");
    expect(view?.messages[0].authorDisplay).toBe("Your Service Team");
    expect(mockAudit.recordClientApiRead).toHaveBeenCalledWith(CTX, "t_1", "client@example.com");
  });

  it("a ticket belonging to somebody else is null, with a recorded denial naming the real id", async () => {
    mockDb.publicDb.ticket.findFirst.mockResolvedValue(ticketRow({ requesterEmail: "other@example.com" }));
    await expect(getClientTicketByNumber(1042, "client@example.com", CTX)).resolves.toBeNull();
    expect(mockAudit.recordClientApiDenied).toHaveBeenCalledTimes(1);
    const [, requestedId, , reason, exists] = mockAudit.recordClientApiDenied.mock.calls[0];
    expect(requestedId).toBe("t_1");
    expect(reason).toBe("client:requester-mismatch");
    expect(exists).toBe(true);
    expect(mockAudit.recordClientApiRead).not.toHaveBeenCalled();
  });

  it("an unknown number is the SAME answer, with the number recorded and no FK claimed", async () => {
    await expect(getClientTicketByNumber(999_999, "client@example.com", CTX)).resolves.toBeNull();
    const [, requestedId, , , exists] = mockAudit.recordClientApiDenied.mock.calls[0];
    expect(requestedId).toBe("999999");
    expect(exists).toBe(false);
  });

  it("returns the opening entry first on an EMAIL ticket, exactly as the by-id read does (Decision #117)", async () => {
    const theirWords = "Please confirm you received the wire form I sent on Tuesday.";
    mockDb.publicDb.ticket.findFirst.mockResolvedValue(ticketRow());
    mockQueryRaw({ comments: [viewRow()], opening: [openingViewRow({ body: theirWords })] });

    const view = await getClientTicketByNumber(1042, "client@example.com", CTX);
    expect(view?.messages.map((m) => m.body)).toEqual([theirWords, "We have sent it."]);
    expect(view?.messages[0].authorDisplay).toBe("You");
    expect(view?.messages[0].id).toBe("opening:HD-1042");
    expect(JSON.stringify(view)).not.toContain("\"description\"");
    expect(JSON.stringify(view)).not.toContain("\"source\"");
  });

  it("a SLACK ticket's write-up is a colleague's words and never reaches the client", async () => {
    mockDb.publicDb.ticket.findFirst.mockResolvedValue(
      ticketRow({ source: "SLACK", description: "Advisor asked us to look at this for their client." }),
    );
    const view = await getClientTicketByNumber(1042, "client@example.com", CTX);
    expect(view?.messages).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("Advisor asked us");
  });

  it("a phone-only ticket (null requesterEmail) can never be reached through the client API", async () => {
    mockDb.publicDb.ticket.findFirst.mockResolvedValue(ticketRow({ requesterEmail: null }));
    await expect(getClientTicketByNumber(1042, "client@example.com", CTX)).resolves.toBeNull();
  });

  it("a nonsense number never reaches the database and never reaches the ledger verbatim", async () => {
    await expect(getClientTicketByNumber(0, "client@example.com", CTX)).resolves.toBeNull();
    await expect(getClientTicketByNumber(-3, "client@example.com", CTX)).resolves.toBeNull();
    await expect(getClientTicketByNumber(1.5, "client@example.com", CTX)).resolves.toBeNull();
    expect(mockDb.publicDb.ticket.findFirst).not.toHaveBeenCalled();
    for (const c of mockAudit.recordClientApiDenied.mock.calls) expect(c[1]).toBe("id:invalid");
  });
});
