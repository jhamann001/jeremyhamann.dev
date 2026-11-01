/**
 * RBAC policy tests — the §b matrix, table-driven (§g S2 tests).
 * Owned by S2 per shared convention 10; exercises S1's pure src/lib/rbac.ts.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES, OKTA_GROUPS, QUEUE_KEYS } from "@/types/domain";
import type { Capability, OktaGroup, QueueKey } from "@/types/domain";
import { ForbiddenError } from "@/lib/errors";
import {
  OPERATIONAL_GROUPS,
  QUEUE_ACCESS,
  assertCan,
  can,
  canAdminMacros,
  canAdminUsers,
  canChangeRequesterEmail,
  canReleaseHeldIntake,
  canReviewHeldIntake,
  canExportTickets,
  canReadAttachment,
  canWriteAttachment,
  canComment,
  canCreateTicket,
  canExportAudit,
  canMoveTicket,
  canReadQueue,
  canVerifyAudit,
  canViewAudit,
  canWriteQueue,
  creatableQueues,
  hasAny,
  isDualRole,
  isGroup,
  isPathAllowed,
  parseGroups,
  queueKeyFromSlug,
  queueSlug,
  readableQueues,
  safeRelativePath,
  writableQueues,
} from "@/lib/rbac";

const OPS: OktaGroup[] = ["ops_team"];
const ADV: OktaGroup[] = ["advisors"];
const CS: OktaGroup[] = ["client_services"];
const COMP: OktaGroup[] = ["compliance_officers"];
const SUPERVISOR: OktaGroup[] = ["ops_team", "client_services", "advisors"];
const DUAL: OktaGroup[] = ["ops_team", "compliance_officers"];
const NONE: OktaGroup[] = [];

/** §b "Queue access" table: W implies R. */
const QUEUE_TABLE: Record<OktaGroup, Record<QueueKey, "W" | "R" | "-">> = {
  ops_team: { OPERATIONS: "W", CLIENT_SERVICE: "R", ADVICE: "R" },
  advisors: { OPERATIONS: "R", CLIENT_SERVICE: "R", ADVICE: "W" },
  client_services: { OPERATIONS: "R", CLIENT_SERVICE: "W", ADVICE: "-" },
  compliance_officers: { OPERATIONS: "R", CLIENT_SERVICE: "R", ADVICE: "R" },
};

/** §b "Capabilities" table: which queues each single group holds the capability on. */
const CAPABILITY_TABLE: Record<
  "queue:read" | "queue:write" | "ticket:create" | "comment:internal" | "comment:public",
  Record<OktaGroup, QueueKey[]>
> = {
  "queue:read": {
    ops_team: ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"],
    advisors: ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"],
    client_services: ["OPERATIONS", "CLIENT_SERVICE"],
    compliance_officers: ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"],
  },
  "queue:write": {
    ops_team: ["OPERATIONS"],
    advisors: ["ADVICE"],
    client_services: ["CLIENT_SERVICE"],
    compliance_officers: [],
  },
  "ticket:create": {
    ops_team: ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"],
    advisors: ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"],
    client_services: ["OPERATIONS", "CLIENT_SERVICE"],
    compliance_officers: [],
  },
  "comment:internal": {
    ops_team: ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"],
    advisors: ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"],
    client_services: ["OPERATIONS", "CLIENT_SERVICE"],
    compliance_officers: ["OPERATIONS", "CLIENT_SERVICE", "ADVICE"],
  },
  "comment:public": {
    ops_team: ["OPERATIONS"],
    advisors: ["ADVICE"],
    client_services: ["CLIENT_SERVICE"],
    compliance_officers: [],
  },
};

