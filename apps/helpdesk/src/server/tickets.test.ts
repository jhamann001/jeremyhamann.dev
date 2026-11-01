/**
 * S3 ticket-permission tests (docs/ARCHITECTURE.md §g S3 tests; §b capability matrix; §b.9 CLOSED semantics).
 *
 * Pure — no database. Expected values are written out from the §b tables (not derived from the rbac helpers),
 * then the result is additionally checked against the helpers `computeTicketPermissions` is specified in terms
 * of, so a drift in either direction fails here.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  OktaGroup,
  QueueKey,
  TicketDetailDTO,
  TicketListQuery,
  TicketListRow,
  TicketStatus,
  Viewer,
} from "@/types/domain";
import {
  ALLOWED_STATUS_TRANSITIONS,
  CLIENT_CONTACT_CHANNELS,
  CLIENT_CONTACT_NOTE_PREFIX,
  FOLLOW_UP_FILTERS,
  OKTA_GROUPS,
  QUEUE_KEYS,
  TICKET_STATUSES,
} from "@/types/domain";
import { ValidationError } from "@/lib/errors";
import { startOfFirmDay } from "@/lib/firm-time";
import { followUpState } from "@/components/tickets/flag-state";
import { canComment, canMoveTicket, canReadQueue, canWriteQueue, readableQueues } from "@/lib/rbac";
import { slaStatusWhere } from "@/server/sla-where";
import type { WarningMinutesByPriority } from "@/server/sla-where";
import type { TicketWithRefs } from "@/server/tickets";
import {
  assertTicketNotClosed,
  buildListWhere,
  computeTicketPermissions,
  followUpWhere,
  formatClientContactNote,
  parseClientContactNote,
  queuesForQuery,
  toTicketDetail,
  toTicketListRow,
  wmTicketPath,
} from "@/server/tickets";

function viewerOf(groups: OktaGroup[]): Viewer {
  return {
    id: `matrix_${groups.join("_") || "none"}`,
    email: "matrix@wm-helpdesk.local",
    name: "Matrix Viewer",
    image: null,
    groups,
    isDev: false,
  };
}

const SUPERVISOR: OktaGroup[] = ["ops_team", "client_services", "advisors"];
// VOIDED is refused by `assertTicketNotClosed` too, with its own message, so it is not in
// the "passes silently" set either.
const NON_CLOSED: TicketStatus[] = TICKET_STATUSES.filter((s) => s !== "CLOSED" && s !== "VOIDED");

/** §b queue-access table: the single queue each group WRITES (W implies R). */
const WRITES: Record<OktaGroup, QueueKey | null> = {
  ops_team: "OPERATIONS",
  advisors: "ADVICE",
  client_services: "CLIENT_SERVICE",
  compliance_officers: null,
};

/** §b queue-access table: queues a group cannot even read ("—"). */
const NO_READ: Record<OktaGroup, readonly QueueKey[]> = {
  ops_team: [],
  advisors: [],
  client_services: ["ADVICE"],
  compliance_officers: [],
};

/**
 * §b ticket:move as Decision #67 states it: WRITE on the source queue, READ on the destination,
 * never the same queue at both ends. Derived from the policy helpers rather than hard-coded, so the
 * matrix below tracks `canMoveTicket` instead of re-asserting a stale table.
 */
function expectedMovableTo(groups: readonly OktaGroup[], from: QueueKey): QueueKey[] {
  if (!canWriteQueue(groups, from)) return [];
  return QUEUE_KEYS.filter((to) => to !== from && canReadQueue(groups, to));
}

