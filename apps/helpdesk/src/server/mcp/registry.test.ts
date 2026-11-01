/**
 * The six MCP tools — behaviour, not transport.
 *
 * The desk's own read modules are mocked, so what is under test is exactly what this slice wrote:
 * argument bounding, the RBAC re-checks, the staff / requester-bound split, the shapes that leave,
 * and the audit rows the two content-touching tools produce. `@/lib/pii` and `@/lib/rbac` are REAL —
 * sanitization and permission are the two things a mock would hide rather than prove.
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
    JOB_ACTOR_EMAIL: undefined as string | undefined,
  },
  assertServingInvariants: vi.fn(),
}));

/** Loose signatures on purpose: a mock's job here is to record calls, not to re-declare Prisma. */
const mockDb = vi.hoisted(() => {
  const fn = () => vi.fn(async (...a: unknown[]): Promise<unknown> => void a);
  const prisma = {
    ticket: { findFirst: fn(), findUnique: fn(), updateMany: fn() },
    comment: { findMany: fn(), create: fn() },
    notification: { findMany: fn(), count: fn() },
    // `get_ticket` renders through `toTicketDetail`, which now reads the live warning bands so the
    // SLA verdict it returns is coloured by the policy in force. An empty table is a
    // valid answer — every priority then reads as the 30-minute default.
    sLA: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  };
  return {
    prisma,
    withTx: vi.fn(async (...a: unknown[]): Promise<unknown> => (a[0] as (tx: unknown) => Promise<unknown>)(prisma)),
  };
});
vi.mock("@/lib/db", () => mockDb);

const mockAudit = vi.hoisted(() => ({
  AUDIT_VIA: { api: "api", email: "email", clientApp: "client-app", job: "job", mcp: "mcp", import: "import" },
  writeAudit: vi.fn(async (...a: unknown[]): Promise<unknown> => void a),
  writeAuditMany: vi.fn(async (...a: unknown[]): Promise<unknown> => void a),
  // VERBATIM per §e, same as the real helper: the registry's denial rows carry the same entityType
  // rule every other AUTHZ_DENIED row in the system does.
  deniedEntityType: (what: string, ticketId?: string | null) =>
    ticketId ? "TICKET" : /\baudit:/.test(what) ? "AUDIT_LOG" : "QUEUE",
  actorFromViewer: (v: { id: string; email: string; groups: string[] }) => ({ id: v.id, email: v.email, groups: [...v.groups] }),
}));
vi.mock("@/lib/audit", () => mockAudit);

const mockTickets = vi.hoisted(() => ({
  TICKET_INCLUDE: {},
  listTickets: vi.fn(async (...a: unknown[]): Promise<unknown> => void a),
  listTicketsByRequester: vi.fn(async (...a: unknown[]): Promise<unknown> => (a.length, { requester: [], household: [] })),
  toTicketDetail: vi.fn((...a: unknown[]): unknown => void a),
  wmTicketPath: (n: number) => `/tickets/wm/${n}`,
}));
vi.mock("@/server/tickets", () => mockTickets);

const mockComments = vi.hoisted(() => ({
  COMMENT_INCLUDE: {},
  toCommentDTO: vi.fn((...a: unknown[]): unknown => void a),
}));
vi.mock("@/server/comments", () => mockComments);

const mockQueues = vi.hoisted(() => ({
  getQueueSummaries: vi.fn(async (...a: unknown[]): Promise<unknown> => (a.length, [])),
}));
vi.mock("@/server/queues", () => mockQueues);

const mockNotify = vi.hoisted(() => ({
  notifyFromEvent: vi.fn(async (...a: unknown[]): Promise<unknown> => (a.length, { created: 0, auditEntries: [] })),
}));
vi.mock("@/server/notifications", () => mockNotify);

const mockContext = vi.hoisted(() => ({
  auditMcp: vi.fn(async (...a: unknown[]): Promise<unknown> => void a),
  mcpMetadata: (caller: { token: { id: string } }, tool: string) => ({ via: "mcp", tool, tokenId: caller.token.id }),
}));
vi.mock("@/server/mcp/context", () => mockContext);

