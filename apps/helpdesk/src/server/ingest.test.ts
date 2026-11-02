/**
 * ingest.ts unit tests — no database.
 *
 * Everything in this file is pure or parse-only: the zod contracts the machine routes stand on, the
 * truncation rule that must append BODY_TRUNCATION_NOTE verbatim, the opaque export cursor, the
 * 1 MiB body reader, and the error → status mapping §8 pins. The transactional behaviour (idempotent
 * receipts, the status rules, audit-in-the-same-transaction) is proven live in
 * src/server/ingest.integration.test.ts, because those are database facts, not TypeScript facts.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BODY_TRUNCATION_NOTE, INGEST_LIMITS, REQUESTER_AUTHORED_SOURCES, TICKET_SOURCES } from "@/types/domain";

const mockEnv = vi.hoisted(() => ({
  env: {
    NODE_ENV: "test" as const,
    // Composed from its parts at run time: a literal `postgresql://USER:PASSWORD@HOST/DB` is a security scanner
    // secret finding in any tracked file, tests included, even for a database nothing dials.
    // `vi.hoisted` runs before imports, so `@/test-support/db-url` cannot be called from in here;
    // this is that module's `unitDatabaseUrl()` written as one expression.
    DATABASE_URL: Object.assign(new URL("postgresql://localhost:5432/unit_never_connects"), {
      username: "unit",
      password: "unit",
    }).toString(),
    PUBLIC_DATABASE_URL: undefined as string | undefined,
    AUTH_DEV_LOGIN: false,
    TRUSTED_PROXY_HOPS: 0,
    CLIENT_API_TOKEN: undefined as string | undefined,
    INTEGRATION_API_TOKEN: undefined as string | undefined,
    REPLY_TOKEN_SECRET: undefined as string | undefined,
    APP_ENV: "local" as const,
  },
}));
vi.mock("@/lib/env", () => mockEnv);

const mockDb = vi.hoisted(() => ({
  prisma: {
    ticket: { findUnique: vi.fn(), findMany: vi.fn() },
    comment: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    ingestReceipt: { findUnique: vi.fn() },
  },
  withTx: vi.fn(),
}));
vi.mock("@/lib/db", () => mockDb);

import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  EXPORT_DEFAULT_LIMIT,
  EXPORT_MAX_LIMIT,
  IngestExternalIdConflictError,
  assertMachineDeclaredSourceAllowed,
  badBodyResponse,
  decodeExportCursor,
  encodeExportCursor,
  ingestExternalKey,
  ingestMessageSchema,
  ingestTicketSchema,
  parseTicketExportQuery,
  readJsonBody,
  requesterScopeOf,
  toMachineErrorResponse,
  truncateBody,
  truncateSubject,
} from "@/server/ingest";

const validTicket = {
  source: "EMAIL",
  externalId: "<CAF=abc@mail.gmail.com>",
  subject: "Wire not received",
  description: "The wire I sent on Monday has not landed.",
  requesterName: "Dana Client",
  requesterEmail: "Dana.Client@example.com",
};

const validMessage = {
  ticketId: "ckz0000000000000000000000",
  source: "CLIENT_APP",
  externalId: "req-7f3a",
  authorKind: "REQUESTER",
  body: "Any update?",
};

describe("ingestTicketSchema", () => {
  it("accepts a minimal email-sourced ticket and normalises the address", () => {
    const out = ingestTicketSchema.parse(validTicket);
    expect(out.requesterEmail).toBe("dana.client@example.com");
    expect(out.category).toBeUndefined();
    expect(out.priority).toBeUndefined();
  });

  it("accepts a phone-only ticket (Decision #62) and refuses one with neither contact", () => {
    const phoneOnly = { ...validTicket, requesterEmail: undefined, requesterPhone: "+14155550123" };
    expect(ingestTicketSchema.parse(phoneOnly).requesterPhone).toBe("+14155550123");

    const neither = { ...validTicket, requesterEmail: undefined };
    const result = ingestTicketSchema.safeParse(neither);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(z.flattenError(result.error).fieldErrors.requesterEmail?.[0]).toMatch(/requesterEmail or requesterPhone/);
    }
  });

  it("refuses an explicit null for both contacts — the DB CHECK would refuse it too", () => {
    expect(
      ingestTicketSchema.safeParse({ ...validTicket, requesterEmail: null, requesterPhone: null }).success,
    ).toBe(false);
  });

  it("refuses a non-E.164 phone", () => {
    for (const phone of ["4155550123", "+0155550123", "+1 415 555 0123", "+141555501234567890"]) {
      expect(ingestTicketSchema.safeParse({ ...validTicket, requesterPhone: phone }).success).toBe(false);
    }
  });

  it("refuses unknown enum values rather than silently defaulting them", () => {
    expect(ingestTicketSchema.safeParse({ ...validTicket, source: "TELEPATHY" }).success).toBe(false);
    expect(ingestTicketSchema.safeParse({ ...validTicket, category: "NOT_A_CATEGORY" }).success).toBe(false);
    expect(ingestTicketSchema.safeParse({ ...validTicket, priority: "CRITICAL" }).success).toBe(false);
    expect(ingestTicketSchema.safeParse({ ...validTicket, queueKey: "LEGAL" }).success).toBe(false);
    expect(ingestTicketSchema.safeParse({ ...validTicket, brand: "OTHER_BRAND" }).success).toBe(false);
  });

  it("accepts every Wave A category and brand", () => {
    expect(ingestTicketSchema.safeParse({ ...validTicket, category: "BENEFICIARY_TOD" }).success).toBe(true);
    expect(ingestTicketSchema.safeParse({ ...validTicket, category: "VOICEMAIL_CALLBACK" }).success).toBe(true);
    expect(ingestTicketSchema.safeParse({ ...validTicket, brand: "CEDAR_RIDGE_DIRECT" }).success).toBe(true);
  });

  it("requires an externalId — idempotency is not optional on a machine path", () => {
    expect(ingestTicketSchema.safeParse({ ...validTicket, externalId: "" }).success).toBe(false);
    expect(ingestTicketSchema.safeParse({ ...validTicket, externalId: undefined }).success).toBe(false);
    expect(ingestTicketSchema.safeParse({ ...validTicket, externalId: "x".repeat(513) }).success).toBe(false);
  });

  it("accepts a long body (it is truncated, not refused) but refuses an absurd one", () => {
    expect(ingestTicketSchema.safeParse({ ...validTicket, description: "x".repeat(60_000) }).success).toBe(true);
    expect(ingestTicketSchema.safeParse({ ...validTicket, description: "x".repeat(400_001) }).success).toBe(false);
  });

  it("takes the advisor platform pointers as bounded ids and nothing longer", () => {
    expect(ingestTicketSchema.safeParse({ ...validTicket, householdId: "hh_123" }).success).toBe(true);
    expect(ingestTicketSchema.safeParse({ ...validTicket, requesterExternalId: "x".repeat(129) }).success).toBe(false);
  });
});

describe("ingestMessageSchema", () => {
  it("accepts a requester message with no author, visibility or disclaimer", () => {
    const out = ingestMessageSchema.parse(validMessage);
    expect(out.authorKind).toBe("REQUESTER");
    expect(out.visibility).toBeUndefined();
  });

  it("refuses a requester message that tries to be INTERNAL or to carry a disclaimer", () => {
    expect(ingestMessageSchema.safeParse({ ...validMessage, visibility: "INTERNAL" }).success).toBe(false);
    expect(ingestMessageSchema.safeParse({ ...validMessage, disclaimerKey: "GENERAL_SERVICE" }).success).toBe(false);
  });

  it("refuses SYSTEM authorship on this surface", () => {
    expect(ingestMessageSchema.safeParse({ ...validMessage, authorKind: "SYSTEM" }).success).toBe(false);
  });

  it("requires authorEmail for a STAFF message", () => {
    const staff = { ...validMessage, authorKind: "STAFF" };
    expect(ingestMessageSchema.safeParse(staff).success).toBe(false);
    expect(ingestMessageSchema.safeParse({ ...staff, authorEmail: "agent@example.com" }).success).toBe(true);
  });

  it("refuses a PUBLIC staff message without a disclaimer (I7)", () => {
    const staff = { ...validMessage, authorKind: "STAFF", authorEmail: "agent@example.com" };
    expect(ingestMessageSchema.safeParse({ ...staff, visibility: "PUBLIC" }).success).toBe(false);
    expect(ingestMessageSchema.safeParse({ ...staff, visibility: "PUBLIC", disclaimerKey: "NONE" }).success).toBe(false);
    expect(
      ingestMessageSchema.safeParse({ ...staff, visibility: "PUBLIC", disclaimerKey: "GENERAL_SERVICE" }).success,
    ).toBe(true);
  });

  it("refuses an empty body and a malformed ticket id", () => {
    expect(ingestMessageSchema.safeParse({ ...validMessage, body: "" }).success).toBe(false);
    expect(ingestMessageSchema.safeParse({ ...validMessage, ticketId: "../etc/passwd" }).success).toBe(false);
  });
});

describe("truncation (§7.3)", () => {
  it("leaves a short subject and body alone", () => {
    expect(truncateSubject("short")).toBe("short");
    expect(truncateBody("short")).toEqual({ body: "short", truncated: false });
  });

  it("cuts a subject at exactly the cap", () => {
    const long = "s".repeat(INGEST_LIMITS.subjectMaxChars + 40);
    expect(truncateSubject(long)).toHaveLength(INGEST_LIMITS.subjectMaxChars);
    expect(truncateSubject("s".repeat(INGEST_LIMITS.subjectMaxChars))).toHaveLength(INGEST_LIMITS.subjectMaxChars);
  });

  it("cuts a body at the cap and appends BODY_TRUNCATION_NOTE verbatim", () => {
    const long = "b".repeat(INGEST_LIMITS.bodyMaxChars + 1);
    const out = truncateBody(long);
    expect(out.truncated).toBe(true);
    expect(out.body.endsWith(BODY_TRUNCATION_NOTE)).toBe(true);
    expect(out.body.slice(0, INGEST_LIMITS.bodyMaxChars)).toBe("b".repeat(INGEST_LIMITS.bodyMaxChars));
    expect(out.body).toHaveLength(INGEST_LIMITS.bodyMaxChars + BODY_TRUNCATION_NOTE.length);
  });

  it("does not truncate a body of exactly the cap — the boundary belongs to the client", () => {
    const exact = "b".repeat(INGEST_LIMITS.bodyMaxChars);
    expect(truncateBody(exact)).toEqual({ body: exact, truncated: false });
  });
});

describe("export cursor", () => {
  it("round-trips", () => {
    const cursor = { updatedAt: new Date("2026-09-19T12:34:56.789Z"), id: "ckz0000000000000000000001" };
    const decoded = decodeExportCursor(encodeExportCursor(cursor));
    expect(decoded?.id).toBe(cursor.id);
    expect(decoded?.updatedAt.toISOString()).toBe(cursor.updatedAt.toISOString());
  });

  it("is opaque — it carries no readable ticket data in the URL (I14)", () => {
    const encoded = encodeExportCursor({ updatedAt: new Date(0), id: "abc" });
    expect(encoded).not.toContain("|");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects anything it did not mint", () => {
    expect(decodeExportCursor("")).toBeNull();
    expect(decodeExportCursor("not-base64-$$$")).toBeNull();
    expect(decodeExportCursor(Buffer.from("no-separator", "utf8").toString("base64url"))).toBeNull();
    expect(decodeExportCursor(Buffer.from("|abc", "utf8").toString("base64url"))).toBeNull();
    expect(decodeExportCursor(Buffer.from("not-a-date|abc", "utf8").toString("base64url"))).toBeNull();
    expect(
      decodeExportCursor(Buffer.from("2026-09-19T00:00:00.000Z|../etc", "utf8").toString("base64url")),
    ).toBeNull();
  });
});

describe("parseTicketExportQuery", () => {
  const q = (s: string): URLSearchParams => new URLSearchParams(s);

  it("defaults to no filter and the default limit", () => {
    const parsed = parseTicketExportQuery(q(""));
    expect(parsed.updatedSince).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
    expect(parsed.limit).toBe(EXPORT_DEFAULT_LIMIT);
  });

  it("parses an ISO updatedSince and a minted cursor", () => {
    const cursor = encodeExportCursor({ updatedAt: new Date("2026-09-01T00:00:00.000Z"), id: "t1" });
    const parsed = parseTicketExportQuery(q(`updatedSince=2026-09-01T00:00:00.000Z&cursor=${cursor}&limit=25`));
    expect(parsed.updatedSince?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(parsed.cursor?.id).toBe("t1");
    expect(parsed.limit).toBe(25);
  });

  it("refuses a bad timestamp, a forged cursor and an out-of-range limit", () => {
    expect(() => parseTicketExportQuery(q("updatedSince=yesterday"))).toThrow(ValidationError);
    expect(() => parseTicketExportQuery(q("cursor=zzzz"))).toThrow(ValidationError);
    expect(() => parseTicketExportQuery(q("limit=0"))).toThrow(ValidationError);
    expect(() => parseTicketExportQuery(q("limit=-5"))).toThrow(ValidationError);
    expect(() => parseTicketExportQuery(q("limit=1.5"))).toThrow(ValidationError);
    expect(() => parseTicketExportQuery(q("limit=abc"))).toThrow(ValidationError);
    expect(() => parseTicketExportQuery(q(`limit=${EXPORT_MAX_LIMIT + 1}`))).toThrow(ValidationError);
    expect(parseTicketExportQuery(q(`limit=${EXPORT_MAX_LIMIT}`)).limit).toBe(EXPORT_MAX_LIMIT);
  });
});

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://wm-helpdesk.local/api/ingest/tickets", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

/** A body that hands out `chunks` and counts how many were actually pulled out of it. */
function countingStream(chunks: readonly Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  /** Chunks handed out. A stream prefetches one on its own, so this counts DELIVERY, not reading. */
  pulled: () => number;
  /** Whether the reader was acquired at all — i.e. whether the body was touched. */
  read: () => boolean;
} {
  let i = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      pulls++;
      controller.enqueue(chunks[i++]);
    },
  });
  const getReader = vi.fn(body.getReader.bind(body)) as unknown as ReadableStream<Uint8Array>["getReader"];
  body.getReader = getReader;
  return {
    body,
    pulled: () => pulls,
    read: () => (getReader as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0,
  };
}

