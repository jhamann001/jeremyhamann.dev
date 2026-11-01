/**
 * Outbox unit tests — no database.
 *
 * `enqueueDelivery` takes its transaction client as a parameter, so the row it WOULD write can be
 * inspected without a database: the fake `tx` below records the `create` payload. The transitions
 * themselves (lease, expiry, retry, terminal FAILED) are transactional invariants and are proven
 * against the real database in `outbox.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { BRAND_IDENTITIES } from "@/lib/brand";
import type { DbTx } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { AppError } from "@/lib/errors";
import { formatOutboundSubject } from "@/lib/email/render-outbound";
import {
  MESSAGE_MAX_ATTEMPTS,
  OUTBOX_DEFAULT_LIMIT,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_LIMIT,
  REFERENCES_MAX_CHARS,
  REFERENCES_MAX_IDS,
  SUPPRESSED_DELIVERY_ERROR,
  clampOutboxLimit,
  enqueueDelivery,
  isDeliverableAddress,
  threadHeadersFor,
  trimReferences,
} from "@/server/outbox";
import type { EnqueueDeliveryInput } from "@/server/outbox";

type CreatedRow = Prisma.MessageDeliveryUncheckedCreateInput;

/**
 * A transaction client that records what `enqueueDelivery` would insert and answers the three reads it
 * makes on the way there.
 *
 * Those reads are the Wave B additions and each one has a default that keeps the ordinary case
 * ordinary: no suppression for this address, and no prior thread. A test that wants either passes it.
 */
function fakeTx(options?: {
  /** The live suppression `findLiveSuppression` should find, if any. */
  suppression?: { id: string; email: string; reason: string } | null;
  /** Prior requester comments carrying an inbound Message-ID. */
  comments?: Array<{ inboundMessageId: string | null; createdAt: Date }>;
  /** Prior EMAIL ingest receipts on this ticket. */
  receipts?: Array<{ externalId: string; receivedAt: Date }>;
  /** Prior outbound deliveries on this ticket. */
  deliveries?: Array<{ messageId: string; createdAt: Date }>;
}): { tx: DbTx; rows: CreatedRow[] } {
  const rows: CreatedRow[] = [];
  const tx = {
    messageDelivery: {
      create: async (args: { data: CreatedRow }) => {
        rows.push(args.data);
        return { id: args.data.id };
      },
      // The suppressed path refuses the row it has just created, in the same transaction, so the
      // ledger's `oldValue: "QUEUED"` is literally true. The fake applies the patch to the recorded
      // row, so an assertion reads the state the caller would have committed.
      update: async (args: { where: { id: string }; data: Partial<CreatedRow> }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (row !== undefined) Object.assign(row, args.data);
        return { id: args.where.id };
      },
      findMany: async () => options?.deliveries ?? [],
    },
    comment: { findMany: async () => options?.comments ?? [] },
    ingestReceipt: { findMany: async () => options?.receipts ?? [] },
    requesterSuppression: {
      findUnique: async () =>
        options?.suppression === undefined || options.suppression === null
          ? null
          : { ...options.suppression, removedAt: null },
    },
  } as unknown as DbTx;
  return { tx, rows };
}

const INPUT: EnqueueDeliveryInput = {
  ticketId: "tkt_abc",
  ticketNumber: 501,
  brand: "CEDAR_RIDGE_WEALTH",
  toAddress: "Client@Example.COM",
  subject: "Wire status",
  commentId: "cmt_abc",
  body: "Your wire was released.\n\n---\nDisclaimer text.",
};

describe("clampOutboxLimit", () => {
  it("defaults, floors and caps", () => {
    expect(clampOutboxLimit(undefined)).toBe(OUTBOX_DEFAULT_LIMIT);
    expect(clampOutboxLimit(Number.NaN)).toBe(OUTBOX_DEFAULT_LIMIT);
    expect(clampOutboxLimit(Number.POSITIVE_INFINITY)).toBe(OUTBOX_DEFAULT_LIMIT);
    expect(clampOutboxLimit(0)).toBe(1);
    expect(clampOutboxLimit(-5)).toBe(1);
    expect(clampOutboxLimit(7.9)).toBe(7);
    expect(clampOutboxLimit(OUTBOX_MAX_LIMIT)).toBe(OUTBOX_MAX_LIMIT);
    expect(clampOutboxLimit(10_000)).toBe(OUTBOX_MAX_LIMIT);
  });
});