describe("constants", () => {
  it("OPERATIONAL_GROUPS is exactly ops_team, advisors, client_services", () => {
    expect([...OPERATIONAL_GROUPS]).toEqual(["ops_team", "advisors", "client_services"]);
    expect(OPERATIONAL_GROUPS).not.toContain("compliance_officers");
  });

  it("QUEUE_ACCESS mirrors the §b queue-access table", () => {
    for (const g of OKTA_GROUPS) {
      for (const q of QUEUE_KEYS) {
        const expected = QUEUE_TABLE[g][q];
        const actual = QUEUE_ACCESS[g][q];
        expect(actual, `${g} × ${q}`).toBe(expected === "W" ? "WRITE" : expected === "R" ? "READ" : null);
      }
    }
  });
});

describe("queue access per single group (§b table)", () => {
  for (const g of OKTA_GROUPS) {
    for (const q of QUEUE_KEYS) {
      const cell = QUEUE_TABLE[g][q];
      it(`${g} × ${q} → ${cell}`, () => {
        expect(canReadQueue([g], q)).toBe(cell !== "-");
        expect(canWriteQueue([g], q)).toBe(cell === "W");
        if (cell === "W") expect(canReadQueue([g], q)).toBe(true); // W implies R
      });
    }
  }
});

describe("capability matrix per single group (§b table, via `can`)", () => {
  for (const cap of Object.keys(CAPABILITY_TABLE) as (keyof typeof CAPABILITY_TABLE)[]) {
    for (const g of OKTA_GROUPS) {
      const granted = CAPABILITY_TABLE[cap][g];
      it(`${cap} × ${g} → [${granted.join(", ")}]`, () => {
        for (const q of QUEUE_KEYS) {
          expect(can([g], cap, { queueKey: q }), `${cap} ${g} ${q}`).toBe(granted.includes(q));
        }
      });
    }
  }

  it("direct helpers agree with the dispatcher", () => {
    for (const g of OKTA_GROUPS) {
      for (const q of QUEUE_KEYS) {
        expect(canReadQueue([g], q)).toBe(can([g], "queue:read", { queueKey: q }));
        expect(canWriteQueue([g], q)).toBe(can([g], "queue:write", { queueKey: q }));
        expect(canCreateTicket([g], q)).toBe(can([g], "ticket:create", { queueKey: q }));
        expect(canComment([g], q, "INTERNAL")).toBe(can([g], "comment:internal", { queueKey: q }));
        expect(canComment([g], q, "PUBLIC")).toBe(can([g], "comment:public", { queueKey: q }));
      }
    }
  });

  it("audit capabilities belong to compliance_officers only", () => {
    for (const g of OKTA_GROUPS) {
      const expected = g === "compliance_officers";
      expect(canViewAudit([g])).toBe(expected);
      expect(canExportAudit([g])).toBe(expected);
      expect(canVerifyAudit([g])).toBe(expected);
      for (const cap of ["audit:view", "audit:export", "audit:verify"] as const) {
        expect(can([g], cap)).toBe(expected);
        expect(can([g], cap, { queueKey: "OPERATIONS" })).toBe(expected); // ctx is irrelevant
      }
    }
  });

  it("queue-scoped capabilities without context are denied", () => {
    const scoped: Capability[] = ["queue:read", "queue:write", "ticket:create", "comment:internal", "comment:public"];
    for (const cap of scoped) {
      expect(can(SUPERVISOR, cap)).toBe(false);
      expect(can(SUPERVISOR, cap, {})).toBe(false);
    }
    expect(can(OPS, "ticket:move")).toBe(false);
    expect(can(OPS, "ticket:move", { fromQueueKey: "OPERATIONS" })).toBe(false);
    expect(can(OPS, "ticket:move", { toQueueKey: "ADVICE" })).toBe(false);
    expect(can(OPS, "ticket:move", { fromQueueKey: "OPERATIONS", toQueueKey: "ADVICE" })).toBe(true);
  });
});

