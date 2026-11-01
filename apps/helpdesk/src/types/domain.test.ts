/**
 * Runtime parity between the hand-written enum mirrors in src/types/domain.ts and the generated Prisma
 * enums (§g S2 tests), plus structural checks on the code-owned tables.
 * `@prisma/client` is a VALUE import here — allowed in *.test.ts (shared convention 1); `$Enums` is plain data,
 * no engine is started.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { $Enums } from "@prisma/client";
import {
  ALLOWED_STATUS_TRANSITIONS,
  ATTACHMENT_KINDS,
  ATTACHMENT_MIME_ALLOWLIST,
  ATTACHMENT_STATES,
  ATTACHMENT_VISIBILITIES,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AuditAction,
  AuditEntityType,
  BRAND_LABELS,
  CATEGORY_LABELS,
  CLIENT_CONTACT_CHANNELS,
  CLIENT_CONTACT_CHANNEL_LABELS,
  CLIENT_FORBIDDEN_KEYS,
  COMMENT_AUTHOR_KINDS,
  REQUESTER_AUTHORED_SOURCES,
  COMMENT_VISIBILITIES,
  ESCALATION_TARGETS,
  ESCALATION_TARGET_LABELS,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_DELIVERY_STATUS_LABELS,
  SLA_ALERT_KINDS,
  SLA_ALERT_PHASES,
  SOURCE_LABELS,
  SUSPENDED_INTAKE_REASONS,
  SUSPENDED_INTAKE_REASON_LABELS,
  SUSPENDED_INTAKE_STATUSES,
  TICKET_BRANDS,
  TICKET_SOURCES,
  DEFAULT_SLA_POLICIES,
  DISCLAIMER_KEYS,
  OKTA_GROUPS,
  OPEN_STATUSES,
  PII_KINDS,
  PII_REPLACEMENT_PATTERN,
  QUEUE_KEYS,
  QUEUE_LABELS,
  QUEUE_SLUGS,
  ROUTING_TABLE,
  LIVE_NOTIFICATION_KINDS,
  NOTIFICATION_KINDS,
  NOTIFICATION_KINDS_PENDING_WRITER,
  NOTIFICATION_KIND_LABELS,
  isLiveNotificationKind,
  SLA_WARNING_THRESHOLD_MS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TIMELINE_AUDIT_ACTIONS,
  VIEW_AUDIT_ACTIONS,
} from "@/types/domain";

function asSet(values: readonly string[]): Set<string> {
  return new Set(values);
}

function prismaValues(e: Record<string, string>): string[] {
  return Object.values(e);
}

describe("enum parity with $Enums (I15, runtime half)", () => {
  const cases: Array<[name: string, mirror: readonly string[], prisma: Record<string, string>]> = [
    ["OktaGroup", OKTA_GROUPS, $Enums.OktaGroup],
    ["QueueKey", QUEUE_KEYS, $Enums.QueueKey],
    ["TicketCategory", TICKET_CATEGORIES, $Enums.TicketCategory],
    ["TicketPriority", TICKET_PRIORITIES, $Enums.TicketPriority],
    ["TicketStatus", TICKET_STATUSES, $Enums.TicketStatus],
    ["CommentVisibility", COMMENT_VISIBILITIES, $Enums.CommentVisibility],
    ["DisclaimerKey", DISCLAIMER_KEYS, $Enums.DisclaimerKey],
    ["AuditAction", AUDIT_ACTIONS, $Enums.AuditAction],
    ["AuditEntityType", AUDIT_ENTITY_TYPES, $Enums.AuditEntityType],
    // --- Wave A ---
    ["CommentAuthorKind", COMMENT_AUTHOR_KINDS, $Enums.CommentAuthorKind],
    ["TicketBrand", TICKET_BRANDS, $Enums.TicketBrand],
    ["TicketSource", TICKET_SOURCES, $Enums.TicketSource],
    ["EscalationTarget", ESCALATION_TARGETS, $Enums.EscalationTarget],
    ["SuspendedIntakeReason", SUSPENDED_INTAKE_REASONS, $Enums.SuspendedIntakeReason],
    ["SuspendedIntakeStatus", SUSPENDED_INTAKE_STATUSES, $Enums.SuspendedIntakeStatus],
    ["MessageDeliveryStatus", MESSAGE_DELIVERY_STATUSES, $Enums.MessageDeliveryStatus],
    ["AttachmentKind", ATTACHMENT_KINDS, $Enums.AttachmentKind],
    ["AttachmentState", ATTACHMENT_STATES, $Enums.AttachmentState],
    ["AttachmentVisibility", ATTACHMENT_VISIBILITIES, $Enums.AttachmentVisibility],
    ["SlaAlertPhase", SLA_ALERT_PHASES, $Enums.SlaAlertPhase],
    ["SlaAlertKind", SLA_ALERT_KINDS, $Enums.SlaAlertKind],
    ["ClientContactChannel", CLIENT_CONTACT_CHANNELS, $Enums.ClientContactChannel],
  ];

  for (const [name, mirror, prisma] of cases) {
    it(`${name}: mirror equals Object.values($Enums.${name}) as a set, with no duplicates`, () => {
      expect(asSet(mirror)).toEqual(asSet(prismaValues(prisma)));
      expect(mirror.length).toBe(new Set(mirror).size);
      expect(mirror.length).toBe(prismaValues(prisma).length);
    });
  }

  it("the array mirrors keep Prisma's declaration order (priority sorts by enum order in SQL)", () => {
    expect([...TICKET_PRIORITIES]).toEqual(prismaValues($Enums.TicketPriority));
    expect([...TICKET_STATUSES]).toEqual(prismaValues($Enums.TicketStatus));
    expect([...OKTA_GROUPS]).toEqual(prismaValues($Enums.OktaGroup));
    expect([...QUEUE_KEYS]).toEqual(prismaValues($Enums.QueueKey));
    expect([...TICKET_CATEGORIES]).toEqual(prismaValues($Enums.TicketCategory));
    expect([...DISCLAIMER_KEYS]).toEqual(prismaValues($Enums.DisclaimerKey));
    expect([...COMMENT_VISIBILITIES]).toEqual(prismaValues($Enums.CommentVisibility));
  });

  it("the AuditAction / AuditEntityType objects are key === value and equal the Prisma objects", () => {
    for (const [k, v] of Object.entries(AuditAction)) expect(k).toBe(v);
    for (const [k, v] of Object.entries(AuditEntityType)) expect(k).toBe(v);
    expect({ ...AuditAction }).toEqual({ ...$Enums.AuditAction });
    expect({ ...AuditEntityType }).toEqual({ ...$Enums.AuditEntityType });
    expect(AUDIT_ACTIONS).toEqual(Object.values(AuditAction));
    expect(AUDIT_ENTITY_TYPES).toEqual(Object.values(AuditEntityType));
  });
});

describe("ROUTING_TABLE (§c)", () => {
  it("covers every category exactly once", () => {
    expect(Object.keys(ROUTING_TABLE).sort()).toEqual([...TICKET_CATEGORIES].sort());
  });

  it("references only valid queues, priorities and non-NONE disclaimers", () => {
    for (const category of TICKET_CATEGORIES) {
      const rule = ROUTING_TABLE[category];
      expect(QUEUE_KEYS).toContain(rule.queueKey);
      expect(TICKET_PRIORITIES).toContain(rule.priority);
      expect(DISCLAIMER_KEYS).toContain(rule.disclaimerKey);
      expect(rule.disclaimerKey).not.toBe("NONE");
    }
  });

  it("every queue receives at least one category", () => {
    const queues = new Set(TICKET_CATEGORIES.map((c) => ROUTING_TABLE[c].queueKey));
    expect(queues).toEqual(asSet(QUEUE_KEYS));
  });

  it("pins the two spec-literal decisions: wires URGENT, planning LOW", () => {
    expect(ROUTING_TABLE.WIRE_TRANSFER).toEqual({ queueKey: "OPERATIONS", priority: "URGENT", disclaimerKey: "WIRE_VERIFICATION" });
    expect(ROUTING_TABLE.PLANNING_UPDATE).toEqual({ queueKey: "ADVICE", priority: "LOW", disclaimerKey: "INVESTMENT_ADVICE" });
    expect(ROUTING_TABLE.TAX_LOSS_HARVESTING.disclaimerKey).toBe("NOT_TAX_OR_LEGAL_ADVICE");
  });
});

describe("ALLOWED_STATUS_TRANSITIONS (§b.6)", () => {
  it("covers every status exactly once", () => {
    expect(Object.keys(ALLOWED_STATUS_TRANSITIONS).sort()).toEqual([...TICKET_STATUSES].sort());
  });

  it("references only valid statuses, never itself, and has no duplicates", () => {
    for (const from of TICKET_STATUSES) {
      const targets = ALLOWED_STATUS_TRANSITIONS[from];
      for (const to of targets) {
        expect(TICKET_STATUSES).toContain(to);
        expect(to).not.toBe(from);
      }
      expect(targets.length).toBe(new Set(targets).size);
    }
  });

  it("CLOSED is terminal, NEW is never a target, CLOSED is reachable only from RESOLVED", () => {
    expect(ALLOWED_STATUS_TRANSITIONS.CLOSED).toEqual([]);
    for (const from of TICKET_STATUSES) {
      expect(ALLOWED_STATUS_TRANSITIONS[from]).not.toContain("NEW");
      if (from !== "RESOLVED") expect(ALLOWED_STATUS_TRANSITIONS[from]).not.toContain("CLOSED");
    }
    expect(ALLOWED_STATUS_TRANSITIONS.RESOLVED).toContain("CLOSED");
    expect(ALLOWED_STATUS_TRANSITIONS.RESOLVED).toContain("OPEN"); // reopen path
  });
});

describe("other code-owned tables", () => {
  it("OPEN_STATUSES ⊂ TICKET_STATUSES and excludes RESOLVED / CLOSED", () => {
    for (const s of OPEN_STATUSES) expect(TICKET_STATUSES).toContain(s);
    expect(OPEN_STATUSES).not.toContain("RESOLVED");
    expect(OPEN_STATUSES).not.toContain("CLOSED");
    expect([...OPEN_STATUSES]).toEqual(["NEW", "OPEN", "PENDING_CLIENT", "PENDING_INTERNAL"]);
  });

  it("QUEUE_SLUGS and QUEUE_LABELS cover every queue with unique values", () => {
    expect(Object.keys(QUEUE_SLUGS).sort()).toEqual([...QUEUE_KEYS].sort());
    expect(Object.keys(QUEUE_LABELS).sort()).toEqual([...QUEUE_KEYS].sort());
    expect(new Set(Object.values(QUEUE_SLUGS)).size).toBe(QUEUE_KEYS.length);
    expect(QUEUE_SLUGS).toEqual({ OPERATIONS: "operations", CLIENT_SERVICE: "client-service", ADVICE: "advice" });
  });

  it("CATEGORY_LABELS covers every category", () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...TICKET_CATEGORIES].sort());
    for (const c of TICKET_CATEGORIES) expect(CATEGORY_LABELS[c].length).toBeGreaterThan(0);
  });

  it("DEFAULT_SLA_POLICIES has the §d numbers and a first-response clock shorter than resolution", () => {
    expect(Object.keys(DEFAULT_SLA_POLICIES).sort()).toEqual([...TICKET_PRIORITIES].sort());
    expect(DEFAULT_SLA_POLICIES.URGENT).toMatchObject({ firstResponseMinutes: 30, resolutionMinutes: 120 });
    expect(DEFAULT_SLA_POLICIES.HIGH).toMatchObject({ firstResponseMinutes: 60, resolutionMinutes: 480 });
    expect(DEFAULT_SLA_POLICIES.STANDARD).toMatchObject({ firstResponseMinutes: 240, resolutionMinutes: 1440 });
    expect(DEFAULT_SLA_POLICIES.LOW).toMatchObject({ firstResponseMinutes: 480, resolutionMinutes: 4320 });
    for (const p of TICKET_PRIORITIES) {
      const policy = DEFAULT_SLA_POLICIES[p];
      expect(Number.isInteger(policy.firstResponseMinutes) && policy.firstResponseMinutes > 0).toBe(true);
      expect(Number.isInteger(policy.resolutionMinutes) && policy.resolutionMinutes > 0).toBe(true);
      expect(policy.firstResponseMinutes).toBeLessThan(policy.resolutionMinutes);
      expect(policy.name.length).toBeGreaterThan(0);
    }
    expect(SLA_WARNING_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });

  it("VIEW_AUDIT_ACTIONS and TIMELINE_AUDIT_ACTIONS are disjoint subsets of AUDIT_ACTIONS", () => {
    for (const a of VIEW_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(a);
    for (const a of TIMELINE_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(a);
    for (const a of VIEW_AUDIT_ACTIONS) expect(TIMELINE_AUDIT_ACTIONS).not.toContain(a);
    expect([...VIEW_AUDIT_ACTIONS]).toEqual([
      "TICKET_VIEWED",
      "TICKET_PREVIEWED",
      "CLIENT_API_READ",
      // reads of client material that are audited but are not ticket-content views.
      "ATTACHMENT_VIEWED",
      "TICKET_EXPORT_READ",
    ]);
    // Timeline never shows comment bodies or audit-log meta actions.
    for (const a of [
      "COMMENT_ADDED_INTERNAL",
      "COMMENT_ADDED_PUBLIC",
      "AUDIT_LOG_VIEWED",
      "AUTHZ_DENIED",
      // a requester message is a COMMENT and renders as one, never as a system event; and
      // delivery state renders as a chip on the comment, so MESSAGE_* stays off the timeline.
      "COMMENT_ADDED_REQUESTER",
      "MESSAGE_QUEUED",
      "MESSAGE_LEASED",
      "MESSAGE_SENT",
      "MESSAGE_FAILED",
      "AUTHZ_DENIED_COALESCED",
    ] as const) {
      expect(TIMELINE_AUDIT_ACTIONS).not.toContain(a);
    }
  });

  it("PII_REPLACEMENT_PATTERN matches every token shape and PII_KINDS is complete", () => {
    // The list has been four, then seven, and is now THREE: Decision #116
    // withdrew ROUTING, DOB, PASSPORT and DL. SSN, CARD and ACCOUNT keep their positions, their
    // meaning and their token shapes.
    expect([...PII_KINDS]).toEqual(["SSN", "CARD", "ACCOUNT"]);
    const sample = "a [REDACTED:SSN] b [REDACTED:CARD ****1111] c [REDACTED:ACCOUNT ****6789] d";
    // security scanner CWE-185 fires on a pattern that reaches a matcher as a
    // VARIABLE, not only on `new RegExp(x)` — `sample.match(PII_REPLACEMENT_PATTERN)` was two
    // findings on this test (PR #1 threads at lines 248 and 250). So the `match` calls below take
    // the pattern as a literal, and the parity assertion here is what keeps the literal honest:
    // source and flags, byte for byte, against the constant `src/types/domain.ts` actually writes.
    // Change one without the other and this test fails, which is the only thing the imported
    // constant was buying here.
    expect(PII_REPLACEMENT_PATTERN.source).toBe(/\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g.source);
    expect(PII_REPLACEMENT_PATTERN.flags).toBe(/\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g.flags);
    expect(PII_REPLACEMENT_PATTERN.flags).toContain("g");
    // Every kind in the list has a token shape the pattern accepts, and the alternation names no
    // kind the list does not — the parity that makes the literal above a pin rather than a copy.
    for (const kind of PII_KINDS) {
      expect(`x [REDACTED:${kind}] y`.match(/\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g), kind).toEqual([
        `[REDACTED:${kind}]`,
      ]);
    }
    const matches = sample.match(/\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g);
    expect(matches).toEqual(["[REDACTED:SSN]", "[REDACTED:CARD ****1111]", "[REDACTED:ACCOUNT ****6789]"]);
    // A kind that is no longer written is no longer matched. These four tokens still exist in rows
    // written before Decision #116 — redaction is irreversible and nothing is backfilled — so this
    // is a statement about what the UI highlights, not about what is stored.
    for (const withdrawn of ["ROUTING", "DOB", "PASSPORT", "DL"]) {
      expect(
        `x [REDACTED:${withdrawn}] y`.match(/\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g),
        withdrawn,
      ).toBeNull();
      expect([...PII_KINDS], withdrawn).not.toContain(withdrawn);
    }
    expect("[REDACTED:EMAIL]".match(/\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g)).toBeNull();
    // The exported constant is module-level and global, so a stray `lastIndex` would leak across
    // every consumer; nothing here advances it, and this pins that it arrives at zero.
    expect(PII_REPLACEMENT_PATTERN.lastIndex).toBe(0);
  });

  it("CLIENT_FORBIDDEN_KEYS names the keys that would carry an internal note or a staff identity", () => {
    for (const k of ["visibility", "author", "authorId", "assignee", "assigneeId", "internal", "description", "requesterEmail"]) {
      expect(CLIENT_FORBIDDEN_KEYS).toContain(k);
    }
    expect(new Set(CLIENT_FORBIDDEN_KEYS).size).toBe(CLIENT_FORBIDDEN_KEYS.length);
  });
});

// ---------------------------------------------------------------------------
// Wave A code-owned tables
// ---------------------------------------------------------------------------

/**
 * REQUESTER_AUTHORED_SOURCES — the gate on the client-facing opening entry.
 *
 * `src/server/client-view.ts` renders `Ticket.description` back to the client as the first entry of
 * the thread, and this list is the only thing standing between "the client sees the message they
 * sent" and "the client sees an operator's private account of their call". It is therefore pinned
 * from BOTH sides: every member must be a real `TicketSource`, and every `TicketSource` must be on
 * exactly one of the two lists below — so a tenth source added later fails here until somebody
 * classifies it, rather than defaulting into (or silently out of) a client's view.
 */