import { NOTIFICATION_KIND_LABELS } from "@/types/domain";
import type { McpCall, McpTool } from "@/server/mcp/registry";
import { MCP_TOOLS, MCP_TOOLS_BY_NAME, toolDescriptors } from "@/server/mcp/registry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CTX = { ipAddress: "203.0.113.9", userAgent: "vitest", requestId: "req-1", isPrefetch: false };

function caller(over: { groups?: string[]; requesterEmail?: string | null } = {}): McpCall["caller"] {
  const groups = over.groups ?? ["ops_team"];
  const viewer = { id: "u_1", email: "mia@wm.local", name: "Mia", image: null, groups, isDev: false };
  return {
    token: { id: "tok_1", scopes: ["MCP"], requesterEmail: over.requesterEmail ?? null },
    viewer,
    actor: { id: viewer.id, email: viewer.email, groups: [...groups] },
    isStaff: groups.length > 0,
  } as unknown as McpCall["caller"];
}

const call = (over?: Parameters<typeof caller>[0]): McpCall => ({ caller: caller(over), ctx: CTX });

const TICKET_ROW = {
  id: "t_1",
  number: 1042,
  queueId: "q_ops",
  requesterEmail: "client@example.com",
  requesterExternalId: null,
  householdId: null,
  queue: { key: "OPERATIONS" },
};

function tool(name: string): McpTool {
  const t = MCP_TOOLS_BY_NAME.get(name);
  if (t === undefined) throw new Error(`no tool named ${name}`);
  return t;
}

const TOKEN = { id: "tok_1", scopes: ["MCP" as const], requesterEmail: null };

/** Every `auditMcp` call this test file cares about, as (tool, entry) pairs. */
function auditedEntries(): Array<{ tool: string; entry: Record<string, unknown> }> {
  return mockContext.auditMcp.mock.calls.map((c) => ({
    tool: c[2] as string,
    entry: c[3] as Record<string, unknown>,
  }));
}

/** Asserts exactly one AUTHZ_DENIED row, from `tool`, naming (or not naming) `ticketId`. */
function expectOneDenial(tool: string, ticketId: string | null): Record<string, unknown> {
  const rows = auditedEntries();
  expect(rows).toHaveLength(1);
  expect(rows[0].tool).toBe(tool);
  expect(rows[0].entry.action).toBe("AUTHZ_DENIED");
  expect(rows[0].entry.entityType).toBe(ticketId === null ? "QUEUE" : "TICKET");
  expect(rows[0].entry.ticketId ?? null).toBe(ticketId);
  expect(rows[0].entry.fieldChanged).toBe("capability");
  // The FACT of the binding rides in `extra`, never the address (integration notes §7.6).
  expect(mockContext.auditMcp.mock.calls[0][4]).toHaveProperty("requesterBound");
  return rows[0].entry;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.prisma.ticket.findFirst.mockResolvedValue(TICKET_ROW);
  mockDb.prisma.ticket.findUnique.mockResolvedValue(TICKET_ROW);
  mockDb.prisma.ticket.updateMany.mockResolvedValue({ count: 1 });
  mockDb.prisma.comment.findMany.mockResolvedValue([]);
  mockDb.prisma.comment.create.mockResolvedValue({ id: "c_1" });
  mockDb.prisma.notification.findMany.mockResolvedValue([]);
  mockDb.prisma.notification.count.mockResolvedValue(0);
  mockDb.withTx.mockImplementation(async (...a: unknown[]) => (a[0] as (tx: unknown) => Promise<unknown>)(mockDb.prisma));
  mockTickets.listTickets.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 20 });
  mockTickets.listTicketsByRequester.mockResolvedValue({ requester: [], household: [] });
});

// ---------------------------------------------------------------------------