describe("canCreateTicket = canReadQueue && operational group", () => {
  it("compliance can read every queue but create in none", () => {
    for (const q of QUEUE_KEYS) {
      expect(canReadQueue(COMP, q)).toBe(true);
      expect(canCreateTicket(COMP, q)).toBe(false);
    }
    expect(creatableQueues(COMP)).toEqual([]);
  });

  it("client_services creates in OPERATIONS and CLIENT_SERVICE, never ADVICE", () => {
    expect(creatableQueues(CS)).toEqual(["OPERATIONS", "CLIENT_SERVICE"]);
    expect(canCreateTicket(CS, "ADVICE")).toBe(false);
  });

  it("ops_team and advisors create in all three", () => {
    expect(creatableQueues(OPS)).toEqual([...QUEUE_KEYS]);
    expect(creatableQueues(ADV)).toEqual([...QUEUE_KEYS]);
  });
});

describe("canMoveTicket (§b ticket:move — Decision #67 widened Decision 21: WRITE source, READ destination)", () => {
  it("ops_team moves any → any, but never from a queue to itself", () => {
    for (const from of QUEUE_KEYS) {
      for (const to of QUEUE_KEYS) {
        // ops_team writes OPERATIONS and reads the other two, so under the widened rule it can move
        // OUT of OPERATIONS only — the general rule replaced the old ops_team special case.
        const expected = from !== to && canWriteQueue(OPS, from) && canReadQueue(OPS, to);
        expect(canMoveTicket(OPS, from, to), `${from} → ${to}`).toBe(expected);
      }
    }
    expect(canMoveTicket(OPS, "OPERATIONS", "CLIENT_SERVICE")).toBe(true);
    expect(canMoveTicket(OPS, "OPERATIONS", "ADVICE")).toBe(true);
    // Read-only on CLIENT_SERVICE: ops_team can PULL a ticket by other means, but it cannot push a
    // ticket out of a queue it does not write. That half of Decision 21 is unchanged.
    expect(canMoveTicket(OPS, "CLIENT_SERVICE", "OPERATIONS")).toBe(false);
  });

  it("the hand-off Decision #67 exists for: client_services pushes CLIENT_SERVICE → OPERATIONS", () => {
    expect(canMoveTicket(CS, "CLIENT_SERVICE", "OPERATIONS")).toBe(true);
    // CS has no access to ADVICE at all, so it still cannot send a ticket there.
    expect(canMoveTicket(CS, "CLIENT_SERVICE", "ADVICE")).toBe(false);
    // …and it still cannot move a ticket it only reads.
    expect(canMoveTicket(CS, "OPERATIONS", "CLIENT_SERVICE")).toBe(false);
  });

  it("advisors push ADVICE → either queue they read, and move nothing they cannot write", () => {
    expect(canMoveTicket(ADV, "ADVICE", "OPERATIONS")).toBe(true);
    expect(canMoveTicket(ADV, "ADVICE", "CLIENT_SERVICE")).toBe(true);
    expect(canMoveTicket(ADV, "OPERATIONS", "ADVICE")).toBe(false);
    expect(canMoveTicket(ADV, "CLIENT_SERVICE", "ADVICE")).toBe(false);
  });

  it("compliance_officers still moves NOTHING: read-plus-annotate is unchanged (§b rule 2)", () => {
    for (const from of QUEUE_KEYS) {
      for (const to of QUEUE_KEYS) {
        expect(canMoveTicket(COMP, from, to), `compliance ${from} → ${to}`).toBe(false);
      }
    }
  });

  it("a queue is never both ends of a move, for anyone", () => {
    for (const groups of [OPS, ADV, CS, COMP, SUPERVISOR]) {
      for (const q of QUEUE_KEYS) {
        expect(canMoveTicket(groups, q, q), `${groups.join("+")} ${q} → ${q}`).toBe(false);
      }
    }
  });

  it("a user writing both source and destination may move (advisors + client_services)", () => {
    const both: OktaGroup[] = ["advisors", "client_services"];
    expect(canMoveTicket(both, "ADVICE", "CLIENT_SERVICE")).toBe(true);
    expect(canMoveTicket(both, "CLIENT_SERVICE", "ADVICE")).toBe(true);
    // Neither group writes OPERATIONS, so the source check still refuses.
    expect(canMoveTicket(both, "OPERATIONS", "ADVICE")).toBe(false);
    // Writes ADVICE, reads OPERATIONS → the hand-off is now allowed.
    expect(canMoveTicket(both, "ADVICE", "OPERATIONS")).toBe(true);
  });

  it("the supervisor union writes all three queues, so it moves any → any", () => {
    for (const from of QUEUE_KEYS) {
      for (const to of QUEUE_KEYS) {
        expect(canMoveTicket(SUPERVISOR, from, to), `${from} → ${to}`).toBe(from !== to);
      }
    }
  });
});