describe("REQUESTER_AUTHORED_SOURCES (Decision #117)", () => {
  /**
   * The complement, written out rather than derived, which is the whole point: this list is a claim a
   * human made about each channel, and a new source has to be added here on purpose.
   *
   * - STAFF_FORM / PHONE — an associate typed it at the desk (`logCall`, `src/lib/log-call.ts`).
   * - VOICEMAIL — the judgement call. Two paths write it: the staff "Log a call → Voicemail" form (an
   *   operator's note) and the phone system ingest workflow, whose description is a transcript PLUS the
   *   line name, the duration and a link to the recording, with desk instructions prepended when the
   *   caller's number was withheld
   *   (`integrations/n8n/code/phone-system-voicemail-intake/build-voicemail-ticket.js`). Excluded.
   * - SLACK — the modal is filled in by the STAFF member who raised it, not by the client.
   * - SYSTEM / API / IMPORT — the desk talking to itself, or an archived agent's words.
   */
  const OPERATOR_AUTHORED_SOURCES = ["STAFF_FORM", "PHONE", "VOICEMAIL", "SLACK", "SYSTEM", "IMPORT", "API"];

  it("every member is a real TicketSource, with no duplicates", () => {
    for (const s of REQUESTER_AUTHORED_SOURCES) expect(TICKET_SOURCES, s).toContain(s);
    expect(new Set(REQUESTER_AUTHORED_SOURCES).size).toBe(REQUESTER_AUTHORED_SOURCES.length);
  });

  it("is exactly EMAIL and CLIENT_APP — the two channels the client types into themselves", () => {
    expect([...REQUESTER_AUTHORED_SOURCES].sort()).toEqual(["CLIENT_APP", "EMAIL"]);
  });

  it("partitions TicketSource: a source added later is on neither list and fails here", () => {
    const allowed = [...REQUESTER_AUTHORED_SOURCES];
    expect([...allowed, ...OPERATOR_AUTHORED_SOURCES].sort()).toEqual([...TICKET_SOURCES].sort());
    for (const s of OPERATOR_AUTHORED_SOURCES) {
      expect(allowed, `${s} must not be treated as the requester's own words`).not.toContain(s);
    }
    expect(new Set([...allowed, ...OPERATOR_AUTHORED_SOURCES]).size).toBe(TICKET_SOURCES.length);
  });

  it("excludes VOICEMAIL, and excludes every staff-entered channel", () => {
    // Stated on its own because it is the one call a reviewer will want to find quickly.
    expect(REQUESTER_AUTHORED_SOURCES as readonly string[]).not.toContain("VOICEMAIL");
    for (const s of ["STAFF_FORM", "PHONE", "SLACK"]) {
      expect(REQUESTER_AUTHORED_SOURCES as readonly string[]).not.toContain(s);
    }
  });

  it("`description` and `source` stay in CLIENT_FORBIDDEN_KEYS — the gate is not a licence to add DTO keys", () => {
    expect(CLIENT_FORBIDDEN_KEYS).toContain("description");
    expect(CLIENT_FORBIDDEN_KEYS).toContain("source");
  });
});