describe("computeTicketPermissions — §b matrix per single group on open-like statuses", () => {
  for (const group of OKTA_GROUPS) {
    for (const queueKey of QUEUE_KEYS) {
      for (const status of NON_CLOSED) {
        it(`${group} × ${queueKey} × ${status}`, () => {
          const p = computeTicketPermissions(viewerOf([group]), { queueKey, status });
          const writes = WRITES[group] === queueKey;
          const reads = !NO_READ[group].includes(queueKey);
          const movableTo = expectedMovableTo([group], queueKey);

          expect(p.canWrite).toBe(writes);
          expect(p.canPublicReply).toBe(writes);
          expect(p.canInternalNote).toBe(reads);
          expect(p.movableTo).toEqual(movableTo);
          expect(p.canMove).toBe(movableTo.length > 0);
          expect(p.allowedStatuses).toEqual(writes ? [...ALLOWED_STATUS_TRANSITIONS[status]] : []);
        });
      }
    }
  }

  it("compliance_officers is read-plus-annotate everywhere: internal notes on every queue, nothing operational (§b rule 2)", () => {
    for (const queueKey of QUEUE_KEYS) {
      const p = computeTicketPermissions(viewerOf(["compliance_officers"]), { queueKey, status: "OPEN" });
      expect(p.canInternalNote).toBe(true);
      expect(p.canWrite).toBe(false);
      expect(p.canPublicReply).toBe(false);
      expect(p.canMove).toBe(false);
      expect(p.movableTo).toEqual([]);
      expect(p.allowedStatuses).toEqual([]);
    }
  });

  it("client_services cannot read ADVICE: every permission false, including internal notes", () => {
    const p = computeTicketPermissions(viewerOf(["client_services"]), { queueKey: "ADVICE", status: "NEW" });
    expect(p).toEqual({
      canWrite: false,
      canInternalNote: false,
      canPublicReply: false,
      canMove: false,
      movableTo: [],
      allowedStatuses: [],
    });
  });

  it("ops_team cannot push a ticket out of a queue it only READS (Decision #67 kept the source check)", () => {
    const p = computeTicketPermissions(viewerOf(["ops_team"]), { queueKey: "CLIENT_SERVICE", status: "OPEN" });
    expect(p.canWrite).toBe(false);
    expect(p.canPublicReply).toBe(false);
    expect(p.canInternalNote).toBe(true);
    expect(p.canMove).toBe(false);
    expect(p.movableTo).toEqual([]);
    expect(p.allowedStatuses).toEqual([]);
  });

  it("ops_team hands a ticket OUT of the queue it writes, to either queue it reads (Decision #67)", () => {
    const p = computeTicketPermissions(viewerOf(["ops_team"]), { queueKey: "OPERATIONS", status: "OPEN" });
    expect(p.canWrite).toBe(true);
    expect(p.canMove).toBe(true);
    expect(p.movableTo).toEqual(["CLIENT_SERVICE", "ADVICE"]);
  });

  it("client_services hands its own ticket to Operations — the CS→Ops hand-off Decision #67 exists for", () => {
    const p = computeTicketPermissions(viewerOf(["client_services"]), { queueKey: "CLIENT_SERVICE", status: "OPEN" });
    expect(p.canWrite).toBe(true);
    expect(p.canMove).toBe(true);
    // ADVICE is absent: client_services has no access to it at all, so it is not a legal destination.
    expect(p.movableTo).toEqual(["OPERATIONS"]);
  });
});