describe("union semantics (§b rule 1)", () => {
  it("supervisor persona writes all three queues and cannot see audit", () => {
    expect(writableQueues(SUPERVISOR)).toEqual([...QUEUE_KEYS]);
    expect(readableQueues(SUPERVISOR)).toEqual([...QUEUE_KEYS]);
    expect(creatableQueues(SUPERVISOR)).toEqual([...QUEUE_KEYS]);
    for (const q of QUEUE_KEYS) {
      expect(canComment(SUPERVISOR, q, "PUBLIC")).toBe(true);
      expect(canComment(SUPERVISOR, q, "INTERNAL")).toBe(true);
    }
    expect(canViewAudit(SUPERVISOR)).toBe(false);
    expect(canExportAudit(SUPERVISOR)).toBe(false);
    expect(canVerifyAudit(SUPERVISOR)).toBe(false);
    expect(isDualRole(SUPERVISOR)).toBe(false);
  });

  it("compliance + operational group is allowed (union) and flagged dualRole", () => {
    expect(canViewAudit(DUAL)).toBe(true);
    expect(canWriteQueue(DUAL, "OPERATIONS")).toBe(true);
    expect(canCreateTicket(DUAL, "ADVICE")).toBe(true);
    expect(isDualRole(DUAL)).toBe(true);
    expect(isDualRole(["compliance_officers", "advisors"])).toBe(true);
    expect(isDualRole(["compliance_officers", "client_services"])).toBe(true);
  });

  it("isDualRole is false for pure compliance, pure operational and empty", () => {
    expect(isDualRole(COMP)).toBe(false);
    expect(isDualRole(OPS)).toBe(false);
    expect(isDualRole(SUPERVISOR)).toBe(false);
    expect(isDualRole(NONE)).toBe(false);
  });

  it("zero recognized groups holds nothing (§b rule 3)", () => {
    for (const q of QUEUE_KEYS) {
      expect(canReadQueue(NONE, q)).toBe(false);
      expect(canWriteQueue(NONE, q)).toBe(false);
      expect(canCreateTicket(NONE, q)).toBe(false);
      expect(canComment(NONE, q, "INTERNAL")).toBe(false);
      expect(canComment(NONE, q, "PUBLIC")).toBe(false);
    }
    expect(readableQueues(NONE)).toEqual([]);
    expect(writableQueues(NONE)).toEqual([]);
    expect(creatableQueues(NONE)).toEqual([]);
    expect(canViewAudit(NONE)).toBe(false);
    expect(canMoveTicket(NONE, "OPERATIONS", "ADVICE")).toBe(false);
  });

  it("readable / writable queue lists per single group are in QUEUE_KEYS order", () => {
    expect(readableQueues(CS)).toEqual(["OPERATIONS", "CLIENT_SERVICE"]);
    expect(writableQueues(CS)).toEqual(["CLIENT_SERVICE"]);
    expect(readableQueues(COMP)).toEqual([...QUEUE_KEYS]);
    expect(writableQueues(COMP)).toEqual([]);
    expect(writableQueues(ADV)).toEqual(["ADVICE"]);
    expect(writableQueues(OPS)).toEqual(["OPERATIONS"]);
  });
});