describe("Wave A tables", () => {
  it("every Wave A enum has a complete label map — no UI ever renders a raw enum value", () => {
    const maps: Array<[name: string, values: readonly string[], labels: Readonly<Record<string, string>>]> = [
      ["TicketBrand", TICKET_BRANDS, BRAND_LABELS],
      ["TicketSource", TICKET_SOURCES, SOURCE_LABELS],
      ["EscalationTarget", ESCALATION_TARGETS, ESCALATION_TARGET_LABELS],
      ["ClientContactChannel", CLIENT_CONTACT_CHANNELS, CLIENT_CONTACT_CHANNEL_LABELS],
      ["MessageDeliveryStatus", MESSAGE_DELIVERY_STATUSES, MESSAGE_DELIVERY_STATUS_LABELS],
      ["SuspendedIntakeReason", SUSPENDED_INTAKE_REASONS, SUSPENDED_INTAKE_REASON_LABELS],
    ];
    for (const [name, values, labels] of maps) {
      expect(Object.keys(labels).sort(), `${name} label keys`).toEqual([...values].sort());
      for (const v of values) expect(labels[v]?.length, `${name}.${v}`).toBeGreaterThan(0);
    }
  });

  it("ROUTING_TABLE and CATEGORY_LABELS cover all 22 categories, including the eleven Wave A additions", () => {
    expect(TICKET_CATEGORIES).toHaveLength(22);
    for (const c of TICKET_CATEGORIES) {
      expect(ROUTING_TABLE[c], `${c} has no routing rule`).toBeDefined();
      expect(CATEGORY_LABELS[c]?.length, `${c} has no label`).toBeGreaterThan(0);
    }
    // The categories Cedar Ridge's real intake needed (gap analysis §3 "Category taxonomy").
    for (const c of [
      "ACCOUNT_CLOSURE",
      "BENEFICIARY_TOD",
      "RETURNED_CHECK",
      "RETURNED_MAIL",
      "PASSKEY_LOGIN",
      "IDENTITY_VERIFICATION",
      "COMPLAINT",
      "RETIREMENT_DISTRIBUTION",
      "COST_BASIS",
      "VOICEMAIL_CALLBACK",
      "STATEMENT_REQUEST",
    ] as const) {
      expect(TICKET_CATEGORIES).toContain(c);
    }
  });

  it("the Wave A additions never route a client-facing default into the wrong disclaimer family", () => {
    // Anything that touches money movement carries the wire-verification wording; anything that is a
    // tax or estate question carries the not-advice wording. This is the check an examiner would make.
    expect(ROUTING_TABLE.RETURNED_CHECK.disclaimerKey).toBe("WIRE_VERIFICATION");
    for (const c of ["BENEFICIARY_TOD", "RETIREMENT_DISTRIBUTION", "COST_BASIS"] as const) {
      expect(ROUTING_TABLE[c].disclaimerKey).toBe("NOT_TAX_OR_LEGAL_ADVICE");
    }
    // A complaint is urgent and lands where a human reads it first.
    expect(ROUTING_TABLE.COMPLAINT.priority).toBe("URGENT");
    expect(ROUTING_TABLE.COMPLAINT.queueKey).toBe("CLIENT_SERVICE");
    // No Wave A category may default to a NONE disclaimer: a PUBLIC reply must always carry one.
    for (const c of TICKET_CATEGORIES) expect(ROUTING_TABLE[c].disclaimerKey).not.toBe("NONE");
  });

  it("CLIENT_FORBIDDEN_KEYS covers ALL ELEVEN Wave A Ticket columns CONTRACT §1.4 names", () => {
    // The column-scoped GRANT in prisma/sql/runtime-roles.sql and guardrail G15 keep these out of the
    // client ROLE's reach at the database. `assertNoInternalLeak` is the independent runtime guarantee
    // (client-view.ts guarantee 5) and is the only one that would fire if someone widened
    // `toClientTicketView`'s field-by-field construction or added a field to `ClientTicketView` —
    // `getClientTicketView` reads through `publicDb` with an explicit select and `ClientTicketSource`
    // is a hand-written type, so the grant does not help there. The two lists must not drift.
    const waveATicketColumns = [
      "requesterPhone",
      "householdId",
      "requesterExternalId",
      "isComplaint",
      "complaintFiledAt",
      "escalationTarget",
      "externalRef",
      "externalId",
      "linkedFromTicketId",
      "brand",
      "source",
    ] as const;
    expect(waveATicketColumns).toHaveLength(11);
    for (const key of waveATicketColumns) {
      expect(CLIENT_FORBIDDEN_KEYS, `${key} must be forbidden on a client payload`).toContain(key);
    }
    expect(CLIENT_FORBIDDEN_KEYS.length).toBe(new Set(CLIENT_FORBIDDEN_KEYS).size);
  });

  it("CLIENT_FORBIDDEN_KEYS covers the other Wave A fields that could carry internal state (I1)", () => {
    for (const key of ["followUpAt", "attachments", "delivery", "authorKind", "objectKey", "headers", "rawRef"]) {
      expect(CLIENT_FORBIDDEN_KEYS, `${key} must be forbidden on a client payload`).toContain(key);
    }
  });

  it("CLIENT_FORBIDDEN_KEYS names the LEAF keys too, not only the container keys", () => {
    // `attachments`, `delivery`, `headers` and `rawRef` are containers. A flattened or partially-spread
    // shape would carry the leaves without ever naming the container, so the walker must know the
    // leaves of MessageDelivery (outbound mail) and SuspendedIntake (quarantined inbound mail) — both
    // REVOKEd from the client role, both with no client-facing DTO by design.
    for (const key of [
      "fromAddress",
      "replyTo",
      "toAddress",
      "textBody",
      "htmlBody",
      "providerMessageId",
      "lastError",
      "mailbox",
      "snippet",
    ]) {
      expect(CLIENT_FORBIDDEN_KEYS, `${key} must be forbidden on a client payload`).toContain(key);
    }
  });

  it("no forbidden key collides with a field the client DTOs legitimately carry", () => {
    // The walker is a blunt instrument: a forbidden key that a ClientTicketView / ClientSafeComment
    // field is also called would make every client read throw. These are the two DTO shapes.
    const clientDtoFields = [
      "reference",
      "subject",
      "status",
      "priority",
      "category",
      "createdAt",
      "updatedAt",
      "resolvedAt",
      "messages",
      "id",
      "body",
      "disclaimerKey",
      "authorDisplay",
    ];
    for (const field of clientDtoFields) {
      expect(CLIENT_FORBIDDEN_KEYS, `${field} is a client DTO field and must NOT be forbidden`).not.toContain(field);
    }
  });

  it("the attachment MIME allowlist is the documented set and admits nothing executable", () => {
    expect([...ATTACHMENT_MIME_ALLOWLIST].sort()).toEqual(
      [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/heic",
        "image/heif",
        "image/jpeg",
        "image/png",
        "text/csv",
        "text/plain",
      ].sort(),
    );
    for (const mime of ATTACHMENT_MIME_ALLOWLIST) {
      expect(mime).not.toMatch(/javascript|html|x-msdownload|x-sh|octet-stream|zip/);
    }
  });

  it("attachments are INTERNAL-only in v1 — the visibility enum has exactly one value", () => {
    expect([...ATTACHMENT_VISIBILITIES]).toEqual(["INTERNAL"]);
  });
});

