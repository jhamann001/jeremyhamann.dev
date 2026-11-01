/**
 * email-intake.ts unit tests (§10 "S2") — no database.
 *
 * Everything here is pure or parse-only: the payload contract the n8n workflow stands on, the
 * external-id rule that makes a replay recognisable, and the body extraction that decides whether a
 * message has any content at all. The transactional behaviour — which branch a message takes, what
 * is written, and what is audited — is proven live in `email-intake.integration.test.ts`, because
 * those are database facts, not TypeScript facts.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { INGEST_LIMITS } from "@/types/domain";

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
    MAILBOX_MAP: undefined as string | undefined,
    ATTACHMENTS_BUCKET: undefined as string | undefined,
    ATTACHMENTS_SIGNER_EMAIL: undefined as string | undefined,
    APP_ENV: "local" as const,
  },
}));
vi.mock("@/lib/env", () => mockEnv);

const mockDb = vi.hoisted(() => ({
  prisma: {
    ticket: { findUnique: vi.fn() },
    messageDelivery: { findFirst: vi.fn() },
    suspendedIntake: { findFirst: vi.fn() },
    ingestReceipt: { findUnique: vi.fn() },
    attachment: { createMany: vi.fn(), updateMany: vi.fn() },
  },
  withTx: vi.fn(),
}));
vi.mock("@/lib/db", () => mockDb);

import {
  EMAIL_SOURCE,
  INBOUND_BODY_HARD_LIMIT_CHARS,
  INBOUND_STAGING_PREFIX,
  NO_SUBJECT_PLACEHOLDER,
  SENDER_MISMATCH_DETAIL,
  extractBody,
  externalIdFor,
  inboundEmailSchema,
  isInboundStagingKey,
  parseInboundEmail,
  sanitizedMessageId,
  sanitizedRawRef,
} from "@/server/email-intake";
import { EXPECTED_BRANCHES, INBOUND_FIXTURES, parseRawMessage } from "@/lib/email/__fixtures__/inbound-corpus";

const MINIMAL = {
  mailbox: "service@example.com",
  from: "Marla Whitfield <marla.whitfield@fastmail.test>",
  subject: "Statement request",
  textBody: "Could you send the August statement?",
};

describe("inboundEmailSchema", () => {
  it("accepts the minimal payload an n8n Gmail node can produce", () => {
    const parsed = parseInboundEmail(MINIMAL);
    expect(parsed.mailbox).toBe("service@example.com");
    expect(parsed.textBody).toBe("Could you send the August statement?");
    expect(parsed.messageId).toBeUndefined();
  });

  it("accepts the full payload", () => {
    const parsed = parseInboundEmail({
      ...MINIMAL,
      messageId: "<abc@x.test>",
      htmlBody: "<p>hi</p>",
      headers: { From: "a@b.test", "In-Reply-To": "<x@y.test>" },
      receivedAt: "2026-09-14T13:12:44.000Z",
      rawRef: "n8n:exec-1",
      spamFlagged: false,
      attachments: [{ filename: "form.pdf", mime: "application/pdf", size: 1024, contentBase64: "AAAA" }],
    });
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.headers?.["In-Reply-To"]).toBe("<x@y.test>");
  });

  it("joins a repeated header supplied as an array", () => {
    const parsed = parseInboundEmail({ ...MINIMAL, headers: { "authentication-results": ["spf=pass", "dmarc=pass"] } });
    expect(parsed.headers?.["authentication-results"]).toBe("spf=pass\ndmarc=pass");
  });

  it("refuses a payload with no mailbox or no from", () => {
    expect(() => parseInboundEmail({ ...MINIMAL, mailbox: undefined })).toThrow(z.ZodError);
    expect(() => parseInboundEmail({ ...MINIMAL, from: "" })).toThrow(z.ZodError);
    expect(() => parseInboundEmail({})).toThrow(z.ZodError);
  });

  it("refuses an attachment part with neither inline bytes nor an object reference", () => {
    const bad = { ...MINIMAL, attachments: [{ filename: "a.pdf", mime: "application/pdf" }] };
    expect(() => parseInboundEmail(bad)).toThrow(z.ZodError);
  });

  it("refuses an attachment part over the 25 MiB declared cap", () => {
    const bad = {
      ...MINIMAL,
      attachments: [
        { filename: "a.pdf", mime: "application/pdf", size: INGEST_LIMITS.attachmentMaxBytes + 1, contentBase64: "AA" },
      ],
    };
    expect(() => parseInboundEmail(bad)).toThrow(z.ZodError);
  });

  it("does not let the caller choose the queue, the category or the ticket", () => {
    const parsed = inboundEmailSchema.parse({ ...MINIMAL, queueKey: "ADVICE", category: "WIRE_REQUEST", ticketId: "x" });
    expect(parsed).not.toHaveProperty("queueKey");
    expect(parsed).not.toHaveProperty("category");
    expect(parsed).not.toHaveProperty("ticketId");
  });

  it("parses every fixture in the corpus", () => {
    for (const f of INBOUND_FIXTURES) {
      const { headers, body } = parseRawMessage(f.raw);
      const parsed = parseInboundEmail({
        mailbox: f.mailbox,
        messageId: headers["message-id"],
        from: headers["from"],
        subject: headers["subject"],
        textBody: f.htmlBody === undefined ? body : undefined,
        htmlBody: f.htmlBody,
        headers,
        rawRef: f.rawRef,
      });
      expect(parsed.mailbox, f.key).toBe(f.mailbox);
      expect(EXPECTED_BRANCHES[f.key], f.key).toBeDefined();
    }
  });
});

describe("externalIdFor", () => {
  it("uses the Message-ID, stripped of its angle brackets and lower-cased", () => {
    const input = parseInboundEmail({ ...MINIMAL, messageId: "<CAF8y9Qm@Mail.Fastmail.TEST>" });
    expect(externalIdFor(input, {})).toBe("caf8y9qm@mail.fastmail.test");
  });

  it("falls back to the Message-ID header when the payload field is absent", () => {
    const input = parseInboundEmail(MINIMAL);
    expect(externalIdFor(input, { "message-id": "<from-header@x.test>" })).toBe("from-header@x.test");
  });

  it("derives a stable synthetic id when the message carries none", () => {
    const input = parseInboundEmail(MINIMAL);
    const first = externalIdFor(input, {});
    expect(first).toMatch(/^synthetic\.[0-9a-f]{64}$/);
    expect(externalIdFor(parseInboundEmail(MINIMAL), {})).toBe(first);
  });

  it("gives two different messages two different synthetic ids", () => {
    const a = externalIdFor(parseInboundEmail(MINIMAL), {});
    const b = externalIdFor(parseInboundEmail({ ...MINIMAL, subject: "Something else" }), {});
    const c = externalIdFor(parseInboundEmail({ ...MINIMAL, from: "someone.else@x.test" }), {});
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("caps an absurdly long Message-ID rather than storing it whole", () => {
    const input = parseInboundEmail({ ...MINIMAL, messageId: `<${"a".repeat(398)}>` });
    expect(externalIdFor(input, {}).length).toBeLessThanOrEqual(400);
  });
});

describe("extractBody", () => {
  it("prefers the text part", () => {
    const input = parseInboundEmail({ ...MINIMAL, htmlBody: "<p>html version</p>" });
    expect(extractBody(input)).toBe("Could you send the August statement?");
  });

  it("falls back to the HTML part converted to text", () => {
    const input = parseInboundEmail({ ...MINIMAL, textBody: undefined, htmlBody: "<p>Hello</p><p>World</p>" });
    expect(extractBody(input)).toBe("Hello\n\nWorld");
  });

  it("treats a whitespace-only text part as absent and uses the HTML part", () => {
    const input = parseInboundEmail({ ...MINIMAL, textBody: "   \n  ", htmlBody: "<p>Real content</p>" });
    expect(extractBody(input)).toBe("Real content");
  });

  it("returns '' when neither part carries anything", () => {
    expect(extractBody(parseInboundEmail({ ...MINIMAL, textBody: "  " }))).toBe("");
    expect(extractBody(parseInboundEmail({ ...MINIMAL, textBody: undefined }))).toBe("");
  });

  it("normalises CRLF", () => {
    const input = parseInboundEmail({ ...MINIMAL, textBody: "line one\r\nline two" });
    expect(extractBody(input)).toBe("line one\nline two");
  });
});

describe("module constants", () => {
  it("pins the source, the hard body ceiling and the subject placeholder", () => {
    expect(EMAIL_SOURCE).toBe("EMAIL");
    // The ceiling is S1's own BODY_HARD_MAX: past it a message is HELD, never 422'd back at the MTA.
    expect(INBOUND_BODY_HARD_LIMIT_CHARS).toBe(400_000);
    expect(INBOUND_BODY_HARD_LIMIT_CHARS).toBeGreaterThan(INGEST_LIMITS.bodyMaxChars);
    expect(NO_SUBJECT_PLACEHOLDER).toBe("(no subject)");
  });
});

// ---------------------------------------------------------------------------
// objectRef — the staging-namespace gate (security fix, 2026-09-19)
// ---------------------------------------------------------------------------

describe("objectRef staging namespace", () => {
  function partWith(objectRef: string) {
    return {
      ...MINIMAL,
      attachments: [{ filename: "statement.pdf", mime: "application/pdf", objectRef }],
    };
  }

  it("accepts a key under the inbound staging prefix", () => {
    const parsed = parseInboundEmail(partWith(`${INBOUND_STAGING_PREFIX}/abc-123_XYZ`));
    expect(parsed.attachments?.[0].objectRef).toBe(`${INBOUND_STAGING_PREFIX}/abc-123_XYZ`);
  });

  it("REFUSES a key shaped like an existing attachment, which is what <ticketId>/<attachmentId> is", () => {
    // The attack: both ids are visible to anyone who can open the victim's ticket.
    const result = inboundEmailSchema.safeParse(partWith("cmfq9k2b30001abcdef012345/a1b2c3d4e5f6"));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(z.treeifyError(result.error).properties?.attachments).toBeDefined();
  });

  it("refuses path traversal, a bare id, a nested key and an upstream reference the store cannot serve", () => {
    for (const bad of [
      `${INBOUND_STAGING_PREFIX}/../cmfq9k2b30001/a1b2`,
      `../${INBOUND_STAGING_PREFIX}/x`,
      "inbound",
      `${INBOUND_STAGING_PREFIX}/2026/09/19/part-1`,
      `${INBOUND_STAGING_PREFIX}/statement.pdf`,
      "ANrGH2bx9mQ-gmail-attachment-id",
      "inboundish/x",
    ]) {
      expect(inboundEmailSchema.safeParse(partWith(bad)).success, bad).toBe(false);
    }
  });

  it("names the field rather than failing silently deep in the copy", () => {
    const result = inboundEmailSchema.safeParse(partWith("victim_ticket_id/victim_attachment_id"));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("objectRef");
  });

  it("isInboundStagingKey agrees with the schema", () => {
    expect(isInboundStagingKey(`${INBOUND_STAGING_PREFIX}/part_1`)).toBe(true);
    expect(isInboundStagingKey("cmfq9k2b30001abcdef012345/a1b2c3d4")).toBe(false);
    expect(isInboundStagingKey(`${INBOUND_STAGING_PREFIX}/a/b`)).toBe(false);
    expect(isInboundStagingKey("")).toBe(false);
  });

  it("still requires one of contentBase64 or objectRef", () => {
    const result = inboundEmailSchema.safeParse({
      ...MINIMAL,
      attachments: [{ filename: "x.pdf", mime: "application/pdf" }],
    });
    expect(result.success).toBe(false);
  });

  it("pins the audit detail that distinguishes a sender mismatch from a DMARC failure", () => {
    expect(SENDER_MISMATCH_DETAIL).toBe("SENDER_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// The two caller-supplied pointers a held message carries
// ---------------------------------------------------------------------------

/**
 * `SuspendedIntake.messageId` and `.rawRef` are persisted free text like every other column on that
 * row, and the table is append-only — a redaction rule applied later cannot reach a row already
 * written. The risk of sanitising them is that the value CHANGES: `existingSuspension` matches a
 * replay on the exact stored `messageId`, so an ordinary Message-ID has to round-trip byte for byte.
 */