describe("computeTicketPermissions — union semantics (§b rule 1)", () => {
  it("the supervisor persona writes all three queues and moves any → any", () => {
    for (const queueKey of QUEUE_KEYS) {
      const p = computeTicketPermissions(viewerOf(SUPERVISOR), { queueKey, status: "OPEN" });
      expect(p.canWrite).toBe(true);
      expect(p.canPublicReply).toBe(true);
      expect(p.canInternalNote).toBe(true);
      expect(p.movableTo).toEqual(QUEUE_KEYS.filter((q) => q !== queueKey));
      expect(p.canMove).toBe(true);
      expect(p.allowedStatuses).toEqual([...ALLOWED_STATUS_TRANSITIONS.OPEN]);
    }
  });

  it("advisors + client_services write both of their queues and hand off to anything they read", () => {
    const p = computeTicketPermissions(viewerOf(["advisors", "client_services"]), { queueKey: "ADVICE", status: "OPEN" });
    expect(p.canWrite).toBe(true);
    // Declaration order of QUEUE_KEYS: OPERATIONS (read) then CLIENT_SERVICE (write).
    expect(p.movableTo).toEqual(["OPERATIONS", "CLIENT_SERVICE"]);
    expect(p.canMove).toBe(true);
    const ops = computeTicketPermissions(viewerOf(["advisors", "client_services"]), { queueKey: "OPERATIONS", status: "OPEN" });
    expect(ops.canWrite).toBe(false);
    expect(ops.movableTo).toEqual([]);
  });

  it("zero recognized groups holds nothing (§b rule 3)", () => {
    for (const queueKey of QUEUE_KEYS) {
      for (const status of TICKET_STATUSES) {
        expect(computeTicketPermissions(viewerOf([]), { queueKey, status })).toEqual({
          canWrite: false,
          canInternalNote: false,
          canPublicReply: false,
          canMove: false,
          movableTo: [],
          allowedStatuses: [],
        });
      }
    }
  });
});

describe("computeTicketPermissions — CLOSED is read-plus-annotate for everyone (§b.9)", () => {
  const personas: Array<{ label: string; groups: OktaGroup[] }> = [
    ...OKTA_GROUPS.map((g) => ({ label: g, groups: [g] })),
    { label: "supervisor", groups: SUPERVISOR },
    { label: "dual-role", groups: ["compliance_officers", "ops_team"] },
  ];

  for (const { label, groups } of personas) {
    for (const queueKey of QUEUE_KEYS) {
      it(`${label} × ${queueKey} × CLOSED`, () => {
        const closed = computeTicketPermissions(viewerOf(groups), { queueKey, status: "CLOSED" });
        const open = computeTicketPermissions(viewerOf(groups), { queueKey, status: "OPEN" });
        expect(closed.canWrite).toBe(false);
        expect(closed.canPublicReply).toBe(false);
        expect(closed.canMove).toBe(false);
        expect(closed.movableTo).toEqual([]);
        expect(closed.allowedStatuses).toEqual([]);
        // The one status-independent permission.
        expect(closed.canInternalNote).toBe(open.canInternalNote);
        expect(closed.canInternalNote).toBe(canComment(groups, queueKey, "INTERNAL"));
      });
    }
  }

  it("RESOLVED behaves like an open status: writers keep write/reply/move and get RESOLVED → OPEN | CLOSED", () => {
    const p = computeTicketPermissions(viewerOf(["ops_team"]), { queueKey: "OPERATIONS", status: "RESOLVED" });
    expect(p.canWrite).toBe(true);
    expect(p.canPublicReply).toBe(true);
    expect(p.canInternalNote).toBe(true);
    expect(p.canMove).toBe(true);
    expect(p.movableTo).toEqual(["CLIENT_SERVICE", "ADVICE"]);
    expect(p.allowedStatuses).toEqual(["OPEN", "CLOSED"]);
  });

  it("allowedStatuses is exactly ALLOWED_STATUS_TRANSITIONS[status] for a writer and [] otherwise, for every status", () => {
    for (const status of TICKET_STATUSES) {
      const writer = computeTicketPermissions(viewerOf(["advisors"]), { queueKey: "ADVICE", status });
      const reader = computeTicketPermissions(viewerOf(["advisors"]), { queueKey: "OPERATIONS", status });
      expect(writer.allowedStatuses).toEqual(status === "CLOSED" ? [] : [...ALLOWED_STATUS_TRANSITIONS[status]]);
      expect(reader.allowedStatuses).toEqual([]);
    }
  });
});

