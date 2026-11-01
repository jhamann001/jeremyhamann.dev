/**
 * The six MCP tools — node, layer L4.
 *
 * The premise the whole surface rests on: **an agent reads the desk and annotates it, and never
 * speaks to a client.** `add_internal_note` is the only tool that writes and it writes an INTERNAL
 * comment; there is no `add_public_reply`, no status change, no assignment and no macro application,
 * and their absence is the design rather than a backlog. A public reply is correspondence a firm is
 * answerable for, it carries a disclaimer, it stamps the SLA clock and it queues an outbound message;
 * a model producing one unattended is not a feature this desk wants to be able to switch on. The AI
 * drafting seam is the supported path: a model drafts, a person edits, a person submits.
 *
 * Every tool runs as the token's creator (`context.ts`) and re-checks that person's RBAC per call —
 * `canReadQueue` on every read, `canComment(..., "INTERNAL")` on the write. There is no MCP-specific
 * permission and there is no way for an agent to exceed the human who issued its credential.
 *
 * ## What is and is not audited
 *
 * Contract §3 rule 1 says every MCP action carries `metadata.via = "mcp"`. Which actions exist is
 * decided by `docs/ARCHITECTURE.md` §e, not by this file:
 *
 *  - `get_ticket` reads a description and comment bodies. That is a VIEW: `TICKET_VIEWED`, awaited
 *    before any content is returned, carrying `via: "mcp"`, the tool name and the token id.
 *  - `add_internal_note` writes `COMMENT_ADDED_INTERNAL` (and `PII_REDACTED` when the sanitizer
 *    fired), in the same transaction as the comment, with the same `via`.
 *  - `search_tickets`, `get_requester_history`, `list_queue_summary` and `list_my_inbox` return LIST
 *    ROWS AND COUNTS — no description, no comment body, no requester address. §e says that is not a
 *    view, `listTicketsByRequester` says so in its own docstring, and §3 rule 3 says a notification
 *    row is not separately audited. Writing a row anyway would put "read client material" in the
 *    ledger for something that carried none, which is worse than silence: it teaches a reviewer that
 *    the action means less than it says. They are logged (structured, counts only) instead.
 *
 *  - A refusal a TOOL makes — no readable queue, a queue this creator may not read, a ticket outside
 *    the token's requester binding, a write this creator may not make, an inbox this credential is
 *    not issued for — writes `AUTHZ_DENIED` through `recordMcpDenial`, awaited, before it throws.
 *    I5 is unqualified about this and the route only ever honoured it for the two PRE-tool denials.
 *
 * A neutral `MCP_TOOL_CALLED` action, which would let the ledger answer "what did this agent do" for
 * the four list tools too, needs a new value in the foundation-owned catalog and is requested in
 * the build record
 */