describe("sanitizedMessageId / sanitizedRawRef", () => {
  it("leaves an ordinary Message-ID byte-identical, bracketed or bare", () => {
    expect(sanitizedMessageId("<abc123@mail.example>")).toBe("<abc123@mail.example>");
    expect(sanitizedMessageId("abc123@mail.example")).toBe("abc123@mail.example");
    expect(sanitizedMessageId("CAO+8xWq7Z1kq=R9v_2mS@mail.gmail.com")).toBe(
      "CAO+8xWq7Z1kq=R9v_2mS@mail.gmail.com",
    );
    expect(sanitizedMessageId("20260919142233.9F3B1C0A42@mx.fastmail.test")).toBe(
      "20260919142233.9F3B1C0A42@mx.fastmail.test",
    );
  });

  it("leaves the synthetic external id — the id a message with no Message-ID gets — untouched", () => {
    const synthetic = `synthetic.${"1234567890abcdef".repeat(4)}`;
    expect(sanitizedMessageId(synthetic)).toBe(synthetic);
    const allDigits = `synthetic.${"9".repeat(64)}`;
    expect(sanitizedMessageId(allDigits)).toBe(allDigits);
  });

  it("agrees with `externalIdFor` on every corpus fixture, so no replay read can miss", () => {
    for (const f of INBOUND_FIXTURES) {
      const { headers, body } = parseRawMessage(f.raw);
      const id = externalIdFor(
        { mailbox: f.mailbox, from: headers["from"] ?? "x@y.test", textBody: body },
        headers,
      );
      expect(sanitizedMessageId(id), f.key).toBe(id);
    }
  });

  it("redacts a pointer that carries client material, rather than storing it forever", () => {
    expect(sanitizedRawRef("gmail/thread/account number 4021 7788 3310")).toBe(
      "gmail/thread/account number [REDACTED:ACCOUNT ****3310]",
    );
    expect(sanitizedMessageId("<ssn 345-67-8901@mail.example>")).toBe("<ssn [REDACTED:SSN]@mail.example>");
  });

  it("is idempotent — a re-sanitised value is the same value", () => {
    const once = sanitizedRawRef("n8n/exec/ssn: 345-67-8901");
    expect(once).not.toBeNull();
    expect(sanitizedRawRef(once)).toBe(once);
  });

  it("bounds each pointer to its column's cap", () => {
    expect((sanitizedMessageId("m".repeat(600)) ?? "").length).toBe(400);
    expect((sanitizedRawRef("r".repeat(900)) ?? "").length).toBe(512);
  });

  it("maps absent, empty and whitespace-only pointers to null", () => {
    for (const value of [null, undefined, "", "   "]) {
      expect(sanitizedMessageId(value)).toBeNull();
      expect(sanitizedRawRef(value)).toBeNull();
    }
  });
});