const chunkOf = (s: string): Uint8Array[] => [new TextEncoder().encode(s)];

/**
 * `readJsonBody` touches only `headers` and `body`, so a duck-typed Request keeps the test honest
 * about what it exercises — and lets a body exist with NO declared length, which a constructed
 * `Request` will not do. That chunked case is exactly the one a declared-length check cannot see.
 */
function streamRequest(
  body: ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {},
): Request {
  return {
    url: "https://wm-helpdesk.local/api/ingest/tickets",
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...headers }),
    body,
  } as unknown as Request;
}

describe("readJsonBody", () => {
  it("parses a well-formed body", async () => {
    const out = await readJsonBody(jsonRequest(JSON.stringify({ a: 1 })));
    expect(out).toEqual({ ok: true, value: { a: 1 } });
  });

  it("refuses malformed JSON without echoing it", async () => {
    const out = await readJsonBody(jsonRequest("{not json"));
    expect(out).toEqual({ ok: false, reason: "malformed" });
    expect(badBodyResponse("malformed")).toEqual({
      status: 400,
      body: { error: "malformed_json", message: "Request body is not valid JSON" },
    });
  });

  it("refuses an oversize body on the declared length, before reading it", async () => {
    const req = jsonRequest("{}", { "content-length": String(INGEST_LIMITS.requestMaxBytes + 1) });
    expect(await readJsonBody(req)).toEqual({ ok: false, reason: "oversize" });
  });

  it("refuses an oversize body whose declared length lies", async () => {
    const big = JSON.stringify({ body: "x".repeat(2_000) });
    expect(await readJsonBody(jsonRequest(big), 500)).toEqual({ ok: false, reason: "oversize" });
    expect(badBodyResponse("oversize").status).toBe(400);
  });

  it("measures BYTES, not characters — a multi-byte body cannot slip past the cap", async () => {
    // 600 three-byte characters = 1800 bytes, under a 2000-character reading but over a 1000-byte cap.
    const body = JSON.stringify({ b: "あ".repeat(600) });
    expect(body.length).toBeLessThan(2_000);
    expect(await readJsonBody(jsonRequest(body), 1_000)).toEqual({ ok: false, reason: "oversize" });
  });

  it("reads a streamed body that declares no length at all", async () => {
    const chunks = [...new TextEncoder().encode(JSON.stringify({ a: 1 }))].map((b) => new Uint8Array([b]));
    const s = countingStream(chunks);
    expect(await readJsonBody(streamRequest(s.body), 1_000)).toEqual({ ok: true, value: { a: 1 } });
  });

  it("caps a body with NO content-length: the read stops at the limit instead of buffering it all", async () => {
    // The chunked case the declared-length check cannot see. Without a cap on the STREAM this walks
    // the whole 100 KiB into memory; with one, it stops a chunk past 1 KiB.
    const s = countingStream(Array.from({ length: 100 }, () => new Uint8Array(1_024).fill(0x20)));
    expect(await readJsonBody(streamRequest(s.body), 1_024)).toEqual({ ok: false, reason: "oversize" });
    expect(s.pulled()).toBeLessThanOrEqual(3);
  });

  it("caps a body whose content-length LIES about being small", async () => {
    const s = countingStream(Array.from({ length: 100 }, () => new Uint8Array(1_024).fill(0x20)));
    const req = streamRequest(s.body, { "content-length": "2" });
    expect(await readJsonBody(req, 1_024)).toEqual({ ok: false, reason: "oversize" });
    expect(s.pulled()).toBeLessThanOrEqual(3);
  });

  it("refuses the declared length WITHOUT touching the body", async () => {
    const s = countingStream([new Uint8Array(8).fill(0x20)]);
    const req = streamRequest(s.body, { "content-length": String(INGEST_LIMITS.requestMaxBytes + 1) });
    expect(await readJsonBody(req)).toEqual({ ok: false, reason: "oversize" });
    expect(s.read()).toBe(false);
  });

  it("accepts a body exactly at the cap, and refuses one byte more", async () => {
    const exact = JSON.stringify({ a: 1 });
    const size = new TextEncoder().encode(exact).byteLength;
    expect(await readJsonBody(streamRequest(countingStream(chunkOf(exact)).body), size)).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(await readJsonBody(streamRequest(countingStream(chunkOf(exact)).body), size - 1)).toEqual({
      ok: false,
      reason: "oversize",
    });
  });

  it("treats a missing body as malformed, not as an empty success", async () => {
    expect(await readJsonBody(streamRequest(null))).toEqual({ ok: false, reason: "malformed" });
  });

  it("treats a body that errors mid-stream as malformed", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a"'));
        controller.error(new Error("connection reset"));
      },
    });
    expect(await readJsonBody(streamRequest(body))).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a nonsensical cap as a programming error rather than answering 'malformed'", async () => {
    await expect(readJsonBody(jsonRequest("{}"), -1)).rejects.toBeInstanceOf(RangeError);
    await expect(readJsonBody(jsonRequest("{}"), 1.5)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("toMachineErrorResponse (§8 status codes)", () => {
  it("maps a zod failure to 422 with fieldErrors", () => {
    const parsed = ingestTicketSchema.safeParse({ ...validTicket, subject: "" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const out = toMachineErrorResponse("t", parsed.error);
    expect(out.status).toBe(422);
    expect(out.body.error).toBe("validation");
    expect(out.body.fieldErrors).toBeDefined();
  });

  it("maps the AppError family", () => {
    expect(toMachineErrorResponse("t", new NotFoundError()).status).toBe(404);
    expect(toMachineErrorResponse("t", new ConflictError()).status).toBe(409);
    expect(toMachineErrorResponse("t", new ValidationError("bad", { x: ["y"] }))).toEqual({
      status: 422,
      body: { error: "validation", message: "bad", fieldErrors: { x: ["y"] } },
    });
  });

  it("never leaks an unknown error's message", () => {
    const out = toMachineErrorResponse("t", new Error("ssn 123-45-6789 in a Prisma message"));
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: "internal" });
    expect(JSON.stringify(out.body)).not.toContain("123-45-6789");
  });
});

describe("ingestExternalKey — the idempotency namespace", () => {
  it("is the identity for the single-tenant sources: one trusted upstream owns the id space", () => {
    for (const source of ["EMAIL", "API", "STAFF_FORM", "PHONE"] as const) {
      expect(ingestExternalKey(source, "req-1", "dana@example.com")).toBe("req-1");
    }
  });

  it("namespaces CLIENT_APP per requester, so one client's request id cannot resolve to another's", () => {
    const a = ingestExternalKey("CLIENT_APP", "req-1", "a@example.com");
    const b = ingestExternalKey("CLIENT_APP", "req-1", "b@example.com");
    expect(a).not.toBe(b);
    expect(a).not.toBe("req-1");
    // Deterministic: a retry from the same caller derives the same key and still replays.
    expect(ingestExternalKey("CLIENT_APP", "req-1", "a@example.com")).toBe(a);
  });

  it("keeps the caller's raw id readable and never puts the scope in the clear", () => {
    const key = ingestExternalKey("CLIENT_APP", "req-7f3a", "dana.client@example.com");
    expect(key.endsWith("~req-7f3a")).toBe(true);
    expect(key).not.toContain("dana.client@example.com");
    expect(key).not.toContain("dana");
  });

  it("distinguishes two requesters even when one id is a suffix of the other", () => {
    const a = ingestExternalKey("CLIENT_APP", "1", "a@example.com");
    const b = ingestExternalKey("CLIENT_APP", "~1", "a@example.com");
    expect(a).not.toBe(b);
  });

  it("never collapses a missing scope onto a real one", () => {
    expect(ingestExternalKey("CLIENT_APP", "req-1", null)).not.toBe(
      ingestExternalKey("CLIENT_APP", "req-1", "a@example.com"),
    );
  });
});

describe("requesterScopeOf", () => {
  it("normalises the email the same way every comparison on this surface does", () => {
    expect(requesterScopeOf({ requesterEmail: "  Dana.Client@Example.COM " })).toBe("dana.client@example.com");
  });

  it("falls back to the phone for a voicemail ticket (Decision #62), then to null", () => {
    expect(requesterScopeOf({ requesterEmail: null, requesterPhone: "+14155550123" })).toBe("+14155550123");
    expect(requesterScopeOf({ requesterEmail: "", requesterPhone: "   " })).toBeNull();
    expect(requesterScopeOf({})).toBeNull();
  });
});

describe("IngestExternalIdConflictError", () => {
  it("is a ConflictError, so §8 still answers 409 and no caller learns a new code", () => {
    const e = new IngestExternalIdConflictError();
    expect(e).toBeInstanceOf(ConflictError);
    expect(toMachineErrorResponse("t", e).status).toBe(409);
    expect(toMachineErrorResponse("t", e).body.error).toBe("conflict");
  });

  it("carries no ticket id or body text in its message (I14)", () => {
    const e = new IngestExternalIdConflictError();
    expect(e.message).toBe("externalId is already recorded against a different ticket");
  });
});

/**
 * Decision #117. `source` stopped being routing metadata the moment the client API began rendering
 * `description` back to the requester as their own opening message, so the HTTP machine surface — one
 * INGEST-scoped credential, `source` taken straight from the body — may no longer declare a
 * requester-authored one.
 */
describe("assertMachineDeclaredSourceAllowed (Decision #117)", () => {
  /** Written out, not derived: the point is that a reclassification has to fail a test. */
  const MACHINE_DECLARABLE = ["STAFF_FORM", "PHONE", "VOICEMAIL", "SLACK", "SYSTEM", "IMPORT", "API"] as const;

  it("refuses every requester-authored source, naming the field", () => {
    for (const source of REQUESTER_AUTHORED_SOURCES) {
      let thrown: unknown;
      try {
        assertMachineDeclaredSourceAllowed(source);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, source).toBeInstanceOf(ValidationError);
      expect((thrown as ValidationError).fieldErrors?.source, source).toBeTruthy();
      // 422, like any other bad body — not a 403, because this is a malformed request, not a denial.
      expect(toMachineErrorResponse("ingest.tickets", thrown).status).toBe(422);
    }
  });

  it("allows every other source, so the real workflows are untouched", () => {
    for (const source of MACHINE_DECLARABLE) {
      expect(() => assertMachineDeclaredSourceAllowed(source), source).not.toThrow();
    }
  });

  it("the two lists partition TicketSource — a tenth source is classified here on purpose", () => {
    expect([...REQUESTER_AUTHORED_SOURCES, ...MACHINE_DECLARABLE].sort()).toEqual([...TICKET_SOURCES].sort());
  });

  // A check that the firm's n8n workflows (integrations/n8n/) declare no source this route refuses stood
  // here. Those workflows were not part of the portfolio import; the demo posts only to /api/ingest/email.
});