describe("computeTicketPermissions — agrees with the rbac helpers it is specified in terms of", () => {
  const unions: OktaGroup[][] = [
    ...OKTA_GROUPS.map((g) => [g]),
    SUPERVISOR,
    ["compliance_officers", "ops_team"],
    ["advisors", "client_services"],
    [],
  ];

  for (const groups of unions) {
    it(`[${groups.join(", ")}]`, () => {
      for (const queueKey of QUEUE_KEYS) {
        for (const status of TICKET_STATUSES) {
          const p = computeTicketPermissions(viewerOf(groups), { queueKey, status });
          // VOIDED is read-plus-annotate exactly like CLOSED, and for a stronger reason — the
          // ticket is asserted never to have happened, so nothing may be written to it afterwards.
          const closed = status === "CLOSED" || status === "VOIDED";
          expect(p.canWrite).toBe(canWriteQueue(groups, queueKey) && !closed);
          expect(p.canInternalNote).toBe(canComment(groups, queueKey, "INTERNAL"));
          expect(p.canPublicReply).toBe(canComment(groups, queueKey, "PUBLIC") && !closed);
          expect(p.movableTo).toEqual(closed ? [] : QUEUE_KEYS.filter((to) => canMoveTicket(groups, queueKey, to)));
          expect(p.canMove).toBe(p.movableTo.length > 0);
        }
      }
    });
  }
});