import type { AuditEntry, QueueKey, TicketListQuery, TicketPriority, TicketStatus } from "@/types/domain";
import {
  NOTIFICATION_KIND_LABELS,
  QUEUE_KEYS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  WAVE_B_LIMITS,
} from "@/types/domain";
import type { VerifiedToken } from "@/lib/api-tokens";
import type { RequestContext } from "@/types/domain";
import { deniedEntityType, writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { logInfo } from "@/lib/logger";
import { formatPiiCounts, sanitizePII } from "@/lib/pii";
import { canComment, canReadQueue, readableQueues } from "@/lib/rbac";
import { safeEqualEmails } from "@/lib/safe-equal";
import { getQueueSummaries } from "@/server/queues";
import { notifyFromEvent } from "@/server/notifications";
import {
  TICKET_INCLUDE,
  listTickets,
  listTicketsByRequester,
  toTicketDetail,
  wmTicketPath,
} from "@/server/tickets";
import { loadSlaBands } from "@/server/sla-where";
import { COMMENT_INCLUDE, toCommentDTO } from "@/server/comments";
import type { McpCaller } from "@/server/mcp/context";
import { auditMcp, mcpMetadata } from "@/server/mcp/context";

/**
 * What a tool handler is given besides its arguments.
 *
 * **Deviation from CONTRACT §10 B8, recorded in the integration notes §3.** The contract's
 * `handler(args, token)` cannot produce an audit row: every `AuditLog` row needs the IP, user agent
 * and request id that live in `RequestContext`, and there is no ambient request store here —
 * `getRequestContext()` reads `next/headers`, which does not exist when a test drives the handler
 * with a constructed `Request`. The third parameter is the smallest faithful change; `token` is kept
 * as the second, redundantly with `call.caller.token`, so the contract's shape still reads true.
 */
export type McpCall = { caller: McpCaller; ctx: RequestContext };

export type McpTool = {
  name: string;
  description: string;
  /** A JSON Schema object, sent verbatim in `tools/list`. Plain data — no zod at the protocol edge. */
  inputSchema: unknown;
  handler(args: unknown, token: VerifiedToken, call: McpCall): Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Argument reading — hostile input, null-prototype objects, no zod at this edge
// ---------------------------------------------------------------------------

function args(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function readString(a: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = a[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > max) throw new ValidationError(`${key} is too long (max ${max} characters)`);
  return trimmed;
}

function readInt(a: Record<string, unknown>, key: string): number | undefined {
  const v = a[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return undefined;
  return v;
}

function readEnumList<T extends string>(
  a: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T[] | undefined {
  const v = a[key];
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is T => typeof x === "string" && (allowed as readonly string[]).includes(x));
  return out.length === 0 ? undefined : [...new Set(out)];
}

function readEnum<T extends string>(a: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const v = a[key];
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** Bounds every page an agent can ask for. A model that asks for 10,000 rows gets 50. */
const MAX_TOOL_PAGE_SIZE = 50;
const DEFAULT_TOOL_PAGE_SIZE = 20;

function pageBounds(a: Record<string, unknown>): { page: number; pageSize: number } {
  const page = readInt(a, "page");
  const pageSize = readInt(a, "pageSize");
  return {
    page: page !== undefined && page >= 1 ? page : 1,
    pageSize: pageSize !== undefined && pageSize >= 1 ? Math.min(pageSize, MAX_TOOL_PAGE_SIZE) : DEFAULT_TOOL_PAGE_SIZE,
  };
}

/**
 * Whether this credential may see INTERNAL material.
 *
 * Two conditions, and the second is the one that matters: the creator must read at least one queue
 * (an agent cannot exceed its issuer), AND the token must not be bound to a single requester. A
 * requester-bound `mcp` token is a credential issued to act FOR a named client — a concierge agent —
 * and an internal note is not something a client's agent may read, however senior the person who
 * pressed "create" was. That is invariant I1 arriving through a new door, and it gets the same answer.
 */
function seesInternal(caller: McpCaller): boolean {
  return caller.isStaff && caller.token.requesterEmail === null;
}

/**
 * Structured log for a list-shaped call. Counts and a tool name; never a subject or an address.
 *
 * `logInfo`, not `console.info`: `console` is the sink security scanner's CWE-209 rule watches, and the repository
 * rule is that nothing in the app runtime writes to it at all rather than that error-bearing calls
 * are filtered out one at a time (the build record). It also puts this line in the same JSON
 * shape as every other app and jobs line, so one Cloud Logging query reads the MCP surface too.
 */
function logListCall(caller: McpCaller, ctx: RequestContext, tool: string, returned: number): void {
  logInfo("mcp", "list_call", {
    tool,
    tokenId: caller.token.id,
    actorId: caller.viewer.id,
    returned,
    requestId: ctx.requestId,
  });
}

/** The stored key is a Prisma enum; this is the narrowing `canReadQueue` needs, with no cast. */
function isQueueKey(value: string | undefined): value is QueueKey {
  return value !== undefined && (QUEUE_KEYS as readonly string[]).includes(value);
}

/**
 * `AUTHZ_DENIED` for a refusal a TOOL makes, as `recordDenied` does for the staff paths and
 * `runAction` does for every `ForbiddenError` a server action throws.
 *
 * I5 is unqualified — "**Every** denial ... is written as `AUTHZ_DENIED`" — and before this the MCP
 * surface honoured it only for the two PRE-tool denials the route makes (the bearer rejection and an
 * inactive creator). A refusal INSIDE a tool wrote nothing, so an agent could walk `ticketNumber`
 * 1..N and learn which tickets exist outside its issuer's queues with the ledger none the wiser.
 *
 * These rows are NOT on Decision #71's coalesced path, and deliberately: a coalesced counter is for
 * anonymous pre-authentication probing, where one hash-chained insert per packet is the exposure.
 * Here the caller is authenticated and attributable — the token id and its creator are both known —
 * which is §3 rule 4's "few and attributable, one row each".
 *
 * Awaited, errors propagating, before the refusal is thrown: a denial that cannot be recorded
 * fails the request rather than being silently swallowed.
 */
async function recordMcpDenial(
  call: McpCall,
  tool: string,
  what: string,
  ticketId?: string | null,
): Promise<void> {
  await auditMcp(
    call.caller,
    call.ctx,
    tool,
    {
      action: "AUTHZ_DENIED",
      entityType: deniedEntityType(what, ticketId),
      entityId: ticketId ?? null,
      ticketId: ticketId ?? null,
      fieldChanged: "capability",
      newValue: what,
    },
    // The FACT of the binding, never the bound ADDRESS (integration notes §7.6): "was this a
    // concierge credential" is the question an administrator reading the row asks, and a client's
    // mailbox is not their business.
    { requesterBound: call.caller.token.requesterEmail !== null },
  );
}

// ---------------------------------------------------------------------------
// Shared ticket resolution
// ---------------------------------------------------------------------------

type ResolvedTicket = {
  id: string;
  number: number;
  queueId: string;
  queueKey: QueueKey;
  requesterEmail: string | null;
  requesterExternalId: string | null;
  householdId: string | null;
};

/** The columns `resolveTicket` needs. One constant, so the two branches cannot drift apart. */
const TICKET_RESOLVE_SELECT = {
  id: true,
  number: true,
  queueId: true,
  requesterEmail: true,
  requesterExternalId: true,
  householdId: true,
  queue: { select: { key: true } },
} as const;

/**
 * `ticketNumber` or `ticketId` → a ticket this caller may read. Throws `NotFoundError` for a missing
 * ticket AND for one in a queue the caller cannot read, so existence never leaks, exactly as
 * `getTicketDetail` is careful to do.
 *
 * A requester-bound token additionally only resolves ITS requester's tickets.
 *
 * Every refusal here that is an AUTHORIZATION decision — no readable queue, an unreadable queue, a
 * ticket outside the token's requester binding — writes `AUTHZ_DENIED` first. A ticket that
 * simply does not exist writes nothing, exactly as `getTicketDetail` returns null on a missing row
 * before it reaches `recordDenied`: nothing was denied, there is no entity to name, and a row per
 * probe of a number that was never issued would grow the hash chain without recording a decision.
 */
async function resolveTicket(
  call: McpCall,
  tool: string,
  a: Record<string, unknown>,
): Promise<ResolvedTicket> {
  const caller = call.caller;
  const number = readInt(a, "ticketNumber");
  const id = readString(a, "ticketId", 64);
  if (number === undefined && id === undefined) {
    throw new ValidationError("give either ticketNumber or ticketId");
  }
  const queues = readableQueues(caller.viewer.groups);
  if (queues.length === 0) {
    await recordMcpDenial(call, tool, `mcp:${tool} ticket:read`);
    throw new NotFoundError("ticket not found");
  }

  const row =
    number !== undefined
      ? await prisma.ticket.findFirst({
          where: { number },
          select: TICKET_RESOLVE_SELECT,
        })
      : await prisma.ticket.findUnique({
          where: { id: id as string },
          select: TICKET_RESOLVE_SELECT,
        });

  if (row === null) throw new NotFoundError("ticket not found");
  if (!canReadQueue(caller.viewer.groups, row.queue.key)) {
    await recordMcpDenial(call, tool, `mcp:${tool} ticket:read`, row.id);
    throw new NotFoundError("ticket not found");
  }
  const bound = caller.token.requesterEmail;
  // `safeEqualEmails` (CWE-208), the same call `src/server/client-view.ts` makes for the same decision:
  // whether a credential bound to one address may read this ticket. It is an identity check, so it is
  // constant-time, and it applies the SAME trim + lower-case to both sides — the inline `.toLowerCase()`
  // pair it replaces lower-cased both but trimmed neither, so a stored binding with stray whitespace
  // used to match nothing. The `!== null` that remains is the column's nullability, not an address
  // comparison: a token with no binding is unrestricted here, exactly as before.
  if (bound !== null && (row.requesterEmail === null || !safeEqualEmails(row.requesterEmail, bound))) {
    // The binding is the whole point of a concierge credential; a ticket outside it is a denial and
    // is recorded as one, never the bound ADDRESS (integration notes §7.6).
    await recordMcpDenial(call, tool, `mcp:${tool} requester-bound`, row.id);
    throw new NotFoundError("ticket not found");
  }
  return {
    id: row.id,
    number: row.number,
    queueId: row.queueId,
    queueKey: row.queue.key,
    requesterEmail: row.requesterEmail,
    requesterExternalId: row.requesterExternalId,
    householdId: row.householdId,
  };
}

/** The compact list row an agent gets. No description, no comment body, no requester address. */
function toToolRow(row: {
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: string;
  queueKey: QueueKey;
  assignee: { name: string | null; email: string } | null;
  createdAt: string;
  updatedAt: string;
  sla: { status: string; dueAt: string | null };
}): Record<string, unknown> {
  return {
    ticketNumber: row.number,
    reference: `HD-${row.number}`,
    url: wmTicketPath(row.number),
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    category: row.category,
    queue: row.queueKey,
    assignee: row.assignee === null ? null : (row.assignee.name ?? row.assignee.email),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sla: { status: row.sla.status, dueAt: row.sla.dueAt },
  };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const searchTickets: McpTool = {
  name: "search_tickets",
  description:
    "Search the help desk for tickets the calling credential's owner may read. Returns list rows " +
    "(number, subject, status, priority, queue, assignee, SLA) — never a description or a comment. " +
    "Use get_ticket for the contents of one ticket.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free text matched against the subject and description." },
      status: { type: "array", items: { type: "string", enum: [...TICKET_STATUSES] } },
      priority: { type: "array", items: { type: "string", enum: [...TICKET_PRIORITIES] } },
      category: { type: "array", items: { type: "string", enum: [...TICKET_CATEGORIES] } },
      queueKey: { type: "string", enum: [...QUEUE_KEYS] },
      assignee: { type: "string", description: '"me" for the credential owner, or "unassigned".' },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1, maximum: MAX_TOOL_PAGE_SIZE },
    },
    additionalProperties: false,
  },
  async handler(raw, _token, call) {
    const a = args(raw);
    const { page, pageSize } = pageBounds(a);
    const assignee = readEnum(a, "assignee", ["me", "unassigned"] as const);
    const query: TicketListQuery = {
      sort: "updatedAt",
      dir: "desc",
      page,
      pageSize,
      ...(readString(a, "query", 200) === undefined ? {} : { search: readString(a, "query", 200) }),
      ...(readEnumList(a, "status", TICKET_STATUSES) === undefined
        ? {}
        : { status: readEnumList(a, "status", TICKET_STATUSES) }),
      ...(readEnumList(a, "priority", TICKET_PRIORITIES) === undefined
        ? {}
        : { priority: readEnumList(a, "priority", TICKET_PRIORITIES) }),
      ...(readEnumList(a, "category", TICKET_CATEGORIES) === undefined
        ? {}
        : { category: readEnumList(a, "category", TICKET_CATEGORIES) }),
      ...(readEnum(a, "queueKey", QUEUE_KEYS) === undefined ? {} : { queueKey: readEnum(a, "queueKey", QUEUE_KEYS) }),
      ...(assignee === undefined ? {} : { assigneeId: assignee === "me" ? call.caller.viewer.id : "unassigned" }),
      // A requester-bound credential can only ever see its own client's tickets.
      ...(call.caller.token.requesterEmail === null
        ? {}
        : { requesterEmail: call.caller.token.requesterEmail.toLowerCase() }),
    };

    const result = await listTickets(call.caller.viewer, query);
    logListCall(call.caller, call.ctx, "search_tickets", result.rows.length);
    return {
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      tickets: result.rows.map(toToolRow),
    };
  },
};

const getTicket: McpTool = {
  name: "get_ticket",
  description:
    "One ticket in full: its fields, its description and its conversation. A staff credential also " +
    "receives INTERNAL notes; a credential bound to a single requester receives public messages only. " +
    "This is an audited read of client material.",
  inputSchema: {
    type: "object",
    properties: {
      ticketNumber: { type: "integer", minimum: 1, description: "The WM number, e.g. 1042 for HD-1042." },
      ticketId: { type: "string", description: "The internal id, when the number is not to hand." },
    },
    additionalProperties: false,
  },
  async handler(raw, _token, call) {
    const resolved = await resolveTicket(call, "get_ticket", args(raw));
    const internal = seesInternal(call.caller);

    const row = await prisma.ticket.findUnique({ where: { id: resolved.id }, include: TICKET_INCLUDE });
    if (row === null) throw new NotFoundError("ticket not found");

    const comments = await prisma.comment.findMany({
      where: { ticketId: resolved.id, ...(internal ? {} : { visibility: "PUBLIC" }) },
      include: COMMENT_INCLUDE,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
    });

    // I3: the ledger row before the content, awaited, errors propagating. `via: "mcp"` is what
    // distinguishes this from the same person opening the ticket in a browser.
    await auditMcp(call.caller, call.ctx, "get_ticket", {
      action: "TICKET_VIEWED",
      entityType: "TICKET",
      entityId: resolved.id,
      ticketId: resolved.id,
      newValue: "mcp",
    });

    const detail = toTicketDetail(row, call.caller.viewer, new Date(), await loadSlaBands());
    const dtos = comments.map((c) => toCommentDTO(c, row.requesterName));
    return {
      ticketNumber: detail.number,
      reference: `HD-${detail.number}`,
      url: wmTicketPath(detail.number),
      subject: detail.subject,
      description: detail.description,
      status: detail.status,
      resolution: detail.resolution,
      priority: detail.priority,
      category: detail.category,
      queue: detail.queueKey,
      assignee: detail.assignee === null ? null : (detail.assignee.name ?? detail.assignee.email),
      requesterName: detail.requesterName,
      isComplaint: detail.isComplaint,
      escalationTarget: detail.escalationTarget,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      sla: detail.sla,
      includesInternalNotes: internal,
      messages: dtos.map((c) => ({
        id: c.id,
        visibility: c.visibility,
        // A STAFF row names its author; a REQUESTER or SYSTEM row carries the label instead, because
        // neither is a User. Same rule the staff timeline follows.
        author: c.author === null ? c.authorLabel : (c.author.name ?? c.author.email),
        // A withdrawn reply keeps its stored body on staff surfaces (the desk has to be able to read
        // what it sent), and says so. The CLIENT surface never receives it at all — the view blanks it.
        body: c.body,
        retracted: c.retraction !== null,
        createdAt: c.createdAt,
      })),
    };
  },
};

const listQueueSummary: McpTool = {
  name: "list_queue_summary",
  description:
    "Counts per queue — open, by status, by priority, breached, warning and unassigned — for the " +
    "queues the calling credential's owner may read. Counts only: no ticket is named. Refused to a " +
    "credential bound to a single requester: desk load is not a fact a client's agent is issued for.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async handler(_raw, _token, call) {
    // The same line `add_internal_note` draws. Firmwide open / breached / unassigned counts are an
    // operational picture of the desk; a concierge credential is issued to act for ONE named client,
    // and aggregate desk load is not part of that client's business (I1 through the same new door).
    if (!seesInternal(call.caller)) {
      await recordMcpDenial(call, "list_queue_summary", "mcp:list_queue_summary");
      throw new ForbiddenError("this credential may not read queue summaries");
    }
    const summaries = await getQueueSummaries(call.caller.viewer);
    const readable = summaries.filter((q) => q.canRead);
    logListCall(call.caller, call.ctx, "list_queue_summary", readable.length);
    return {
      generatedAt: new Date().toISOString(),
      queues: readable.map((q) => ({
        queue: q.key,
        name: q.name,
        open: q.open,
        total: q.total,
        byStatus: q.byStatus,
        byPriority: q.byPriority,
        breached: q.breached,
        warning: q.warning,
        unassigned: q.unassigned,
      })),
    };
  },
};

const addInternalNote: McpTool = {
  name: "add_internal_note",
  description:
    "Add an INTERNAL note to a ticket, as the owner of the calling credential. Internal notes are " +
    "never shown to a client. There is deliberately no tool for replying to a client — a public " +
    "reply is correspondence the firm answers for, and a person writes and sends it.",
  inputSchema: {
    type: "object",
    properties: {
      ticketNumber: { type: "integer", minimum: 1 },
      ticketId: { type: "string" },
      body: { type: "string", minLength: 1, maxLength: WAVE_B_LIMITS.draftMaxChars },
    },
    required: ["body"],
    additionalProperties: false,
  },
  async handler(raw, _token, call) {
    const a = args(raw);
    if (!seesInternal(call.caller)) {
      await recordMcpDenial(call, "add_internal_note", "mcp:add_internal_note comment:internal");
      throw new ForbiddenError("this credential may not write internal notes");
    }
    const body = readString(a, "body", WAVE_B_LIMITS.draftMaxChars);
    if (body === undefined) throw new ValidationError("body is required");

    const ticket = await resolveTicket(call, "add_internal_note", a);
    if (!canComment(call.caller.viewer.groups, ticket.queueKey, "INTERNAL")) {
      await recordMcpDenial(call, "add_internal_note", "mcp:add_internal_note comment:internal", ticket.id);
      throw new ForbiddenError("comment:internal", ticket.id);
    }

    // Sanitized exactly as the composer sanitizes a typed note. A model pasting an account
    // number out of an email it was given is the ordinary case here, not the exotic one.
    const sanitized = sanitizePII(body);
    const actor = call.caller.actor;

    return withTx(async (tx) => {
      // The same atomic queue re-check `addInternalNote` makes: the ticket must still
      // be in the queue the RBAC check was based on, and this takes the row lock and the version bump.
      const guard = await tx.ticket.updateMany({
        where: { id: ticket.id, queueId: ticket.queueId },
        data: {
          version: { increment: 1 },
          ...(sanitized.redacted
            ? { piiRedacted: true, piiRedactionCount: { increment: sanitized.count } }
            : {}),
        },
      });
      if (guard.count === 0) throw new NotFoundError("ticket not found");

      const comment = await tx.comment.create({
        data: {
          ticketId: ticket.id,
          authorId: call.caller.viewer.id,
          visibility: "INTERNAL",
          body: sanitized.text,
          disclaimerKey: "NONE",
          piiRedacted: sanitized.redacted,
          piiRedactionCount: sanitized.count,
        },
        select: { id: true },
      });

      const entries: AuditEntry[] = [
        {
          action: "COMMENT_ADDED_INTERNAL",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: ticket.id,
          fieldChanged: "body",
          oldValue: null,
          newValue: sanitized.text,
          metadata: mcpMetadata(call.caller, "add_internal_note"),
        },
      ];
      if (sanitized.redacted) {
        entries.push({
          action: "PII_REDACTED",
          entityType: "COMMENT",
          entityId: comment.id,
          ticketId: ticket.id,
          fieldChanged: "body",
          oldValue: null,
          newValue: formatPiiCounts(sanitized.byKind),
          metadata: mcpMetadata(call.caller, "add_internal_note"),
        });
      }
      const notified = await notifyFromEvent(tx, {
        kind: "FOLLOWED_UPDATE",
        ticketId: ticket.id,
        commentId: comment.id,
        preview: "Internal note added",
        actorId: call.caller.viewer.id,
      });
      entries.push(...notified.auditEntries);

      await writeAuditMany(tx, actor, call.ctx, entries);

      return {
        commentId: comment.id,
        ticketNumber: ticket.number,
        url: wmTicketPath(ticket.number),
        piiRedacted: sanitized.redacted,
        piiRedactionCount: sanitized.count,
      };
    });
  },
};

const getRequesterHistory: McpTool = {
  name: "get_requester_history",
  description:
    "Other tickets from the same requester, and other tickets in the same household, for one " +
    "ticket. List rows only — no description and no comment — and scoped to the queues the calling " +
    "credential's owner may read. A credential bound to a single requester receives that requester's " +
    "own history only; the household array is always empty for it.",
  inputSchema: {
    type: "object",
    properties: {
      ticketNumber: { type: "integer", minimum: 1 },
      ticketId: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: MAX_TOOL_PAGE_SIZE },
    },
    additionalProperties: false,
  },
  async handler(raw, _token, call) {
    const a = args(raw);
    const ticket = await resolveTicket(call, "get_requester_history", a);
    const limit = readInt(a, "limit");
    // A requester-bound credential is issued to act FOR one named client, and `listTicketsByRequester`
    // runs its household query on `{ householdId }` ALONE — other household members' tickets, with
    // their subjects, assignees and SLA. Withholding the key suppresses that query outright rather
    // than filtering its rows afterwards, so nothing is read that is then thrown away.
    const bound = call.caller.token.requesterEmail !== null;
    const history = await listTicketsByRequester(
      call.caller.viewer,
      {
        email: ticket.requesterEmail,
        requesterExternalId: ticket.requesterExternalId,
        householdId: bound ? null : ticket.householdId,
      },
      ticket.id,
      limit !== undefined && limit >= 1 ? Math.min(limit, MAX_TOOL_PAGE_SIZE) : undefined,
    );
    logListCall(call.caller, call.ctx, "get_requester_history", history.requester.length + history.household.length);
    return {
      forTicket: ticket.number,
      requester: history.requester.map(toToolRow),
      household: history.household.map(toToolRow),
    };
  },
};