describe("constants", () => {
  it("match the contract", () => {
    expect(OUTBOX_LEASE_MS).toBe(5 * 60_000);
    expect(MESSAGE_MAX_ATTEMPTS).toBe(5);
  });
});

describe("enqueueDelivery", () => {
  it("writes one QUEUED row carrying the brand's identity and the rendered message", async () => {
    const { tx, rows } = fakeTx();
    const result = await enqueueDelivery(tx, INPUT);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.status).toBe("QUEUED");
    expect(row.attempts).toBe(0);
    expect(row.commentId).toBe("cmt_abc");
    expect(row.ticketId).toBe("tkt_abc");
    expect(row.brand).toBe("CEDAR_RIDGE_WEALTH");
    expect(row.fromAddress).toBe(BRAND_IDENTITIES.CEDAR_RIDGE_WEALTH.fromAddress);
    expect(row.fromName).toBe(BRAND_IDENTITIES.CEDAR_RIDGE_WEALTH.fromName);
    expect(row.subject).toBe(formatOutboundSubject(501, "Wire status"));
    expect(row.textBody).toContain("Your wire was released.");
    expect(row.htmlBody).toContain("<p ");
    expect(row.messageId).toBe(result.messageId);
    expect(row.id).toBe(result.deliveryId);
  });

  it("normalises the recipient address", async () => {
    const { tx, rows } = fakeTx();
    await enqueueDelivery(tx, { ...INPUT, toAddress: "  Client@Example.COM " });
    expect(rows[0].toAddress).toBe("client@example.com");
  });

  it("embeds the delivery id in the Message-ID so S2 can thread the reply (§7.1)", async () => {
    const { tx } = fakeTx();
    const result = await enqueueDelivery(tx, INPUT);
    expect(result.messageId).toContain(result.deliveryId);
    expect(result.messageId.startsWith("<wm.")).toBe(true);
  });

  it("uses the bare brand mailbox as Reply-To when REPLY_TOKEN_SECRET is unset", async () => {
    // No Wave A env key is set anywhere in this wave, so this is the live configuration.
    const { tx, rows } = fakeTx();
    await enqueueDelivery(tx, INPUT);
    const identity = BRAND_IDENTITIES.CEDAR_RIDGE_WEALTH;
    expect(rows[0].replyTo.startsWith(`${identity.replyToLocalPart}`)).toBe(true);
    expect(rows[0].replyTo.endsWith(`@${identity.replyToDomain}`)).toBe(true);
    expect(rows[0].replyTo.split("@")).toHaveLength(2);
  });

  it("returns the MESSAGE_QUEUED entry instead of writing it (§3 rule 2)", async () => {
    const { tx } = fakeTx();
    const { auditEntry, deliveryId, messageId } = await enqueueDelivery(tx, INPUT);
    expect(auditEntry).toEqual({
      action: "MESSAGE_QUEUED",
      entityType: "MESSAGE_DELIVERY",
      entityId: deliveryId,
      ticketId: "tkt_abc",
      fieldChanged: "status",
      oldValue: null,
      newValue: "QUEUED",
      metadata: { brand: "CEDAR_RIDGE_WEALTH", to: "client@example.com", messageId },
    });
    // A human action carries NO `via` (§3 rule 1): that is what makes `metadata->>'via' IS NULL`
    // a clean partition of the ledger, so the staff composer's row must not grow one.
    expect(Object.keys(auditEntry.metadata ?? {})).not.toContain("via");
  });

  it("carries via and source on the MESSAGE_QUEUED row when a machine caller enqueues it (§3 rule 1)", async () => {
    const { tx } = fakeTx();
    const { auditEntry, messageId } = await enqueueDelivery(tx, { ...INPUT, via: "api", source: "API" });
    expect(auditEntry.metadata).toEqual({
      brand: "CEDAR_RIDGE_WEALTH",
      to: "client@example.com",
      messageId,
      via: "api",
      source: "API",
    });
  });

  it("carries via alone when the machine caller has no source to name", async () => {
    const { tx } = fakeTx();
    const { auditEntry } = await enqueueDelivery(tx, { ...INPUT, via: "email" });
    expect(auditEntry.metadata).toMatchObject({ via: "email" });
    expect(Object.keys(auditEntry.metadata ?? {})).not.toContain("source");
  });

  it("ignores a source with no via — `source` alone would not partition the ledger", async () => {
    const { tx } = fakeTx();
    const { auditEntry } = await enqueueDelivery(tx, { ...INPUT, source: "API" });
    const keys = Object.keys(auditEntry.metadata ?? {});
    expect(keys).not.toContain("via");
    expect(keys).not.toContain("source");
  });

  it("refuses an address that is not deliverable, and writes nothing", async () => {
    for (const bad of ["", "   ", "not-an-address", "a@b", "two@@dots.com", "has space@example.com"]) {
      const { tx, rows } = fakeTx();
      await expect(enqueueDelivery(tx, { ...INPUT, toAddress: bad }), bad).rejects.toBeInstanceOf(ValidationError);
      expect(rows, bad).toHaveLength(0);
    }
  });

  it("refuses a brand with no resolvable identity, and writes nothing", async () => {
    const { tx, rows } = fakeTx();
    await expect(
      enqueueDelivery(tx, { ...INPUT, brand: "CEDAR_RIDGE_MOON" as EnqueueDeliveryInput["brand"] }),
    ).rejects.toBeInstanceOf(AppError);
    expect(rows).toHaveLength(0);
  });

  it("renders the body it was given and appends no second disclaimer", async () => {
    const { tx, rows } = fakeTx();
    await enqueueDelivery(tx, { ...INPUT, body: "Hello.\n\n---\nONLY-ONCE-MARKER" });
    expect(rows[0].textBody.split("ONLY-ONCE-MARKER")).toHaveLength(2);
    expect(rows[0].htmlBody.split("ONLY-ONCE-MARKER")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// suppression at enqueue, and the threading headers
// ---------------------------------------------------------------------------

describe("enqueueDelivery — suppression", () => {
  const SUPPRESSED = { id: "sup_1", email: "client@example.com", reason: "HARD_BOUNCE" };

  it("creates the row in FAILED_SUPPRESSED rather than throwing, so the comment still records", async () => {
    const { tx, rows } = fakeTx({ suppression: SUPPRESSED });
    const result = await enqueueDelivery(tx, INPUT);

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("FAILED_SUPPRESSED");
    expect(rows[0].lastError).toBe(SUPPRESSED_DELIVERY_ERROR);
    expect(result.status).toBe("FAILED_SUPPRESSED");
    expect(result.suppression).toEqual(SUPPRESSED);
  });

  it("renders the message in full — the record of what the desk would have sent is complete", async () => {
    const { tx, rows } = fakeTx({ suppression: SUPPRESSED });
    await enqueueDelivery(tx, INPUT);

    expect(rows[0].subject).toBe(formatOutboundSubject(INPUT.ticketNumber, INPUT.subject));
    expect(rows[0].textBody).toContain("Your wire was released.");
    expect(rows[0].htmlBody).toContain("<!doctype html>");
    expect(rows[0].messageId).toContain(String(rows[0].id));
  });

  it("audits the refusal as a transition, never a MESSAGE_QUEUED for a message that left", async () => {
    const { tx } = fakeTx({ suppression: SUPPRESSED });
    const { auditEntry } = await enqueueDelivery(tx, INPUT);

    expect(auditEntry.action).toBe("MESSAGE_FAILED");
    expect(auditEntry.fieldChanged).toBe("status");
    // The row really was QUEUED, for one statement inside this transaction — which is what makes
    // `oldValue` honest and what keeps the shape identical to `system-messages.ts`'s own refusal.
    expect(auditEntry.oldValue).toBe("QUEUED");
    expect(auditEntry.newValue).toBe("FAILED_SUPPRESSED");
    const metadata = auditEntry.metadata as Record<string, unknown>;
    expect(metadata.suppressed).toBe(true);
    expect(metadata.suppressionId).toBe("sup_1");
    expect(metadata.reason).toBe("HARD_BOUNCE");
    expect(metadata.terminal).toBe(true);
  });

  it("is unchanged on the ordinary path: QUEUED, no lastError, MESSAGE_QUEUED", async () => {
    const { tx, rows } = fakeTx();
    const result = await enqueueDelivery(tx, INPUT);

    expect(rows[0].status).toBe("QUEUED");
    expect(rows[0].lastError ?? null).toBeNull();
    expect(result.status).toBe("QUEUED");
    expect(result.suppression).toBeNull();
    expect(result.auditEntry.action).toBe("MESSAGE_QUEUED");
    expect((result.auditEntry.metadata as Record<string, unknown>).suppressed).toBeUndefined();
  });

  it("matches the address case-insensitively — the list is keyed on the lower-cased form", async () => {
    const { tx, rows } = fakeTx({ suppression: SUPPRESSED });
    await enqueueDelivery(tx, { ...INPUT, toAddress: "  CLIENT@Example.com " });
    expect(rows[0].toAddress).toBe("client@example.com");
    expect(rows[0].status).toBe("FAILED_SUPPRESSED");
  });
});

describe("threadHeadersFor", () => {
  const T0 = new Date("2026-09-01T10:00:00.000Z");
  const T1 = new Date("2026-09-01T11:00:00.000Z");
  const T2 = new Date("2026-09-01T12:00:00.000Z");

  it("answers nothing for a ticket with no history", async () => {
    const { tx } = fakeTx();
    expect(await threadHeadersFor(tx, "tkt_abc")).toEqual({ inReplyTo: null, references: null });
  });

  it("replies to the client's most recent inbound message, with the whole chain in References", async () => {
    const { tx } = fakeTx({
      receipts: [
        { externalId: "first@client.test", receivedAt: T0 },
        { externalId: "second@client.test", receivedAt: T2 },
      ],
      deliveries: [{ messageId: "<wm.dlv_1.aa@example.com>", createdAt: T1 }],
    });

    const headers = await threadHeadersFor(tx, "tkt_abc");
    expect(headers.inReplyTo).toBe("<second@client.test>");
    expect(headers.references).toBe(
      "<first@client.test> <wm.dlv_1.aa@example.com> <second@client.test>",
    );
  });

  it("prefers Comment.inboundMessageId and still merges the receipts without duplicating an id", async () => {
    const { tx } = fakeTx({
      comments: [{ inboundMessageId: "only@client.test", createdAt: T0 }],
      receipts: [{ externalId: "<only@client.test>", receivedAt: T0 }],
    });

    const headers = await threadHeadersFor(tx, "tkt_abc");
    expect(headers.inReplyTo).toBe("<only@client.test>");
    expect(headers.references).toBe("<only@client.test>");
  });

  it("falls back to our own last delivery when the client has never written on the thread", async () => {
    const { tx } = fakeTx({
      deliveries: [
        { messageId: "<wm.dlv_1.aa@example.com>", createdAt: T0 },
        { messageId: "<wm.dlv_2.bb@example.com>", createdAt: T1 },
      ],
    });

    const headers = await threadHeadersFor(tx, "tkt_abc");
    expect(headers.inReplyTo).toBe("<wm.dlv_2.bb@example.com>");
  });

  it("never threads on a synthetic receipt key — that is a body hash, not a Message-ID", async () => {
    const { tx } = fakeTx({
      receipts: [{ externalId: `synthetic.${"a".repeat(64)}`, receivedAt: T0 }],
    });
    expect(await threadHeadersFor(tx, "tkt_abc")).toEqual({ inReplyTo: null, references: null });
  });

  it("writes the headers onto the delivery row and returns them from the enqueue", async () => {
    const { tx, rows } = fakeTx({ receipts: [{ externalId: "hello@client.test", receivedAt: T0 }] });
    await enqueueDelivery(tx, INPUT);
    expect(rows[0].inReplyTo).toBe("<hello@client.test>");
    expect(rows[0].references).toBe("<hello@client.test>");
  });
});

describe("trimReferences", () => {
  it("keeps the root and the tail once past the id ceiling", () => {
    const ids = Array.from({ length: REFERENCES_MAX_IDS + 5 }, (_, i) => `<id${i}@x.test>`);
    const trimmed = trimReferences(ids);
    const kept = (trimmed ?? "").split(" ");
    expect(kept).toHaveLength(REFERENCES_MAX_IDS);
    expect(kept[0]).toBe("<id0@x.test>");
    expect(kept[kept.length - 1]).toBe(ids[ids.length - 1]);
  });

  it("stays inside the character ceiling", () => {
    const long = `<${"a".repeat(300)}@x.test>`;
    const trimmed = trimReferences(Array.from({ length: 12 }, () => long)) ?? "";
    expect(trimmed.length).toBeLessThanOrEqual(REFERENCES_MAX_CHARS);
  });

  it("is null for an empty chain", () => {
    expect(trimReferences([])).toBeNull();
  });
});

describe("isDeliverableAddress", () => {
  it("accepts what enqueueDelivery accepts and refuses what it refuses", () => {
    expect(isDeliverableAddress("a@b.test")).toBe(true);
    expect(isDeliverableAddress(" A@B.TEST ")).toBe(true);
    expect(isDeliverableAddress("nope")).toBe(false);
    expect(isDeliverableAddress("a@b")).toBe(false);
    expect(isDeliverableAddress("<a@b.test>")).toBe(false);
    expect(isDeliverableAddress(null)).toBe(false);
    expect(isDeliverableAddress(undefined)).toBe(false);
  });
});