describe("assertTicketNotClosed (§b.9)", () => {
  it("throws ValidationError('ticket is closed') → code VALIDATION only for CLOSED", () => {
    let thrown: unknown;
    try {
      assertTicketNotClosed({ status: "CLOSED" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).code).toBe("VALIDATION");
    expect((thrown as ValidationError).message).toBe("ticket is closed");
  });

  it("passes silently for every other status, RESOLVED included", () => {
    for (const status of NON_CLOSED) {
      expect(() => assertTicketNotClosed({ status })).not.toThrow();
    }
  });
});

describe("toTicketListRow / toTicketDetail — the OCC token travels on list rows (I13, contract amendment #46)", () => {
  const NOW = new Date("2026-09-16T12:00:00.000Z");
  const user = { id: "staff_ops_2", name: "Mia Ops", email: "staff_ops_2@wm-helpdesk.local", image: null };
  const fixture: TicketWithRefs = {
    id: "t_fixture",
    number: 25,
    subject: "Outgoing wire",
    // A body written BEFORE Decision #116, carrying a `[REDACTED:ROUTING]` token this desk no longer
    // writes. Kept deliberately: redaction is irreversible and nothing is backfilled, so a DTO mapper
    // has to keep handling rows like this one. Nothing here re-sanitizes it.
    description: "Instructions received by email: routing [REDACTED:ROUTING], account number [REDACTED:ACCOUNT ****6789].",
    clientReference: null,
    requesterName: "Margaret Thompson",
    requesterEmail: "margaret.thompson@example.com",
    // --- Wave A columns. Defaults that make a pre-Wave-A row correct. ---
    requesterPhone: null,
    brand: "CEDAR_RIDGE_WEALTH",
    source: "STAFF_FORM",
    externalId: null,
    householdId: null,
    requesterExternalId: null,
    isComplaint: false,
    complaintFiledAt: null,
    escalationTarget: "NONE",
    followUpAt: null,
    externalRef: null,
    linkedFromTicketId: null,
    // --- Wave B columns. Defaults that make a pre-Wave-B row correct. ---
    resolution: "NONE",
    mergedIntoId: null,
    mergedAt: null,
    voidedAt: null,
    voidedById: null,
    voidReason: null,
    category: "WIRE_TRANSFER",
    priority: "URGENT",
    status: "OPEN",
    queueId: "q_ops",
    createdById: user.id,
    assigneeId: user.id,
    slaFirstResponseMinutes: 30,
    slaResolutionMinutes: 120,
    firstResponseDueAt: new Date("2026-09-16T12:30:00.000Z"),
    resolutionDueAt: new Date("2026-09-16T14:00:00.000Z"),
    firstRespondedAt: null,
    resolvedAt: null,
    closedAt: null,
    piiRedacted: true,
    piiRedactionCount: 2,
    version: 7,
    createdAt: new Date("2026-09-16T12:00:00.000Z"),
    updatedAt: new Date("2026-09-16T12:05:00.000Z"),
    queue: { id: "q_ops", key: "OPERATIONS", name: "Operations" },
    assignee: user,
    createdBy: user,
    mergedInto: null,
  };

  it("TicketListRow carries the row's version so the dashboard's inline AssigneeSelect can call assignTicket", () => {
    const row = toTicketListRow(fixture, NOW);
    expect(row.version).toBe(7);
    expectTypeOf<TicketListRow["version"]>().toEqualTypeOf<number>();
  });

  it("TicketDetailDTO inherits the single declaration and agrees with the list row", () => {
    const detail = toTicketDetail(fixture, viewerOf(["ops_team"]), NOW);
    expect(detail.version).toBe(7);
    expect(detail.version).toBe(toTicketListRow(fixture, NOW).version);
    expectTypeOf<TicketDetailDTO["version"]>().toEqualTypeOf<number>();
    // Every list-row field is present, unchanged, on the detail DTO.
    expect(detail).toMatchObject(toTicketListRow(fixture, NOW));
  });

  it("list rows never carry record content (description / comments) — only the detail DTO does", () => {
    const row = toTicketListRow(fixture, NOW) as Record<string, unknown>;
    expect(row).not.toHaveProperty("description");
    expect(row).not.toHaveProperty("requesterEmail");
    expect(row).not.toHaveProperty("permissions");
  });
});

// ---------------------------------------------------------------------------
// pure helpers behind the new filters, the deep link and the client-contact note
//. Database-backed behaviour is covered in ticket-export.integration.test.ts.
// ---------------------------------------------------------------------------

describe("followUpWhere — the unresponsive-client cadence predicate", () => {
  const NOW = new Date("2026-09-19T15:30:00.000Z");

  it("'any' is every ticket that has a follow-up date at all", () => {
    expect(followUpWhere("any", NOW)).toEqual({ followUpAt: { not: null } });
  });

  it("'due' is everything whose date has arrived — including earlier today", () => {
    expect(followUpWhere("due", NOW)).toEqual({ followUpAt: { not: null, lte: NOW } });
  });

  /**
   * The boundary is the FIRM clock's midnight (`startOfFirmDay`), not the process's — the badge that
   * says "Follow-up overdue" is derived in the viewer's browser as often as on the server, and a filter
   * measured from the container's midnight disagreed with it for five hours a day.
   */
  it("'overdue' measures from the start of the current day on the firm clock, so today's follow-ups are not yet late", () => {
    const w = followUpWhere("overdue", NOW) as { followUpAt: { not: null; lt: Date } };
    expect(w.followUpAt.lt).toEqual(startOfFirmDay(NOW));
    // 2026-09-19 00:00 in America/New_York — the same instant whatever zone this process runs in.
    expect(w.followUpAt.lt.toISOString()).toBe("2026-09-19T04:00:00.000Z");
    expect(w.followUpAt.lt.getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(w.followUpAt.not).toBeNull();
  });

  it("agrees with the badge: an instant the flag calls overdue is inside the filter, and a 'due' one is not", () => {
    const w = followUpWhere("overdue", NOW) as { followUpAt: { not: null; lt: Date } };
    const yesterdayEvening = new Date("2026-09-19T03:30:00.000Z"); // 23:30 ET on the 18th
    const earlierToday = new Date("2026-09-19T13:00:00.000Z"); // 09:00 ET on the 19th
    expect(followUpState(yesterdayEvening.toISOString(), NOW)).toBe("overdue");
    expect(yesterdayEvening.getTime()).toBeLessThan(w.followUpAt.lt.getTime());
    expect(followUpState(earlierToday.toISOString(), NOW)).toBe("due");
    expect(earlierToday.getTime()).toBeGreaterThanOrEqual(w.followUpAt.lt.getTime());
  });

  it("every branch requires a non-null followUpAt — a ticket with no cadence never matches", () => {
    for (const filter of FOLLOW_UP_FILTERS) {
      const w = followUpWhere(filter, NOW) as { followUpAt: { not: null } };
      expect(w.followUpAt.not, filter).toBeNull();
    }
  });
});

describe("queuesForQuery — the export and the list read the same queues (I5)", () => {
  const listQuery = (queueKey?: QueueKey): TicketListQuery => {
    const q: TicketListQuery = { sort: "resolutionDueAt", dir: "asc", page: 1, pageSize: 50 };
    if (queueKey !== undefined) q.queueKey = queueKey;
    return q;
  };

  it("with no queueKey it is exactly readableQueues(viewer)", () => {
    for (const group of OKTA_GROUPS) {
      const viewer = viewerOf([group]);
      expect(queuesForQuery(viewer, listQuery()), group).toEqual(readableQueues(viewer.groups));
    }
  });

  it("a queueKey narrows to that queue only when the viewer can read it, never widens", () => {
    const cs = viewerOf(["client_services"]);
    expect(queuesForQuery(cs, listQuery("CLIENT_SERVICE"))).toEqual(["CLIENT_SERVICE"]);
    expect(queuesForQuery(cs, listQuery("OPERATIONS"))).toEqual(["OPERATIONS"]);
    // client_services has no access to ADVICE: asking for it yields nothing, not everything.
    expect(queuesForQuery(cs, listQuery("ADVICE"))).toEqual([]);
  });

  it("a viewer with no recognized group reads nothing (§b.3)", () => {
    expect(queuesForQuery(viewerOf([]), listQuery())).toEqual([]);
  });
});

describe("wmTicketPath — the deep link", () => {
  it("is the relative /tickets/wm/<number> path the route resolves", () => {
    expect(wmTicketPath(1042)).toBe("/tickets/wm/1042");
    expect(wmTicketPath(1)).toBe("/tickets/wm/1");
  });
});

describe("client-contact note format (Decision #66)", () => {
  it("prefixes with the shared marker and round-trips through the parser", () => {
    for (const channel of CLIENT_CONTACT_CHANNELS) {
      const body = formatClientContactNote(channel, "Reached Margaret; she will send the statement.");
      expect(body.startsWith(CLIENT_CONTACT_NOTE_PREFIX)).toBe(true);
      expect(parseClientContactNote(body)).toEqual({
        channel,
        note: "Reached Margaret; she will send the statement.",
      });
    }
  });

  it("preserves a multi-line note verbatim, including blank lines", () => {
    const note = "Line one\n\nLine two\nLine three";
    expect(parseClientContactNote(formatClientContactNote("PHONE", note))?.note).toBe(note);
  });

  it("returns null for an ordinary internal note and for a forged-looking prefix", () => {
    expect(parseClientContactNote("Called the client back.")).toBeNull();
    expect(parseClientContactNote(`${CLIENT_CONTACT_NOTE_PREFIX} [TELEPATHY]\n\nnope`)).toBeNull();
    // The marker only counts at the very start of the body.
    expect(parseClientContactNote(`FYI\n${CLIENT_CONTACT_NOTE_PREFIX} [PHONE]\n\nnope`)).toBeNull();
  });
});

describe("buildListWhere — the requester predicates (I14: the opaque one is what the UI links)", () => {
  const VIEWER: Viewer = viewerOf(["ops_team"]);
  const BASE: TicketListQuery = { sort: "createdAt", dir: "desc", page: 1, pageSize: 25 };
  const NOW = new Date("2026-09-19T12:00:00.000Z");

  /** The AND clauses `buildListWhere` produced, flattened for lookup. */
  function clauses(query: TicketListQuery): Record<string, unknown>[] {
    const where = buildListWhere(VIEWER, ["OPERATIONS"], query, NOW);
    const and = where.AND;
    return (Array.isArray(and) ? and : and === undefined ? [] : [and]) as Record<string, unknown>[];
  }

  it("filters on an exact requesterExternalId", () => {
    const found = clauses({ ...BASE, requesterExternalId: "ops_portal_person_01H9" }).filter(
      (c) => "requesterExternalId" in c,
    );
    expect(found).toEqual([{ requesterExternalId: "ops_portal_person_01H9" }]);
  });

  it("adds nothing when it is unset", () => {
    expect(clauses(BASE).filter((c) => "requesterExternalId" in c)).toEqual([]);
  });

  it("is an equality match, not a contains — a substring would pull in another client", () => {
    const [clause] = clauses({ ...BASE, requesterExternalId: "abc" }).filter(
      (c) => "requesterExternalId" in c,
    );
    expect(typeof clause?.requesterExternalId).toBe("string");
  });

  it("composes with the address predicate rather than replacing it", () => {
    const both = clauses({ ...BASE, requesterExternalId: "abc", requesterEmail: "A@B.example" });
    expect(both).toContainEqual({ requesterExternalId: "abc" });
    expect(both).toContainEqual({ requesterEmail: "a@b.example" });
  });
});

describe("buildListWhere — the SLA filter runs on the caller's LIVE bands (Decision #99)", () => {
  const VIEWER: Viewer = viewerOf(["ops_team"]);
  const BASE: TicketListQuery = { sort: "createdAt", dir: "desc", page: 1, pageSize: 25 };
  const NOW = new Date("2026-09-19T12:00:00.000Z");
  // URGENT warns two hours out, the rest at the shipped default — the shape `/admin/sla` produces the
  // moment anybody edits one row.
  const BANDS: WarningMinutesByPriority = { URGENT: 120, HIGH: 30, STANDARD: 30, LOW: 30 };

  /**
   * The one AND clause `slaStatusWhere` contributes. It is the only clause carrying BOTH the metrics
   * exclusion (`status`) and an OR, so it is unambiguous as long as the query names no status filter.
   */
  function slaClause(query: TicketListQuery, warnings?: WarningMinutesByPriority): Record<string, unknown> {
    const where = buildListWhere(VIEWER, ["OPERATIONS"], query, NOW, warnings);
    const and = (Array.isArray(where.AND) ? where.AND : []) as Record<string, unknown>[];
    const found = and.filter((c) => "status" in c && Array.isArray(c.OR));
    expect(found).toHaveLength(1);
    return found[0];
  }

  const WARNING_QUERY: TicketListQuery = { ...BASE, slaStatus: ["WARNING"] };

  it("hands the bands to slaStatusWhere rather than letting it fall back to 30 minutes", () => {
    // The predicate the list ACTUALLY runs has to be the one the chips are coloured by. Before this was
    // threaded, `buildListWhere` had no `warnings` parameter at all, so a ticket could be returned by
    // the "SLA: Warning" filter while its own chip rendered ON_TRACK.
    expect(slaClause(WARNING_QUERY, BANDS)).toEqual(slaStatusWhere(["WARNING"], NOW, BANDS));
  });

  it("actually changes the emitted SQL — the default is not the same predicate", () => {
    // Guards the assertion above against passing vacuously if the bands were dropped on the floor.
    expect(slaClause(WARNING_QUERY, BANDS)).not.toEqual(slaClause(WARNING_QUERY));
    expect(slaClause(WARNING_QUERY)).toEqual(slaStatusWhere(["WARNING"], NOW));
  });

  it("still reads the 30-minute default when the caller has no chips to agree with", () => {
    // A BREACHED/MET-only surface, or a pure test: those verdicts do not depend on the band at all.
    expect(slaClause({ ...BASE, slaStatus: ["BREACHED"] }, BANDS)).toEqual(
      slaClause({ ...BASE, slaStatus: ["BREACHED"] }),
    );
  });
});