const listMyInbox: McpTool = {
  name: "list_my_inbox",
  description:
    "The notification inbox of the credential owner: what was assigned to them, who mentioned them, " +
    "which followed tickets moved and which SLA clocks are close. Previews only, never a full note. " +
    "Refused to a credential bound to a single requester, and a row whose ticket is in a queue the " +
    "owner may not read shows neither a number nor a link.",
  inputSchema: {
    type: "object",
    properties: {
      unreadOnly: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: MAX_TOOL_PAGE_SIZE },
    },
    additionalProperties: false,
  },
  async handler(raw, _token, call) {
    const a = args(raw);
    // `seesInternal`, NOT `isStaff`. `isStaff` is derived from the token CREATOR's groups, so it is
    // true for every credential a staff member issued — including one bound to a single requester.
    // A MENTION preview is an excerpt of the INTERNAL note that mentioned them (`mentionSnippet` in
    // src/server/notifications.ts), across every ticket on the desk rather than the bound client's,
    // so this inbox is internal material and a concierge credential is refused it outright — the
    // same line `add_internal_note` and `get_ticket` already draw (integration notes §7.5).
    if (!seesInternal(call.caller)) {
      await recordMcpDenial(call, "list_my_inbox", "mcp:list_my_inbox");
      throw new ForbiddenError("this credential has no inbox");
    }
    const unreadOnly = a.unreadOnly === true;
    const limit = readInt(a, "limit");
    const take = limit !== undefined && limit >= 1 ? Math.min(limit, MAX_TOOL_PAGE_SIZE) : DEFAULT_TOOL_PAGE_SIZE;

    const [rows, unread] = await Promise.all([
      prisma.notification.findMany({
        where: {
          userId: call.caller.viewer.id,
          dismissedAt: null,
          ...(unreadOnly ? { readAt: null } : {}),
        },
        select: {
          id: true,
          kind: true,
          preview: true,
          createdAt: true,
          readAt: true,
          ticket: { select: { number: true, queue: { select: { key: true } } } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
      }),
      prisma.notification.count({ where: { userId: call.caller.viewer.id, readAt: null, dismissedAt: null } }),
    ]);

    logListCall(call.caller, call.ctx, "list_my_inbox", rows.length);
    return {
      unread,
      notifications: rows.map((n) => {
        // The same withholding the web inbox applies in `toNotificationDTO`: a notification outlives
        // the group membership that produced it (a queue move, an Okta demotion), and the number IS
        // the deep link, so a row the owner may no longer open shows neither.
        //
        // INTEGRATION ROUND 3: `preview` is withheld on the SAME condition, which is what the web
        // surface has always done and what the sentence that stood here wrongly denied. For `MENTION`
        // the preview is `mentionSnippet` — a +/-80-character window on the stored INTERNAL note — so
        // returning it to a caller the queue grant excludes hands over up to 160 characters of the
        // note while refusing the subject: strictly MORE record content than the field being withheld,
        // on the one channel that is machine-readable and scriptable. `listMentionableUsers` is the
        // whole active staff directory, so a mention naming someone outside the queue needs no group
        // change to occur. The fallback is the kind label, exactly as `toNotificationDTO` and
        // `slackDmLine` do it: the caller is told they were named, not what was said.
        const queueKey = n.ticket?.queue.key;
        const readable =
          n.ticket !== null && isQueueKey(queueKey) && canReadQueue(call.caller.viewer.groups, queueKey)
            ? n.ticket
            : null;
        return {
          id: n.id,
          kind: n.kind,
          preview: readable === null ? NOTIFICATION_KIND_LABELS[n.kind] : n.preview,
          ticketNumber: readable === null ? null : readable.number,
          url: readable === null ? null : wmTicketPath(readable.number),
          createdAt: n.createdAt.toISOString(),
          read: n.readAt !== null,
        };
      }),
    };
  },
};

/** The six tools, in the order `tools/list` presents them: read, read, read, write, read, read. */
export const MCP_TOOLS: readonly McpTool[] = Object.freeze([
  searchTickets,
  getTicket,
  listQueueSummary,
  addInternalNote,
  getRequesterHistory,
  listMyInbox,
]);

/** Name → tool, built once. `tools/call` on an unknown name is a JSON-RPC `invalidParams`. */
export const MCP_TOOLS_BY_NAME: ReadonlyMap<string, McpTool> = new Map(MCP_TOOLS.map((t) => [t.name, t]));

/** The `tools/list` payload: names, descriptions and schemas, with no handlers. */
export function toolDescriptors(): Array<{ name: string; description: string; inputSchema: unknown }> {
  return MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}