describe("parseGroups / isGroup / hasAny (I12)", () => {
  it("keeps only the four known values, deduped, in OKTA_GROUPS order", () => {
    expect(parseGroups(["advisors", "Everyone", "ops_team", "advisors", "admins"])).toEqual(["ops_team", "advisors"]);
    expect(parseGroups(["compliance_officers", "client_services", "ops_team", "advisors"])).toEqual([...OKTA_GROUPS]);
  });

  it("accepts a single string claim", () => {
    expect(parseGroups("client_services")).toEqual(["client_services"]);
    expect(parseGroups("Everyone")).toEqual([]);
  });

  it("returns [] for undefined, null, numbers, objects and non-string array members", () => {
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups(null)).toEqual([]);
    expect(parseGroups(42)).toEqual([]);
    expect(parseGroups({ groups: ["ops_team"] })).toEqual([]);
    expect(parseGroups([1, null, { name: "ops_team" }, "OPS_TEAM", " ops_team"])).toEqual([]);
  });

  it("isGroup is a strict, case-sensitive membership test", () => {
    for (const g of OKTA_GROUPS) expect(isGroup(g)).toBe(true);
    expect(isGroup("OPS_TEAM")).toBe(false);
    expect(isGroup("")).toBe(false);
    expect(isGroup(undefined)).toBe(false);
    expect(isGroup(["ops_team"])).toBe(false);
  });

  it("hasAny is true when any wanted group is present", () => {
    expect(hasAny(SUPERVISOR, OPERATIONAL_GROUPS)).toBe(true);
    expect(hasAny(COMP, OPERATIONAL_GROUPS)).toBe(false);
    expect(hasAny(NONE, OPERATIONAL_GROUPS)).toBe(false);
    expect(hasAny(OPS, [])).toBe(false);
  });
});

describe("isPathAllowed rule table (§b rule 7)", () => {
  const cases: Array<[path: string, expected: Record<"ops" | "adv" | "cs" | "comp" | "sup", boolean>]> = [
    ["/compliance/audit", { ops: false, adv: false, cs: false, comp: true, sup: false }],
    ["/compliance", { ops: false, adv: false, cs: false, comp: true, sup: false }],
    ["/api/compliance/audit/export", { ops: false, adv: false, cs: false, comp: true, sup: false }],
    ["/queues/operations", { ops: true, adv: true, cs: true, comp: true, sup: true }],
    ["/queues/client-service", { ops: true, adv: true, cs: true, comp: true, sup: true }],
    ["/queues/advice", { ops: true, adv: true, cs: false, comp: true, sup: true }],
    ["/queues/advice?status=NEW", { ops: true, adv: true, cs: false, comp: true, sup: true }],
    ["/queues/not-a-queue", { ops: true, adv: true, cs: true, comp: true, sup: true }], // unknown slug → page 404s
    ["/tickets/new", { ops: true, adv: true, cs: true, comp: false, sup: true }],
    ["/tickets/new/", { ops: true, adv: true, cs: true, comp: false, sup: true }],
    ["/tickets/clx123", { ops: true, adv: true, cs: true, comp: true, sup: true }],
    ["/dashboard", { ops: true, adv: true, cs: true, comp: true, sup: true }],
    ["/api/queues/summary", { ops: true, adv: true, cs: true, comp: true, sup: true }],
  ];
  const personas = { ops: OPS, adv: ADV, cs: CS, comp: COMP, sup: SUPERVISOR };

  for (const [path, expected] of cases) {
    it(path, () => {
      for (const key of Object.keys(personas) as (keyof typeof personas)[]) {
        expect(isPathAllowed(path, personas[key]), `${key} ${path}`).toBe(expected[key]);
      }
      expect(isPathAllowed(path, NONE), `zero groups ${path}`).toBe(false);
    });
  }

  it("zero groups fails every path, including the root and unknown paths", () => {
    for (const p of ["/", "/dashboard", "/anything", "/queues/whatever", "/api/x"]) {
      expect(isPathAllowed(p, NONE)).toBe(false);
    }
  });

  it("/compliance prefix wins over the generic rule; /tickets/new prefix only matches the new-ticket page", () => {
    expect(isPathAllowed("/compliance-ish", COMP)).toBe(true);
    expect(isPathAllowed("/compliance-ish", OPS)).toBe(false); // startsWith match — coarse gate, server re-checks
    expect(isPathAllowed("/tickets/newest", COMP)).toBe(true); // not the new-ticket page
    expect(isPathAllowed("/tickets/new", COMP)).toBe(false);
  });
});