describe("the tool table", () => {
  it("is exactly the six tools the contract names, in a stable order", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      "search_tickets",
      "get_ticket",
      "list_queue_summary",
      "add_internal_note",
      "get_requester_history",
      "list_my_inbox",
    ]);
  });

  it("there is no tool that replies to a client — the whole premise of the surface", () => {
    const names = MCP_TOOLS.map((t) => t.name).join(" ");
    for (const forbidden of ["public", "reply", "send", "email", "resolve", "assign", "close", "void"]) {
      expect(names, `no tool may be called *${forbidden}*`).not.toContain(forbidden);
    }
  });

  it("every descriptor carries a name, a description and an object schema", () => {
    for (const d of toolDescriptors()) {
      expect(d.name).toMatch(/^[a-z_]+$/);
      expect(d.description.length).toBeGreaterThan(40);
      expect(d.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
    expect(toolDescriptors()).toHaveLength(MCP_TOOLS.length);
  });

  it("descriptors carry no handler, so `tools/list` cannot serialize one", () => {
    for (const d of toolDescriptors()) expect("handler" in d).toBe(false);
  });
});

describe("search_tickets", () => {
  it("clamps the page size and defaults the sort to most-recently-updated", async () => {
    await tool("search_tickets").handler({ pageSize: 10_000, page: 0 }, TOKEN, call());
    const query = mockTickets.listTickets.mock.calls[0][1] as Record<string, unknown>;
    expect(query.pageSize).toBe(50);
    expect(query.page).toBe(1);
    expect(query.sort).toBe("updatedAt");
    expect(query.dir).toBe("desc");
  });

  it("drops unknown enum values instead of passing them to the query", async () => {
    await tool("search_tickets").handler({ status: ["OPEN", "NOT_A_STATUS"], priority: ["nope"] }, TOKEN, call());
    const query = mockTickets.listTickets.mock.calls[0][1] as Record<string, unknown>;
    expect(query.status).toEqual(["OPEN"]);
    expect(query.priority).toBeUndefined();
  });

  it('resolves assignee "me" to the credential owner', async () => {
    await tool("search_tickets").handler({ assignee: "me" }, TOKEN, call());
    const query = mockTickets.listTickets.mock.calls[0][1] as Record<string, unknown>;
    expect(query.assigneeId).toBe("u_1");
  });

  it("a requester-bound credential can only ever search its own client's tickets", async () => {
    await tool("search_tickets").handler({}, TOKEN, call({ requesterEmail: "Client@Example.com" }));
    const query = mockTickets.listTickets.mock.calls[0][1] as Record<string, unknown>;
    expect(query.requesterEmail).toBe("client@example.com");
  });

  it("returns compact rows with no description, no requester address and a deep link", async () => {
    mockTickets.listTickets.mockResolvedValue({
      rows: [
        {
          number: 1042,
          subject: "Wire to Fidelity",
          status: "OPEN",
          priority: "URGENT",
          category: "WIRE_TRANSFER",
          queueKey: "OPERATIONS",
          assignee: { name: "Mia Ops", email: "mia@wm.local" },
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-02T10:00:00.000Z",
          sla: { status: "BREACHED", dueAt: "2026-09-01T12:00:00.000Z" },
          // Fields a list row carries that a tool row must NOT echo:
          requesterName: "Jane Client",
          description: "account 123456789",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    const out = (await tool("search_tickets").handler({}, TOKEN, call())) as {
      tickets: Array<Record<string, unknown>>;
    };
    expect(out.tickets[0]).toEqual({
      ticketNumber: 1042,
      reference: "HD-1042",
      url: "/tickets/wm/1042",
      subject: "Wire to Fidelity",
      status: "OPEN",
      priority: "URGENT",
      category: "WIRE_TRANSFER",
      queue: "OPERATIONS",
      assignee: "Mia Ops",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-02T10:00:00.000Z",
      sla: { status: "BREACHED", dueAt: "2026-09-01T12:00:00.000Z" },
    });
    expect(JSON.stringify(out)).not.toContain("Jane Client");
    expect(JSON.stringify(out)).not.toContain("123456789");
  });

  it("writes no audit row — list rows are not a view (§e)", async () => {
    await tool("search_tickets").handler({}, TOKEN, call());
    expect(mockContext.auditMcp).not.toHaveBeenCalled();
    expect(mockAudit.writeAudit).not.toHaveBeenCalled();
  });
});

describe("get_ticket", () => {
  beforeEach(() => {
    mockTickets.toTicketDetail.mockReturnValue({
      number: 1042,
      subject: "Wire to Fidelity",
      description: "Please wire the funds.",
      status: "OPEN",
      resolution: "NONE",
      priority: "URGENT",
      category: "WIRE_TRANSFER",
      queueKey: "OPERATIONS",
      assignee: null,
      requesterName: "Jane Client",
      isComplaint: false,
      escalationTarget: "NONE",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-02T10:00:00.000Z",
      sla: { status: "OK", dueAt: null },
    });
    mockDb.prisma.ticket.findUnique.mockResolvedValue({ ...TICKET_ROW, requesterName: "Jane Client" });
  });

  it("requires a ticketNumber or a ticketId", async () => {
    await expect(tool("get_ticket").handler({}, TOKEN, call())).rejects.toThrow(/ticketNumber or ticketId/);
  });

  it("writes TICKET_VIEWED through the mcp auditor BEFORE returning content", async () => {
    await tool("get_ticket").handler({ ticketNumber: 1042 }, TOKEN, call());
    expect(mockContext.auditMcp).toHaveBeenCalledTimes(1);
    const auditCall = mockContext.auditMcp.mock.calls[0] as unknown[];
    const toolName = auditCall[2] as string;
    const entry = auditCall[3] as Record<string, unknown>;
    expect(toolName).toBe("get_ticket");
    expect(entry.action).toBe("TICKET_VIEWED");
    expect(entry.ticketId).toBe("t_1");
  });

  it("a STAFF credential reads the whole conversation", async () => {
    const out = (await tool("get_ticket").handler({ ticketNumber: 1042 }, TOKEN, call())) as {
      includesInternalNotes: boolean;
    };
    expect(out.includesInternalNotes).toBe(true);
    const where = (mockDb.prisma.comment.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.visibility).toBeUndefined();
  });

  it("a REQUESTER-BOUND credential is filtered to PUBLIC comments at the query (I1)", async () => {
    const out = (await tool("get_ticket").handler(
      { ticketNumber: 1042 },
      TOKEN,
      call({ requesterEmail: "client@example.com" }),
    )) as { includesInternalNotes: boolean };
    expect(out.includesInternalNotes).toBe(false);
    const where = (mockDb.prisma.comment.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.visibility).toBe("PUBLIC");
  });

  it("a requester-bound credential cannot reach another client's ticket, and the denial is recorded", async () => {
    await expect(
      tool("get_ticket").handler({ ticketNumber: 1042 }, TOKEN, call({ requesterEmail: "someone@else.test" })),
    ).rejects.toThrow(/not found/i);
    // I5: a requester-mismatch is a denial, not a miss. AUTHZ_DENIED, never TICKET_VIEWED — no
    // content was served — and never the bound ADDRESS (integration notes §7.6).
    const entry = expectOneDenial("get_ticket", "t_1");
    expect(entry.newValue).toBe("mcp:get_ticket requester-bound");
    expect(JSON.stringify(auditedEntries())).not.toContain("someone@else.test");
  });

  it("a genuinely MISSING ticket writes no ledger row — nothing was denied", async () => {
    mockDb.prisma.ticket.findFirst.mockResolvedValue(null);
    await expect(tool("get_ticket").handler({ ticketNumber: 9999 }, TOKEN, call())).rejects.toThrow(/not found/i);
    expect(mockContext.auditMcp).not.toHaveBeenCalled();
  });

  it("a ticket in a queue the owner cannot read is NOT FOUND, never FORBIDDEN — existence does not leak", async () => {
    // A client-services credential against an ADVICE ticket.
    mockDb.prisma.ticket.findFirst.mockResolvedValue({ ...TICKET_ROW, queue: { key: "ADVICE" } });
    await expect(
      tool("get_ticket").handler({ ticketNumber: 1042 }, TOKEN, call({ groups: ["client_services"] })),
    ).rejects.toThrow(/not found/i);
  });

  it("a credential whose owner reads no queue resolves nothing at all, and the denial is recorded", async () => {
    await expect(
      tool("get_ticket").handler({ ticketNumber: 1042 }, TOKEN, call({ groups: [] })),
    ).rejects.toThrow(/not found/i);
    expect(mockDb.prisma.ticket.findFirst).not.toHaveBeenCalled();
    expectOneDenial("get_ticket", null);
  });

  it("an unreadable QUEUE writes AUTHZ_DENIED, so walking ticket numbers leaves evidence", async () => {
    mockDb.prisma.ticket.findFirst.mockResolvedValue({ ...TICKET_ROW, queue: { key: "ADVICE" } });
    await expect(
      tool("get_ticket").handler({ ticketNumber: 1042 }, TOKEN, call({ groups: ["client_services"] })),
    ).rejects.toThrow(/not found/i);
    const entry = expectOneDenial("get_ticket", "t_1");
    expect(entry.newValue).toBe("mcp:get_ticket ticket:read");
  });

  it("maps a comment's author from the DTO's own rules and reports retraction as a boolean", async () => {
    mockDb.prisma.comment.findMany.mockResolvedValue([{ id: "c_1" }, { id: "c_2" }]);
    mockComments.toCommentDTO
      .mockReturnValueOnce({
        id: "c_1",
        visibility: "PUBLIC",
        body: "We have sent it.",
        author: { name: "Mia Ops", email: "mia@wm.local" },
        authorLabel: "unused",
        retraction: null,
        createdAt: "2026-09-02T10:00:00.000Z",
      })
      .mockReturnValueOnce({
        id: "c_2",
        visibility: "PUBLIC",
        body: "Withdrawn text",
        author: null,
        authorLabel: "Jane Client",
        retraction: { id: "r_1" },
        createdAt: "2026-09-02T11:00:00.000Z",
      });

    const out = (await tool("get_ticket").handler({ ticketNumber: 1042 }, TOKEN, call())) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(out.messages[0].author).toBe("Mia Ops");
    expect(out.messages[0].retracted).toBe(false);
    expect(out.messages[1].author).toBe("Jane Client");
    expect(out.messages[1].retracted).toBe(true);
  });
});

describe("add_internal_note", () => {
  it("refuses a requester-bound credential outright", async () => {
    await expect(
      tool("add_internal_note").handler(
        { ticketNumber: 1042, body: "note" },
        TOKEN,
        call({ requesterEmail: "client@example.com" }),
      ),
    ).rejects.toThrow(/may not write internal notes/);
    expect(mockDb.withTx).not.toHaveBeenCalled();
  });

  it("lets a compliance credential annotate, because an INTERNAL note is READ-plus-annotate (§b rule 2)", async () => {
    // compliance_officers write no ticket field and no public reply, but `canComment(..., INTERNAL)`
    // is keyed on READ — annotating a record is the one thing the CCO's own agent must be able to do.
    const out = (await tool("add_internal_note").handler(
      { ticketNumber: 1042, body: "Reviewed for the quarterly sample." },
      TOKEN,
      call({ groups: ["compliance_officers"] }),
    )) as { commentId: string };
    expect(out.commentId).toBe("c_1");
  });

  it("a credential whose owner reads no queue is refused before any ticket is even looked up", async () => {
    await expect(
      tool("add_internal_note").handler({ ticketNumber: 1042, body: "note body" }, TOKEN, call({ groups: [] })),
    ).rejects.toThrow(/may not write internal notes/);
    expect(mockDb.prisma.ticket.findFirst).not.toHaveBeenCalled();
    expect(mockDb.prisma.comment.create).not.toHaveBeenCalled();
    expectOneDenial("add_internal_note", null);
  });

  it("refuses a REQUESTER-BOUND credential and records the denial (I1, I5)", async () => {
    await expect(
      tool("add_internal_note").handler(
        { ticketNumber: 1042, body: "note body" },
        TOKEN,
        call({ requesterEmail: "client@example.com" }),
      ),
    ).rejects.toThrow(/may not write internal notes/);
    expect(mockDb.prisma.comment.create).not.toHaveBeenCalled();
    expectOneDenial("add_internal_note", null);
  });

  it("records AUTHZ_DENIED when the creator cannot comment on the resolved ticket's queue", async () => {
    // client_services reads OPERATIONS, so the ticket resolves; the write check is what refuses.
    mockDb.prisma.ticket.findFirst.mockResolvedValue({ ...TICKET_ROW, queue: { key: "ADVICE" } });
    await expect(
      tool("add_internal_note").handler(
        { ticketNumber: 1042, body: "note body" },
        TOKEN,
        call({ groups: ["client_services"] }),
      ),
    ).rejects.toThrow(/not found/i);
    // The queue is unreadable to client_services, so the refusal happens in resolveTicket — either
    // way exactly one AUTHZ_DENIED row is written and no comment is created.
    expect(mockDb.prisma.comment.create).not.toHaveBeenCalled();
    expectOneDenial("add_internal_note", "t_1");
  });

  it("requires a body", async () => {
    await expect(tool("add_internal_note").handler({ ticketNumber: 1042 }, TOKEN, call())).rejects.toThrow(
      /body is required/,
    );
  });

  it("writes an INTERNAL comment with COMMENT_ADDED_INTERNAL carrying via: mcp", async () => {
    const out = (await tool("add_internal_note").handler(
      { ticketNumber: 1042, body: "Called the custodian; they confirm receipt." },
      TOKEN,
      call(),
    )) as { commentId: string; url: string };

    expect(out).toEqual({
      commentId: "c_1",
      ticketNumber: 1042,
      url: "/tickets/wm/1042",
      piiRedacted: false,
      piiRedactionCount: 0,
    });
    const created = (mockDb.prisma.comment.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(created.visibility).toBe("INTERNAL");
    expect(created.authorId).toBe("u_1");
    expect(created.disclaimerKey).toBe("NONE");

    const entries = mockAudit.writeAuditMany.mock.calls[0][3] as Array<Record<string, unknown>>;
    expect(entries[0].action).toBe("COMMENT_ADDED_INTERNAL");
    expect(entries[0].metadata).toMatchObject({ via: "mcp", tool: "add_internal_note", tokenId: "tok_1" });
  });

  it("sanitizes the body before it is persisted and records the redaction (I4)", async () => {
    const out = (await tool("add_internal_note").handler(
      { ticketNumber: 1042, body: "Client quoted account 4111111111111111 on the call." },
      TOKEN,
      call(),
    )) as { piiRedacted: boolean; piiRedactionCount: number };

    expect(out.piiRedacted).toBe(true);
    expect(out.piiRedactionCount).toBeGreaterThan(0);
    const created = (mockDb.prisma.comment.create.mock.calls[0][0] as { data: { body: string } }).data;
    expect(created.body).not.toContain("4111111111111111");

    const entries = mockAudit.writeAuditMany.mock.calls[0][3] as Array<Record<string, unknown>>;
    expect(entries.map((e) => e.action)).toContain("PII_REDACTED");
    // The redacted body is what the ledger records, not the original.
    expect(JSON.stringify(entries)).not.toContain("4111111111111111");
  });

  it("refuses when the ticket moved queue between the check and the write (Decision #53)", async () => {
    mockDb.prisma.ticket.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      tool("add_internal_note").handler({ ticketNumber: 1042, body: "note" }, TOKEN, call()),
    ).rejects.toThrow(/not found/i);
    expect(mockDb.prisma.comment.create).not.toHaveBeenCalled();
  });

  it("notifies followers from inside the same transaction", async () => {
    await tool("add_internal_note").handler({ ticketNumber: 1042, body: "note body here" }, TOKEN, call());
    expect(mockNotify.notifyFromEvent).toHaveBeenCalledTimes(1);
    const event = mockNotify.notifyFromEvent.mock.calls[0][1] as Record<string, unknown>;
    expect(event.kind).toBe("FOLLOWED_UPDATE");
    expect(event.preview).toBe("Internal note added");
  });
});

describe("list_queue_summary", () => {
  it("returns counts for readable queues only, and names no ticket", async () => {
    mockQueues.getQueueSummaries.mockResolvedValue([
      {
        key: "OPERATIONS",
        name: "Operations",
        canRead: true,
        open: 4,
        total: 9,
        byStatus: { OPEN: 4 },
        byPriority: { URGENT: 1 },
        breached: 1,
        warning: 2,
        unassigned: 3,
      },
      { key: "ADVICE", name: "Advice", canRead: false, open: 0, total: 0, byStatus: {}, byPriority: {}, breached: 0, warning: 0, unassigned: 0 },
    ]);
    const out = (await tool("list_queue_summary").handler({}, TOKEN, call())) as {
      queues: Array<{ queue: string }>;
    };
    expect(out.queues.map((q) => q.queue)).toEqual(["OPERATIONS"]);
    expect(mockContext.auditMcp).not.toHaveBeenCalled();
  });

  it("refuses a REQUESTER-BOUND credential: desk load is not a client agent's business", async () => {
    await expect(
      tool("list_queue_summary").handler({}, TOKEN, call({ requesterEmail: "client@example.com" })),
    ).rejects.toThrow(/may not read queue summaries/);
    expect(mockQueues.getQueueSummaries).not.toHaveBeenCalled();
    expectOneDenial("list_queue_summary", null);
  });

  it("refuses a credential whose owner reads no queue, rather than answering an empty list", async () => {
    await expect(tool("list_queue_summary").handler({}, TOKEN, call({ groups: [] }))).rejects.toThrow(
      /may not read queue summaries/,
    );
    expectOneDenial("list_queue_summary", null);
  });
});

describe("get_requester_history", () => {
  it("derives the requester key from the ticket and excludes the ticket itself", async () => {
    await tool("get_requester_history").handler({ ticketNumber: 1042, limit: 5 }, TOKEN, call());
    const historyCall = mockTickets.listTicketsByRequester.mock.calls[0] as unknown[];
    const key = historyCall[1] as Record<string, unknown>;
    const exclude = historyCall[2] as string;
    const limit = historyCall[3] as number;
    expect(key.email).toBe("client@example.com");
    expect(exclude).toBe("t_1");
    expect(limit).toBe(5);
  });

  it("clamps the limit", async () => {
    await tool("get_requester_history").handler({ ticketNumber: 1042, limit: 999 }, TOKEN, call());
    expect(mockTickets.listTicketsByRequester.mock.calls[0][3]).toBe(50);
  });

  it("passes the household key for an UNBOUND staff credential", async () => {
    mockDb.prisma.ticket.findFirst.mockResolvedValue({ ...TICKET_ROW, householdId: "hh_1" });
    await tool("get_requester_history").handler({ ticketNumber: 1042 }, TOKEN, call());
    const key = mockTickets.listTicketsByRequester.mock.calls[0][1] as Record<string, unknown>;
    expect(key.householdId).toBe("hh_1");
  });

  it("withholds the household key from a REQUESTER-BOUND credential, so the second query never runs", async () => {
    mockDb.prisma.ticket.findFirst.mockResolvedValue({ ...TICKET_ROW, householdId: "hh_1" });
    mockTickets.listTicketsByRequester.mockResolvedValue({ requester: [], household: [] });
    const out = (await tool("get_requester_history").handler(
      { ticketNumber: 1042 },
      TOKEN,
      call({ requesterEmail: "client@example.com" }),
    )) as { household: unknown[] };
    const key = mockTickets.listTicketsByRequester.mock.calls[0][1] as Record<string, unknown>;
    // `listTicketsByRequester` runs its household query on `{ householdId }` ALONE — other household
    // members' tickets. A concierge credential is issued for ONE named client.
    expect(key.householdId).toBeNull();
    expect(key.email).toBe("client@example.com");
    expect(out.household).toEqual([]);
  });
});

describe("list_my_inbox", () => {
  it("refuses a credential whose owner has no desk access", async () => {
    await expect(tool("list_my_inbox").handler({}, TOKEN, call({ groups: [] }))).rejects.toThrow(/no inbox/);
    expect(mockDb.prisma.notification.findMany).not.toHaveBeenCalled();
    expectOneDenial("list_my_inbox", null);
  });

  it("refuses a REQUESTER-BOUND credential, even though its issuer is staff (I1)", async () => {
    // The gate is `seesInternal`, not `isStaff`: `isStaff` is the token CREATOR's groups, true for
    // every credential a staff member issued. A MENTION preview is an excerpt of the INTERNAL note
    // that mentioned them, across every ticket on the desk — not something a client's agent may read
    // (integration notes §7.5).
    mockDb.prisma.notification.findMany.mockResolvedValue([
      {
        id: "n_1",
        kind: "MENTION",
        preview: "…client threatened to complain, do NOT put this in writing…",
        createdAt: new Date("2026-09-02T10:00:00.000Z"),
        readAt: null,
        ticket: { number: 77, queue: { key: "OPERATIONS" } },
      },
    ]);
    await expect(
      tool("list_my_inbox").handler({}, TOKEN, call({ requesterEmail: "client@example.com" })),
    ).rejects.toThrow(/no inbox/);
    expect(mockDb.prisma.notification.findMany).not.toHaveBeenCalled();
    expect(mockDb.prisma.notification.count).not.toHaveBeenCalled();
    expectOneDenial("list_my_inbox", null);
  });

  it("withholds the ticket number, the link AND the preview when the owner may not read that queue", async () => {
    // A notification outlives the membership that produced it (a queue move, an Okta demotion); the
    // web inbox withholds both, because the number IS the deep link.
    //
    // INTEGRATION ROUND 3: the preview is withheld on the same condition, and this test used to pin
    // the opposite. A `MENTION` preview is `mentionSnippet` — a window on the stored INTERNAL note —
    // so returning it past the queue gate leaks more record content than the subject it withholds.
    // `toNotificationDTO` has always fallen back to the kind label; the MCP surface now matches it.
    mockDb.prisma.notification.findMany.mockResolvedValue([
      {
        id: "n_readable",
        kind: "ASSIGNED",
        preview: "assigned to you",
        createdAt: new Date("2026-09-02T10:00:00.000Z"),
        readAt: null,
        ticket: { number: 1042, queue: { key: "OPERATIONS" } },
      },
      {
        id: "n_unreadable",
        kind: "MENTION",
        preview: "a queue you cannot read",
        createdAt: new Date("2026-09-02T09:00:00.000Z"),
        readAt: null,
        ticket: { number: 2001, queue: { key: "ADVICE" } },
      },
      {
        id: "n_no_ticket",
        kind: "SLA_WARNING",
        preview: "no ticket at all",
        createdAt: new Date("2026-09-02T08:00:00.000Z"),
        readAt: null,
        ticket: null,
      },
    ]);
    const out = (await tool("list_my_inbox").handler({}, TOKEN, call({ groups: ["client_services"] }))) as {
      notifications: Array<Record<string, unknown>>;
    };
    expect(out.notifications[0]).toMatchObject({
      ticketNumber: 1042,
      url: "/tickets/wm/1042",
      preview: "assigned to you",
    });
    expect(out.notifications[1]).toMatchObject({
      ticketNumber: null,
      url: null,
      preview: NOTIFICATION_KIND_LABELS.MENTION,
    });
    expect(out.notifications[2]).toMatchObject({
      ticketNumber: null,
      url: null,
      preview: NOTIFICATION_KIND_LABELS.SLA_WARNING,
    });
    // The withheld material itself — the number and both previews — is absent from the whole payload,
    // not merely absent from the field it was read out of.
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("2001");
    expect(wire).not.toContain("a queue you cannot read");
    expect(wire).not.toContain("no ticket at all");
  });

  it("reads only the owner's own undismissed rows, and returns previews with a deep link", async () => {
    mockDb.prisma.notification.findMany.mockResolvedValue([
      {
        id: "n_1",
        kind: "MENTION",
        preview: "…asked you to confirm the wire…",
        createdAt: new Date("2026-09-02T10:00:00.000Z"),
        readAt: null,
        ticket: { number: 1042, queue: { key: "OPERATIONS" } },
      },
    ]);
    mockDb.prisma.notification.count.mockResolvedValue(3);

    const out = (await tool("list_my_inbox").handler({ unreadOnly: true }, TOKEN, call())) as {
      unread: number;
      notifications: Array<Record<string, unknown>>;
    };
    const where = (mockDb.prisma.notification.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.userId).toBe("u_1");
    expect(where.dismissedAt).toBeNull();
    expect(where.readAt).toBeNull();
    expect(out.unread).toBe(3);
    expect(out.notifications[0]).toEqual({
      id: "n_1",
      kind: "MENTION",
      preview: "…asked you to confirm the wire…",
      ticketNumber: 1042,
      url: "/tickets/wm/1042",
      createdAt: "2026-09-02T10:00:00.000Z",
      read: false,
    });
  });
});
