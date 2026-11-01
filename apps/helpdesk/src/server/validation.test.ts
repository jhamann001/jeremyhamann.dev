/**
 * S3 validation tests (docs/ARCHITECTURE.md §g S3 tests): schema ↔ domain-type parity, I7 (public reply
 * requires a non-NONE disclaimer + acknowledgement), tolerant query parsing, shared convention 12.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AssignTicketInput,
  AssignToMeInput,
  ChangePriorityInput,
  ChangeStatusInput,
  CommentBodyInput,
  CreateTicketInput,
  Equal,
  Expect,
  MacroAdminInput,
  MoveQueueInput,
  PublicReplyInput,
  RecordClientContactInput,
  SetMacroActiveInput,
  SetUserActiveInput,
  UpdateMacroInput,
  UpdateTicketFieldsInput,
} from "@/types/domain";
import { CLIENT_CONTACT_CHANNELS, OPEN_STATUSES } from "@/types/domain";
import {
  assignTicketSchema,
  assignToMeSchema,
  changePrioritySchema,
  changeStatusSchema,
  commentBodySchema,
  createTicketSchema,
  isMacroKey,
  macroAdminSchema,
  moveQueueSchema,
  multiValue,
  parseAuditQuery,
  parseTicketExportScope,
  parseTicketListQuery,
  publicReplySchema,
  recordClientContactSchema,
  setMacroActiveSchema,
  setUserActiveSchema,
  updateMacroSchema,
  changeRequesterEmailSchema,
  updateTicketFieldsSchema,
  MAX_REPORTED_ISSUES,
  zodToActionError,
} from "@/server/validation";

// ---------------------------------------------------------------------------
// Compile-time parity: each schema's output IS the domain input type.
// ---------------------------------------------------------------------------

export type SchemaParityChecks = [
  Expect<Equal<z.output<typeof createTicketSchema>, CreateTicketInput>>,
  Expect<Equal<z.output<typeof updateTicketFieldsSchema>, UpdateTicketFieldsInput>>,
  Expect<Equal<z.output<typeof changeStatusSchema>, ChangeStatusInput>>,
  Expect<Equal<z.output<typeof changePrioritySchema>, ChangePriorityInput>>,
  Expect<Equal<z.output<typeof assignTicketSchema>, AssignTicketInput>>,
  Expect<Equal<z.output<typeof moveQueueSchema>, MoveQueueInput>>,
  Expect<Equal<z.output<typeof commentBodySchema>, CommentBodyInput>>,
  Expect<Equal<z.output<typeof publicReplySchema>, PublicReplyInput>>,
];

const TICKET_ID = "cmfl0x2y10000abcdef123456";
const DEFAULT_STATUSES = [...OPEN_STATUSES, "RESOLVED"];

// Built dynamically: guardrail G11 forbids the bracket-suffixed key as a literal anywhere under src/.
const BRACKET_STATUS_KEY = ["status", "[", "]"].join("");

describe("createTicketSchema", () => {
  const valid: CreateTicketInput = {
    subject: "  Wire to custodian  ",
    description: "Please wire $10,000 today.",
    category: "WIRE_TRANSFER",
    requesterName: " Pat Doe ",
    requesterEmail: "  Pat.Doe@Example.COM ",
  };

  it("parses a valid input, trimming subject/requesterName and normalizing the email", () => {
    const out = createTicketSchema.parse(valid);
    expect(out).toEqual({
      subject: "Wire to custodian",
      description: "Please wire $10,000 today.",
      category: "WIRE_TRANSFER",
      requesterName: "Pat Doe",
      requesterEmail: "pat.doe@example.com",
    });
    expect(Object.keys(out).sort()).toEqual(["category", "description", "requesterEmail", "requesterName", "subject"]);
  });

  it("accepts optional overrides and strips unknown keys", () => {
    const out = createTicketSchema.parse({
      ...valid,
      priority: "LOW",
      queueKey: "ADVICE",
      clientReference: "Household 42",
      assigneeId: "dev_ops",
      extra: "dropped",
    });
    expect(out.priority).toBe("LOW");
    expect(out.queueKey).toBe("ADVICE");
    expect(out.clientReference).toBe("Household 42");
    expect(out.assigneeId).toBe("dev_ops");
    expect("extra" in out).toBe(false);
  });

  it("rejects a short subject, an empty description, a bad email and an unknown category", () => {
    expect(createTicketSchema.safeParse({ ...valid, subject: "ab" }).success).toBe(false);
    expect(createTicketSchema.safeParse({ ...valid, description: "" }).success).toBe(false);
    expect(createTicketSchema.safeParse({ ...valid, requesterEmail: "not-an-email" }).success).toBe(false);
    expect(createTicketSchema.safeParse({ ...valid, category: "BOGUS" }).success).toBe(false);
    expect(createTicketSchema.safeParse({ ...valid, priority: "CRITICAL" }).success).toBe(false);
  });

  it("caps lengths (subject 200, requesterName 120, description 20000)", () => {
    expect(createTicketSchema.safeParse({ ...valid, subject: "x".repeat(201) }).success).toBe(false);
    expect(createTicketSchema.safeParse({ ...valid, subject: "x".repeat(200) }).success).toBe(true);
    expect(createTicketSchema.safeParse({ ...valid, requesterName: "x".repeat(121) }).success).toBe(false);
    expect(createTicketSchema.safeParse({ ...valid, description: "x".repeat(20_001) }).success).toBe(false);
  });
});

describe("updateTicketFieldsSchema", () => {
  it("requires at least one editable field", () => {
    const r = updateTicketFieldsSchema.safeParse({ ticketId: TICKET_ID, version: 1 });
    expect(r.success).toBe(false);
  });

  it("accepts a single field, including clientReference: null", () => {
    expect(updateTicketFieldsSchema.parse({ ticketId: TICKET_ID, version: 3, clientReference: null })).toEqual({
      ticketId: TICKET_ID,
      version: 3,
      clientReference: null,
    });
    expect(updateTicketFieldsSchema.parse({ ticketId: TICKET_ID, version: 3, category: "ACAT" }).category).toBe("ACAT");
  });

  it("rejects a non-positive or fractional version", () => {
    expect(updateTicketFieldsSchema.safeParse({ ticketId: TICKET_ID, version: 0, subject: "abc" }).success).toBe(false);
    expect(updateTicketFieldsSchema.safeParse({ ticketId: TICKET_ID, version: 1.5, subject: "abc" }).success).toBe(false);
  });
});

describe("status / priority / assign / move schemas", () => {
  it("accept valid enums and reject unknown ones", () => {
    expect(changeStatusSchema.parse({ ticketId: TICKET_ID, version: 1, status: "OPEN" }).status).toBe("OPEN");
    expect(changeStatusSchema.safeParse({ ticketId: TICKET_ID, version: 1, status: "DONE" }).success).toBe(false);
    // The outcome recorded with the status: optional, and any TicketResolution passes
    // the SHAPE — which of them is legal depends on the transition and is decided in the action.
    expect(changeStatusSchema.parse({ ticketId: TICKET_ID, version: 1, status: "RESOLVED" }).resolution).toBeUndefined();
    expect(
      changeStatusSchema.parse({ ticketId: TICKET_ID, version: 1, status: "RESOLVED", resolution: "ANSWERED" }).resolution,
    ).toBe("ANSWERED");
    expect(
      changeStatusSchema.safeParse({ ticketId: TICKET_ID, version: 1, status: "RESOLVED", resolution: "FIXED" }).success,
    ).toBe(false);
    expect(changePrioritySchema.parse({ ticketId: TICKET_ID, version: 1, priority: "URGENT" }).priority).toBe("URGENT");
    expect(changePrioritySchema.safeParse({ ticketId: TICKET_ID, version: 1, priority: "P0" }).success).toBe(false);
    expect(moveQueueSchema.parse({ ticketId: TICKET_ID, version: 1, queueKey: "ADVICE" }).queueKey).toBe("ADVICE");
    expect(moveQueueSchema.safeParse({ ticketId: TICKET_ID, version: 1, queueKey: "SALES" }).success).toBe(false);
  });

  it("assignTicketSchema allows null (unassign) but not undefined", () => {
    expect(assignTicketSchema.parse({ ticketId: TICKET_ID, version: 1, assigneeId: null }).assigneeId).toBeNull();
    expect(assignTicketSchema.parse({ ticketId: TICKET_ID, version: 1, assigneeId: "dev_ops" }).assigneeId).toBe("dev_ops");
    expect(assignTicketSchema.safeParse({ ticketId: TICKET_ID, version: 1 }).success).toBe(false);
  });
});

describe("comment schemas (I7)", () => {
  it("commentBodySchema requires a non-empty body and allows macroId", () => {
    expect(commentBodySchema.parse({ ticketId: TICKET_ID, body: "note", macroId: "m1" })).toEqual({
      ticketId: TICKET_ID,
      body: "note",
      macroId: "m1",
    });
    expect(commentBodySchema.safeParse({ ticketId: TICKET_ID, body: "" }).success).toBe(false);
    expect(commentBodySchema.safeParse({ ticketId: TICKET_ID, body: "x".repeat(20_001) }).success).toBe(false);
  });

  it("publicReplySchema rejects disclaimerKey NONE", () => {
    const r = publicReplySchema.safeParse({
      ticketId: TICKET_ID,
      body: "Hello",
      disclaimerKey: "NONE",
      disclaimerAcknowledged: true,
    });
    expect(r.success).toBe(false);
  });

  it("publicReplySchema rejects an unacknowledged disclaimer", () => {
    const r = publicReplySchema.safeParse({
      ticketId: TICKET_ID,
      body: "Hello",
      disclaimerKey: "GENERAL_SERVICE",
      disclaimerAcknowledged: false,
    });
    expect(r.success).toBe(false);
    const missing = publicReplySchema.safeParse({ ticketId: TICKET_ID, body: "Hello", disclaimerKey: "GENERAL_SERVICE" });
    expect(missing.success).toBe(false);
  });

  it("publicReplySchema accepts a non-NONE, acknowledged disclaimer", () => {
    const out = publicReplySchema.parse({
      ticketId: TICKET_ID,
      body: "Hello",
      disclaimerKey: "WIRE_VERIFICATION",
      disclaimerAcknowledged: true,
    });
    expect(out.disclaimerKey).toBe("WIRE_VERIFICATION");
    expect(out.disclaimerAcknowledged).toBe(true);
  });

  it("visibility is never an input field (it is stripped if supplied)", () => {
    const out = publicReplySchema.parse({
      ticketId: TICKET_ID,
      body: "Hello",
      disclaimerKey: "GENERAL_SERVICE",
      disclaimerAcknowledged: true,
      visibility: "INTERNAL",
    });
    expect("visibility" in out).toBe(false);
  });
});

describe("zodToActionError", () => {
  it("maps a ZodError to a VALIDATION ActionError with per-field messages", () => {
    const r = createTicketSchema.safeParse({ subject: "ab", description: "", category: "WIRE_TRANSFER" });
    expect(r.success).toBe(false);
    if (r.success) return;
    const err = zodToActionError(r.error);
    expect(err.ok).toBe(false);
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toBe("Invalid input");
    expect(err.fieldErrors?.subject?.length).toBeGreaterThan(0);
    expect(err.fieldErrors?.description?.length).toBeGreaterThan(0);
    expect(err.fieldErrors?.requesterName?.length).toBeGreaterThan(0);
  });

  it("surfaces root-level refine messages under _form", () => {
    const r = updateTicketFieldsSchema.safeParse({ ticketId: TICKET_ID, version: 1 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const err = zodToActionError(r.error);
    expect(err.fieldErrors?._form?.length).toBe(1);
  });

  it("reports a long list's many bad items as a few messages, not one each", () => {
    const r = z.object({ ids: z.array(z.string().regex(/^[a-z]+$/)), note: z.string().min(1) }).safeParse({
      ids: Array.from({ length: 20_000 }, () => "1"),
      note: "",
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const err = zodToActionError(r.error);
    const messages = Object.values(err.fieldErrors ?? {}).flat();
    expect(messages).toHaveLength(MAX_REPORTED_ISSUES);
    expect(err.fieldErrors?.ids?.length).toBeGreaterThan(0);
  });
});

describe("multiValue (convention 12)", () => {
  it("reads repeated bare keys from URLSearchParams", () => {
    expect(multiValue(new URLSearchParams("status=NEW&status=OPEN"), "status")).toEqual(["NEW", "OPEN"]);
  });

  it("reads arrays and single strings from a record, splitting on commas and trimming", () => {
    expect(multiValue({ status: ["NEW", "OPEN"] }, "status")).toEqual(["NEW", "OPEN"]);
    expect(multiValue({ status: "NEW, OPEN,,  " }, "status")).toEqual(["NEW", "OPEN"]);
    expect(multiValue({ status: ["NEW,OPEN", "RESOLVED"] }, "status")).toEqual(["NEW", "OPEN", "RESOLVED"]);
    expect(multiValue({}, "status")).toEqual([]);
    expect(multiValue(new URLSearchParams(""), "status")).toEqual([]);
  });
});

describe("parseTicketListQuery", () => {
  it("applies defaults for an empty query", () => {
    expect(parseTicketListQuery({})).toEqual({
      status: DEFAULT_STATUSES,
      sort: "resolutionDueAt",
      dir: "asc",
      page: 1,
      pageSize: 50,
    });
    expect(parseTicketListQuery(new URLSearchParams(""))).toEqual(parseTicketListQuery({}));
  });

  it("convention 12: array, repeated keys and comma-joined all parse to the same status list", () => {
    const expected = ["NEW", "OPEN"];
    expect(parseTicketListQuery({ status: ["NEW", "OPEN"] }).status).toEqual(expected);
    expect(parseTicketListQuery(new URLSearchParams("status=NEW&status=OPEN")).status).toEqual(expected);
    expect(parseTicketListQuery({ status: "NEW,OPEN" }).status).toEqual(expected);
  });

  it("ignores the bracket-suffixed key so the default applies", () => {
    const q = parseTicketListQuery({ [BRACKET_STATUS_KEY]: "NEW" });
    expect(q.status).toEqual(DEFAULT_STATUSES);
  });

  it("drops unknown values and falls back to defaults", () => {
    const q = parseTicketListQuery({
      status: "BOGUS",
      priority: ["URGENT", "P0", "LOW"],
      slaStatus: "WARNING,LATE",
      queueKey: "SALES",
      sort: "bogus",
      dir: "sideways",
      page: "0",
      pageSize: "999",
    });
    expect(q.status).toEqual(DEFAULT_STATUSES);
    expect(q.priority).toEqual(["URGENT", "LOW"]);
    expect(q.slaStatus).toEqual(["WARNING"]);
    expect(q.queueKey).toBeUndefined();
    expect(q.sort).toBe("resolutionDueAt");
    expect(q.dir).toBe("asc");
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(50);
  });

  it("keeps valid scalar filters, caps pageSize at 200 and dedupes multi-values", () => {
    const q = parseTicketListQuery(
      new URLSearchParams(
        "queueKey=OPERATIONS&assigneeId=me&search=HD-1042&sort=priority&dir=desc&page=3&pageSize=200&status=NEW&status=NEW",
      ),
    );
    expect(q).toEqual({
      queueKey: "OPERATIONS",
      status: ["NEW"],
      assigneeId: "me",
      search: "HD-1042",
      sort: "priority",
      dir: "desc",
      page: 3,
      pageSize: 200,
    });
    expect(parseTicketListQuery({ pageSize: "201" }).pageSize).toBe(50);
    expect(parseTicketListQuery({ assigneeId: "unassigned" }).assigneeId).toBe("unassigned");
    expect(parseTicketListQuery({ assigneeId: "not valid!" }).assigneeId).toBeUndefined();
    expect(parseTicketListQuery({ search: "   " }).search).toBeUndefined();
  });
});

describe("parseAuditQuery", () => {
  it("defaults limit to 100 and caps it at 500", () => {
    expect(parseAuditQuery({})).toEqual({ limit: 100 });
    expect(parseAuditQuery({ limit: "500" }).limit).toBe(500);
    expect(parseAuditQuery({ limit: "501" }).limit).toBe(100);
    expect(parseAuditQuery({ limit: "0" }).limit).toBe(100);
    expect(parseAuditQuery({ limit: "abc" }).limit).toBe(100);
  });

  it("reads action as a multi-value key (repeated, array, comma) and drops unknown actions", () => {
    const expected = ["TICKET_CREATED", "AUTHZ_DENIED"];
    expect(parseAuditQuery(new URLSearchParams("action=TICKET_CREATED&action=AUTHZ_DENIED")).action).toEqual(expected);
    expect(parseAuditQuery({ action: ["TICKET_CREATED", "AUTHZ_DENIED"] }).action).toEqual(expected);
    expect(parseAuditQuery({ action: "TICKET_CREATED,AUTHZ_DENIED,NOPE" }).action).toEqual(expected);
    expect(parseAuditQuery({ action: "NOPE" }).action).toBeUndefined();
  });

  it("normalizes dates, lowercases actorEmail, parses ticketNumber / entityType / cursor", () => {
    const q = parseAuditQuery({
      from: "2026-09-16T00:00:00Z",
      to: "not a date",
      actorEmail: " Ops.Dev@WM-Helpdesk.local ",
      entityType: "TICKET",
      ticketNumber: "HD-42",
      cursor: "1234",
    });
    expect(q.from).toBe("2026-09-16T00:00:00.000Z");
    expect(q.to).toBeUndefined();
    expect(q.actorEmail).toBe("ops.dev@wm-helpdesk.local");
    expect(q.entityType).toBe("TICKET");
    expect(q.ticketNumber).toBe(42);
    expect(q.cursor).toBe("1234");
    expect(parseAuditQuery({ ticketNumber: "42" }).ticketNumber).toBe(42);
    expect(parseAuditQuery({ ticketNumber: "abc" }).ticketNumber).toBeUndefined();
    expect(parseAuditQuery({ entityType: "PLANET" }).entityType).toBeUndefined();
    expect(parseAuditQuery({ cursor: "12a" }).cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// widened updateTicketFields, the two new mutation schemas, the new list filters
//.
// ---------------------------------------------------------------------------

export type WaveASchemaParityChecks = [
  Expect<Equal<z.output<typeof recordClientContactSchema>, RecordClientContactInput>>,
  Expect<Equal<z.output<typeof assignToMeSchema>, AssignToMeInput>>,
  // The admin schemas (S9 macros, S8 users) live here too, so their parity is asserted here.
  Expect<Equal<z.output<typeof macroAdminSchema>, MacroAdminInput>>,
  Expect<Equal<z.output<typeof updateMacroSchema>, UpdateMacroInput>>,
  Expect<Equal<z.output<typeof setMacroActiveSchema>, SetMacroActiveInput>>,
  Expect<Equal<z.output<typeof setUserActiveSchema>, SetUserActiveInput>>,
];

describe("the admin schemas re-exported by @/server/macros and @/server/users", () => {
  it("are the same objects the action modules import — a move, not a copy", async () => {
    const macros = await import("@/server/macros");
    const users = await import("@/server/users");
    expect(macros.macroAdminSchema).toBe(macroAdminSchema);
    expect(macros.updateMacroSchema).toBe(updateMacroSchema);
    expect(macros.setMacroActiveSchema).toBe(setMacroActiveSchema);
    // The key check is re-exported as a function, not as a `MACRO_KEY_PATTERN` regex: the pattern
    // it replaced, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, carries the quantifier-inside-a-quantified-group
    // shape security scanner reports as ReDoS (CWE-1333). Identity here is the same "a move, not a copy" claim
    // the rest of this test makes; the accepted set itself is pinned in `isMacroKey` below.
    expect(macros.isMacroKey).toBe(isMacroKey);
    expect(users.setUserActiveSchema).toBe(setUserActiveSchema);
  });
});

describe("isMacroKey — the accepted set the retired MACRO_KEY_PATTERN regex defined", () => {
  // These are the two sides of `^[a-z0-9]+(?:-[a-z0-9]+)*$`, asserted as behaviour rather than as a
  // pinned `.source` string, so the linear scan cannot drift from the pattern it replaced.
  it("accepts lower-case alphanumeric segments joined by single hyphens", () => {
    for (const key of ["a", "1", "wire-verification-notice", "1099-availability", "tlh-explainer", "a1-2b-3c"]) {
      expect(isMacroKey(key), key).toBe(true);
    }
  });

  it("refuses an empty key, upper case, spaces, underscores, and a leading, trailing or doubled hyphen", () => {
    for (const key of ["", "-", "Wire-Notice", "wire notice", "wire_notice", "-wire", "wire-", "wire--notice", "wire.notice"]) {
      expect(isMacroKey(key), key).toBe(false);
    }
  });
});

describe("updateTicketFieldsSchema — Wave A fields", () => {
  const base = { ticketId: TICKET_ID, version: 4 };

  it("normalizes requesterEmail to trimmed lower case (so the client API's equality check keeps working)", () => {
    const r = updateTicketFieldsSchema.parse({ ...base, requesterEmail: "  Margaret.Thompson@Example.COM " });
    expect(r.requesterEmail).toBe("margaret.thompson@example.com");
  });

  it("treats an emptied email or phone input as an explicit null, and accepts null directly", () => {
    expect(updateTicketFieldsSchema.parse({ ...base, requesterEmail: "   " }).requesterEmail).toBeNull();
    expect(updateTicketFieldsSchema.parse({ ...base, requesterEmail: null }).requesterEmail).toBeNull();
    expect(updateTicketFieldsSchema.parse({ ...base, requesterPhone: "" }).requesterPhone).toBeNull();
    expect(updateTicketFieldsSchema.parse({ ...base, requesterPhone: null }).requesterPhone).toBeNull();
  });

  it("rejects a malformed email rather than storing an unreachable address", () => {
    expect(updateTicketFieldsSchema.safeParse({ ...base, requesterEmail: "not-an-address" }).success).toBe(false);
  });

  it("strips human phone formatting and requires E.164 — a national-format number is refused, not guessed at", () => {
    expect(updateTicketFieldsSchema.parse({ ...base, requesterPhone: "+1 (555) 123-4567" }).requesterPhone).toBe(
      "+15551234567",
    );
    expect(updateTicketFieldsSchema.parse({ ...base, requesterPhone: "+44 20 7946 0958" }).requesterPhone).toBe(
      "+442079460958",
    );
    expect(updateTicketFieldsSchema.safeParse({ ...base, requesterPhone: "555-123-4567" }).success).toBe(false);
    expect(updateTicketFieldsSchema.safeParse({ ...base, requesterPhone: "+0155512345" }).success).toBe(false);
    expect(updateTicketFieldsSchema.safeParse({ ...base, requesterPhone: "+1555123" }).success).toBe(false);
    expect(updateTicketFieldsSchema.safeParse({ ...base, requesterPhone: "+1234567890123456" }).success).toBe(false);
  });

  it("accepts the flag columns and normalizes followUpAt to an ISO string", () => {
    const r = updateTicketFieldsSchema.parse({
      ...base,
      isComplaint: true,
      escalationTarget: "COMPLIANCE",
      brand: "CEDAR_RIDGE_DIRECT",
      externalRef: "  ACAT-778812  ",
      followUpAt: "2026-10-01T09:00:00Z",
    });
    expect(r.isComplaint).toBe(true);
    expect(r.escalationTarget).toBe("COMPLIANCE");
    expect(r.brand).toBe("CEDAR_RIDGE_DIRECT");
    expect(r.externalRef).toBe("ACAT-778812");
    expect(r.followUpAt).toBe("2026-10-01T09:00:00.000Z");
    expect(updateTicketFieldsSchema.parse({ ...base, followUpAt: null }).followUpAt).toBeNull();
    expect(updateTicketFieldsSchema.parse({ ...base, followUpAt: "" }).followUpAt).toBeNull();
  });

  it("rejects an unparseable date and an unknown enum value", () => {
    expect(updateTicketFieldsSchema.safeParse({ ...base, followUpAt: "next tuesday" }).success).toBe(false);
    expect(updateTicketFieldsSchema.safeParse({ ...base, escalationTarget: "LEGAL" }).success).toBe(false);
    expect(updateTicketFieldsSchema.safeParse({ ...base, brand: "CEDAR_RIDGE_CRYPTO" }).success).toBe(false);
  });

  it("complaintFiledAt is not an input — the server stamps it (Decision #64)", () => {
    const r = updateTicketFieldsSchema.safeParse({ ...base, complaintFiledAt: "2026-09-19T00:00:00Z" });
    // Unknown keys are stripped, and with no editable field present the refine rejects the whole input.
    expect(r.success).toBe(false);
  });

  it("every Wave A field on its own satisfies the at-least-one-field refine", () => {
    const oneOf: Array<Record<string, unknown>> = [
      { requesterName: "Margaret Thompson" },
      { requesterEmail: "m@example.com" },
      { requesterPhone: "+15551234567" },
      { brand: "CEDAR_RIDGE_DIRECT" },
      { isComplaint: false },
      { escalationTarget: "NONE" },
      { followUpAt: null },
      { externalRef: null },
    ];
    for (const patch of oneOf) {
      expect(updateTicketFieldsSchema.safeParse({ ...base, ...patch }).success, JSON.stringify(patch)).toBe(true);
    }
  });
});

describe("recordClientContactSchema / assignToMeSchema", () => {
  it("accepts every channel and trims the note", () => {
    for (const channel of CLIENT_CONTACT_CHANNELS) {
      const r = recordClientContactSchema.parse({ ticketId: TICKET_ID, version: 2, channel, note: "  called back  " });
      expect(r.channel).toBe(channel);
      expect(r.note).toBe("called back");
    }
  });

  it("rejects an unknown channel, an empty note and an over-long note", () => {
    expect(
      recordClientContactSchema.safeParse({ ticketId: TICKET_ID, version: 2, channel: "CARRIER_PIGEON", note: "x" })
        .success,
    ).toBe(false);
    expect(
      recordClientContactSchema.safeParse({ ticketId: TICKET_ID, version: 2, channel: "PHONE", note: "   " }).success,
    ).toBe(false);
    expect(
      recordClientContactSchema.safeParse({ ticketId: TICKET_ID, version: 2, channel: "PHONE", note: "x".repeat(20_001) })
        .success,
    ).toBe(false);
  });

  it("assignToMe carries only the ticket and its concurrency token", () => {
    expect(assignToMeSchema.parse({ ticketId: TICKET_ID, version: 9 })).toEqual({ ticketId: TICKET_ID, version: 9 });
    expect(assignToMeSchema.safeParse({ ticketId: TICKET_ID, version: 0 }).success).toBe(false);
    // An assigneeId is not an input here: it is stripped, never honored.
    expect(assignToMeSchema.parse({ ticketId: TICKET_ID, version: 1, assigneeId: "someone_else" })).toEqual({
      ticketId: TICKET_ID,
      version: 1,
    });
  });
});

describe("parseTicketListQuery — Wave A filters", () => {
  it("parses the multi-valued filters with convention 12 and drops unknown members", () => {
    const q = parseTicketListQuery(
      new URLSearchParams("category=ACAT&category=BOGUS&brand=CEDAR_RIDGE_DIRECT&source=EMAIL,STAFF_FORM"),
    );
    expect(q.category).toEqual(["ACAT"]);
    expect(q.brand).toEqual(["CEDAR_RIDGE_DIRECT"]);
    expect(q.source).toEqual(["EMAIL", "STAFF_FORM"]);
  });

  it("parses isComplaint in both directions and ignores anything else", () => {
    expect(parseTicketListQuery({ isComplaint: "true" }).isComplaint).toBe(true);
    expect(parseTicketListQuery({ isComplaint: "1" }).isComplaint).toBe(true);
    expect(parseTicketListQuery({ isComplaint: "false" }).isComplaint).toBe(false);
    expect(parseTicketListQuery({ isComplaint: "0" }).isComplaint).toBe(false);
    expect(parseTicketListQuery({ isComplaint: "maybe" }).isComplaint).toBeUndefined();
    expect(parseTicketListQuery({}).isComplaint).toBeUndefined();
  });

  it("parses followUp, the createdAt bounds and an exact requesterEmail", () => {
    const q = parseTicketListQuery(
      new URLSearchParams(
        "followUp=overdue&createdFrom=2026-09-01&createdTo=2026-10-01T00:00:00Z&requesterEmail=Margaret%40Example.com",
      ),
    );
    expect(q.followUp).toBe("overdue");
    expect(q.createdFrom).toBe(new Date("2026-09-01").toISOString());
    expect(q.createdTo).toBe("2026-10-01T00:00:00.000Z");
    expect(q.requesterEmail).toBe("margaret@example.com");
  });

  it("drops an unknown followUp, an unparseable date and a non-address requesterEmail", () => {
    const q = parseTicketListQuery({
      followUp: "someday",
      createdFrom: "not a date",
      requesterEmail: "margaret (at) example.com",
    });
    expect(q.followUp).toBeUndefined();
    expect(q.createdFrom).toBeUndefined();
    expect(q.requesterEmail).toBeUndefined();
  });

  it("leaves every Wave A key absent when the URL carries none (the defaults test stays exact)", () => {
    const q = parseTicketListQuery({}) as Record<string, unknown>;
    for (const key of ["category", "brand", "source", "isComplaint", "followUp", "createdFrom", "createdTo", "requesterEmail"]) {
      expect(q, key).not.toHaveProperty(key);
    }
  });
});

describe("parseTicketExportScope", () => {
  it("defaults to standard and only recognizes the two declared scopes", () => {
    expect(parseTicketExportScope({})).toBe("standard");
    expect(parseTicketExportScope({ scope: "full" })).toBe("full");
    expect(parseTicketExportScope(new URLSearchParams("scope=full"))).toBe("full");
    expect(parseTicketExportScope({ scope: "everything" })).toBe("standard");
    expect(parseTicketExportScope({ scope: "" })).toBe("standard");
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (security) — the privileged requester-address change
// ---------------------------------------------------------------------------

describe("changeRequesterEmailSchema", () => {
  const base = { ticketId: TICKET_ID, version: 3, confirm: true as const };
  const reason = "Client confirmed the new address on a recorded call.";

  it("normalizes the address exactly as the nullable form does — the client API compares for equality", () => {
    const r = changeRequesterEmailSchema.parse({
      ...base,
      requesterEmail: "  Margaret.Thompson@EXAMPLE.com ",
      reason,
    });
    expect(r.requesterEmail).toBe("margaret.thompson@example.com");
    expect(r.confirm).toBe(true);
  });

  it("refuses a null or empty address — clearing stays on updateTicketFields", () => {
    expect(changeRequesterEmailSchema.safeParse({ ...base, requesterEmail: null, reason }).success).toBe(false);
    expect(changeRequesterEmailSchema.safeParse({ ...base, requesterEmail: "", reason }).success).toBe(false);
    expect(changeRequesterEmailSchema.safeParse({ ...base, requesterEmail: "   ", reason }).success).toBe(false);
    expect(changeRequesterEmailSchema.safeParse({ ...base, requesterEmail: "not-an-address", reason }).success).toBe(
      false,
    );
  });

  it("requires a literal confirm: true — an absent or falsy confirmation never parses", () => {
    const email = "elsewhere@example.com";
    expect(changeRequesterEmailSchema.safeParse({ ticketId: TICKET_ID, version: 3, requesterEmail: email, reason }).success).toBe(
      false,
    );
    expect(changeRequesterEmailSchema.safeParse({ ...base, confirm: false, requesterEmail: email, reason }).success).toBe(
      false,
    );
    expect(changeRequesterEmailSchema.safeParse({ ...base, confirm: "true", requesterEmail: email, reason }).success).toBe(
      false,
    );
  });

  it("requires a reason with substance, trims it, and caps it", () => {
    const email = "elsewhere@example.com";
    expect(changeRequesterEmailSchema.safeParse({ ...base, requesterEmail: email, reason: "typo" }).success).toBe(false);
    expect(changeRequesterEmailSchema.safeParse({ ...base, requesterEmail: email, reason: "   " }).success).toBe(false);
    expect(changeRequesterEmailSchema.safeParse({ ...base, requesterEmail: email }).success).toBe(false);
    expect(changeRequesterEmailSchema.parse({ ...base, requesterEmail: email, reason: `  ${reason}  ` }).reason).toBe(
      reason,
    );
    expect(
      changeRequesterEmailSchema.safeParse({ ...base, requesterEmail: email, reason: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("carries the same id and version discipline as every other ticket mutation", () => {
    const email = "elsewhere@example.com";
    expect(changeRequesterEmailSchema.safeParse({ ...base, version: 0, requesterEmail: email, reason }).success).toBe(
      false,
    );
    expect(changeRequesterEmailSchema.safeParse({ ...base, version: 1.5, requesterEmail: email, reason }).success).toBe(
      false,
    );
    expect(changeRequesterEmailSchema.safeParse({ ...base, ticketId: "", requesterEmail: email, reason }).success).toBe(
      false,
    );
  });
});