// ---------------------------------------------------------------------------
// NotificationKind ↔ writer pairing
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Every non-test `.ts`/`.tsx` under src/, except this file's own subject, as {rel, code} pairs. */
function productionSources(): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  function walk(dir: string): void {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry.name) || /\.integration\.test\.tsx?$/.test(entry.name)) continue;
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
      // The declaration site itself names every kind; it is the subject, not a writer.
      if (rel === "src/types/domain.ts") continue;
      try {
        out.push({ rel, code: readFileSync(abs, "utf8") });
      } catch {
        /* a file another slice is mid-write; skip it rather than fail on it */
      }
    }
  }
  walk(path.join(REPO_ROOT, "src"));
  return out;
}

/**
 * Does `code` write `kind: "<kind>"`?
 *
 * This was `new RegExp(`kind:\s*"<kind>"`).test(code)` — a pattern assembled from a loop
 * variable, which is exactly the CWE-185 shape security scanner reported twice on
 * this file in PR #2, and the same rule Wave A cleared from the PII assertions above. There is no
 * literal to fall back to when the needle is a different string on every iteration, so per
 * the build record ("in tests, prefer `includes` / `startsWith` / `split` over a
 * constructed regex") the match is a scan: find each `kind:`, skip the whitespace run after it, and
 * compare the quoted literal that follows. Same acceptance as the regex, no constructor.
 */