describe("slugs", () => {
  it("queueSlug / queueKeyFromSlug round-trip and unknown slugs are null", () => {
    for (const q of QUEUE_KEYS) expect(queueKeyFromSlug(queueSlug(q))).toBe(q);
    expect(queueSlug("CLIENT_SERVICE")).toBe("client-service");
    expect(queueKeyFromSlug("OPERATIONS")).toBeNull();
    expect(queueKeyFromSlug("")).toBeNull();
    expect(queueKeyFromSlug("client_service")).toBeNull();
  });
});

describe("assertCan", () => {
  it("passes silently when ok", () => {
    expect(() => assertCan(true, "ticket:create")).not.toThrow();
  });

  it("throws ForbiddenError with `Forbidden: <what>` and the ticket id (null when omitted)", () => {
    let caught: unknown;
    try {
      assertCan(false, "ticket:read PREVIEW", "tkt_1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenError);
    const fe = caught as ForbiddenError;
    expect(fe.message).toBe("Forbidden: ticket:read PREVIEW");
    expect(fe.ticketId).toBe("tkt_1");
    expect(fe.code).toBe("FORBIDDEN");
    expect(fe.status).toBe(403);

    let noId: unknown;
    try {
      assertCan(false, "audit:view");
    } catch (e) {
      noId = e;
    }
    expect((noId as ForbiddenError).ticketId).toBeNull();
  });
});

describe("safeRelativePath", () => {
  it("returns well-formed same-origin relative paths verbatim", () => {
    expect(safeRelativePath("/dashboard", "/fallback")).toBe("/dashboard");
    expect(safeRelativePath("/queues/advice?status=NEW&status=OPEN", "/fallback")).toBe(
      "/queues/advice?status=NEW&status=OPEN",
    );
    expect(safeRelativePath("/", "/fallback")).toBe("/");
    expect(safeRelativePath("/tickets/clx1#top", "/fallback")).toBe("/tickets/clx1#top");
  });

  it("falls back for anything that is not a plain relative path", () => {
    const fb = "invalid";
    expect(safeRelativePath("//evil.example", fb)).toBe(fb);
    expect(safeRelativePath("https://evil.example/x", fb)).toBe(fb);
    expect(safeRelativePath("dashboard", fb)).toBe(fb);
    expect(safeRelativePath("", fb)).toBe(fb);
    expect(safeRelativePath("/a b", fb)).toBe(fb);
    expect(safeRelativePath("/a\tb", fb)).toBe(fb);
    expect(safeRelativePath("/a\nb", fb)).toBe(fb);
    expect(safeRelativePath("/a\\b", fb)).toBe(fb);
    expect(safeRelativePath("/a b", fb)).toBe(fb);
    expect(safeRelativePath("/" + "x".repeat(512), fb)).toBe(fb); // 513 chars
    expect(safeRelativePath("/" + "x".repeat(511), fb)).toBe("/" + "x".repeat(511)); // 512 chars
    expect(safeRelativePath(undefined, fb)).toBe(fb);
    expect(safeRelativePath(null, fb)).toBe(fb);
    expect(safeRelativePath(["/dashboard"], fb)).toBe(fb);
    expect(safeRelativePath(42, fb)).toBe(fb);
  });
});

// ---------------------------------------------------------------------------
// Wave A capabilities (#68)
// ---------------------------------------------------------------------------

describe("Wave A capabilities", () => {
  it("attachment write is queue WRITE, attachment read is queue READ — so compliance downloads but never uploads", () => {
    for (const q of QUEUE_KEYS) {
      for (const groups of [OPS, ADV, CS, COMP, SUPERVISOR]) {
        expect(canWriteAttachment(groups, q), `write ${groups.join("+")} ${q}`).toBe(canWriteQueue(groups, q));
        expect(canReadAttachment(groups, q), `read ${groups.join("+")} ${q}`).toBe(canReadQueue(groups, q));
      }
      // The rule that matters to an examiner: read-plus-annotate can inspect the file, not add one.
      expect(canWriteAttachment(COMP, q)).toBe(false);
      expect(canReadAttachment(COMP, q)).toBe(true);
    }
  });

  it("macro admin is ops_team OR compliance_officers — the CCO owns client-facing wording (Decision #68)", () => {
    expect(canAdminMacros(OPS)).toBe(true);
    expect(canAdminMacros(COMP)).toBe(true);
    expect(canAdminMacros(ADV)).toBe(false);
    expect(canAdminMacros(CS)).toBe(false);
    expect(canAdminMacros([])).toBe(false);
    expect(canAdminMacros(SUPERVISOR)).toBe(true); // holds ops_team
  });

  it("user admin is ops_team ONLY: compliance never deactivates a colleague", () => {
    expect(canAdminUsers(OPS)).toBe(true);
    expect(canAdminUsers(COMP)).toBe(false);
    expect(canAdminUsers(ADV)).toBe(false);
    expect(canAdminUsers(CS)).toBe(false);
    expect(canAdminUsers([])).toBe(false);
  });

  it("ticket export follows queue read: anyone with a readable queue, nobody without", () => {
    for (const groups of [OPS, ADV, CS, COMP, SUPERVISOR]) {
      expect(canExportTickets(groups), groups.join("+")).toBe(true);
    }
    expect(canExportTickets([])).toBe(false);
  });

  it("held-mail review is ops OR compliance; RELEASE additionally needs WRITE on the destination queue", () => {
    for (const groups of [OPS, COMP, SUPERVISOR]) {
      expect(canReviewHeldIntake(groups), groups.join("+")).toBe(true);
    }
    expect(canReviewHeldIntake(ADV)).toBe(false);
    expect(canReviewHeldIntake(CS)).toBe(false);
    expect(canReviewHeldIntake([])).toBe(false);

    // Compliance sees every held message and releases none of it: read-plus-annotate is intact.
    for (const q of QUEUE_KEYS) {
      expect(canReleaseHeldIntake(COMP, q), `comp ${q}`).toBe(false);
      expect(canReleaseHeldIntake(ADV, q), `adv ${q}`).toBe(false);
      expect(canReleaseHeldIntake(OPS, q), `ops ${q}`).toBe(canWriteQueue(OPS, q));
    }
    // ops_team holds only READ on CLIENT_SERVICE, so it may review that queue's held mail and not release it.
    expect(canReleaseHeldIntake(OPS, "OPERATIONS")).toBe(true);
    expect(canReleaseHeldIntake(OPS, "CLIENT_SERVICE")).toBe(false);
  });

  it("changing a requester address is queue WRITE — the privilege is the two-step action, not a group bar", () => {
    for (const groups of [OPS, ADV, CS, COMP, SUPERVISOR, [] as OktaGroup[]]) {
      for (const q of QUEUE_KEYS) {
        expect(canChangeRequesterEmail(groups, q), `${groups.join("+") || "none"} ${q}`).toBe(canWriteQueue(groups, q));
      }
    }
    // The case that rules out a group-based bar: ops_team cannot write CLIENT_SERVICE, so a bar keyed
    // on ops_team would lock the CS desk out of redirecting its own tickets.
    expect(canChangeRequesterEmail(CS, "CLIENT_SERVICE")).toBe(true);
    expect(canChangeRequesterEmail(OPS, "CLIENT_SERVICE")).toBe(false);
  });

  it("can() dispatches every Wave A capability, and the queue-scoped ones deny without a queue context", () => {
    expect(can(OPS, "attachment:write", { queueKey: "OPERATIONS" })).toBe(true);
    expect(can(OPS, "attachment:write")).toBe(false);
    expect(can(COMP, "attachment:read", { queueKey: "ADVICE" })).toBe(true);
    expect(can(COMP, "attachment:write", { queueKey: "ADVICE" })).toBe(false);
    expect(can(COMP, "macro:admin")).toBe(true);
    expect(can(COMP, "user:admin")).toBe(false);
    expect(can(OPS, "user:admin")).toBe(true);
    expect(can(OPS, "ticket:export")).toBe(true);
    expect(can([], "ticket:export")).toBe(false);
    expect(can(COMP, "intake:review")).toBe(true);
    expect(can(CS, "intake:review")).toBe(false);
    expect(can(COMP, "intake:release", { queueKey: "CLIENT_SERVICE" })).toBe(false);
    expect(can(CS, "intake:release", { queueKey: "CLIENT_SERVICE" })).toBe(false);
    expect(can(OPS, "intake:release", { queueKey: "OPERATIONS" })).toBe(true);
    expect(can(OPS, "intake:release")).toBe(false);
    expect(can(CS, "ticket:requester-email", { queueKey: "CLIENT_SERVICE" })).toBe(true);
    expect(can(CS, "ticket:requester-email")).toBe(false);
  });

  it("can() is total over CAPABILITIES: every capability is dispatched, none falls through", () => {
    // `can` is `never`-exhaustive at compile time; this is the runtime half — a capability that is
    // queue-scoped must deny without a context, and one that is not must answer without one.
    for (const capability of CAPABILITIES) {
      expect(() => can(OPS, capability), capability).not.toThrow();
      expect(() => can([], capability, { queueKey: "OPERATIONS" }), capability).not.toThrow();
      expect(can([], capability, { queueKey: "OPERATIONS", fromQueueKey: "OPERATIONS", toQueueKey: "ADVICE" }), capability).toBe(false);
    }
  });

  it("isPathAllowed gates /admin per page, and refuses an unknown /admin subpath rather than falling through", () => {
    expect(isPathAllowed("/admin/macros", OPS)).toBe(true);
    expect(isPathAllowed("/admin/macros", COMP)).toBe(true);
    expect(isPathAllowed("/admin/macros", ADV)).toBe(false);
    expect(isPathAllowed("/admin/users", OPS)).toBe(true);
    expect(isPathAllowed("/admin/users", COMP)).toBe(false);
    expect(isPathAllowed("/admin/users/abc", OPS)).toBe(true);
    // Held mail: both reviewer groups, and nobody else — including a group that holds no admin page
    // at all, which the `/admin/*` fallthrough would otherwise have admitted for the wrong reason.
    expect(isPathAllowed("/admin/intake", OPS)).toBe(true);
    expect(isPathAllowed("/admin/intake", COMP)).toBe(true);
    expect(isPathAllowed("/admin/intake", ADV)).toBe(false);
    expect(isPathAllowed("/admin/intake", CS)).toBe(false);
    expect(isPathAllowed("/admin/intake/abc", COMP)).toBe(true);
    // A page nobody has written yet must not be reachable just because the viewer has some group.
    expect(isPathAllowed("/admin/secrets", CS)).toBe(false);
    expect(isPathAllowed("/admin", ADV)).toBe(false);
    expect(isPathAllowed("/admin", COMP)).toBe(true);
    // Zero groups still fails everything.
    expect(isPathAllowed("/admin/macros", [])).toBe(false);
  });
});