function writesKind(code: string, kind: string): boolean {
  const KEY = "kind:";
  const needle = `"${kind}"`;
  for (let at = code.indexOf(KEY); at !== -1; at = code.indexOf(KEY, at + KEY.length)) {
    let i = at + KEY.length;
    while (i < code.length && /\s/.test(code[i]!)) i += 1;
    if (code.startsWith(needle, i)) return true;
  }
  return false;
}

/**
 * Files that DRAW one control per kind and must therefore enumerate the live subset. A filter or a
 * switch for a kind nothing writes is a promise the system cannot keep (the round-2 finding this
 * table answers). Validating a kind arriving in a URL against the full enum is a different job and is
 * deliberately not covered here.
 */
const PER_KIND_UI_FILES = [
  "src/components/inbox/notification-prefs-sheet.tsx",
  "src/components/inbox/inbox-view.tsx",
];

describe("NotificationKind is paired with a writer, or declared deferred (round-2 finding)", () => {
  const sources = productionSources();

  it("the deferred list is a subset of the enum and partitions it with the live list", () => {
    for (const kind of NOTIFICATION_KINDS_PENDING_WRITER) {
      expect(NOTIFICATION_KINDS, `${kind} is not a NotificationKind`).toContain(kind);
    }
    expect(new Set(NOTIFICATION_KINDS_PENDING_WRITER).size).toBe(NOTIFICATION_KINDS_PENDING_WRITER.length);
    for (const kind of LIVE_NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KINDS_PENDING_WRITER as readonly string[]).not.toContain(kind);
    }
    expect([...LIVE_NOTIFICATION_KINDS, ...NOTIFICATION_KINDS_PENDING_WRITER].sort()).toEqual(
      [...NOTIFICATION_KINDS].sort(),
    );
    // Derived, so the live list keeps the enum's declaration order — the order the UI renders in.
    expect([...LIVE_NOTIFICATION_KINDS]).toEqual(
      NOTIFICATION_KINDS.filter((k) => !(NOTIFICATION_KINDS_PENDING_WRITER as readonly string[]).includes(k)),
    );
  });

  it("isLiveNotificationKind agrees with both lists, and every kind still has a label", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(isLiveNotificationKind(kind), kind).toBe(
        !(NOTIFICATION_KINDS_PENDING_WRITER as readonly string[]).includes(kind),
      );
      // A deferred kind keeps its label: stored rows (and a future writer) still have to render.
      expect(NOTIFICATION_KIND_LABELS[kind], `${kind} has no label`).toBeTruthy();
    }
  });

  it("every live kind has at least one writer in src/", () => {
    for (const kind of LIVE_NOTIFICATION_KINDS) {
      const writers = sources.filter(({ code }) => writesKind(code, kind)).map((f) => f.rel);
      expect(
        writers,
        `${kind} is offered to operators but nothing writes it. Give it a writer, or add it to NOTIFICATION_KINDS_PENDING_WRITER.`,
      ).not.toHaveLength(0);
    }
  });

  it("no deferred kind has a writer — landing one means removing it from the deferred list", () => {
    for (const kind of NOTIFICATION_KINDS_PENDING_WRITER) {
      const writers = sources.filter(({ code }) => writesKind(code, kind)).map((f) => f.rel);
      expect(
        writers,
        `${kind} now has a writer (${writers.join(", ")}). Remove it from NOTIFICATION_KINDS_PENDING_WRITER so the preferences sheet and the inbox filter offer it again.`,
      ).toHaveLength(0);
    }
  });

  it("the per-kind UI surfaces enumerate the live list, never the raw enum", () => {
    for (const rel of PER_KIND_UI_FILES) {
      const file = sources.find((f) => f.rel === rel);
      if (file === undefined) continue; // slice not landed; passes vacuously
      expect(
        /\bNOTIFICATION_KINDS\b/.test(file.code),
        `${rel} draws one control per kind, so it must map LIVE_NOTIFICATION_KINDS`,
      ).toBe(false);
      expect(file.code, `${rel} must enumerate LIVE_NOTIFICATION_KINDS`).toContain("LIVE_NOTIFICATION_KINDS");
    }
  });
});
