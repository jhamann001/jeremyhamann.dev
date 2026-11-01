"use server";
/**
 * Attachment mutations.
 *
 * Three writes and one read, all through the shared action runner: zod → RBAC → sanitize → one
 * transaction whose LAST statement is the audit row.
 *
 *   createUploadIntent  mints a signed PUT URL and then reserves an `Attachment` row in state PENDING,
 *                       auditing the reservation in the same transaction. The row is permanent — the
 *                       DB trigger refuses DELETE and the app role has no DELETE grant — so it gets a
 *                       ledger entry like every other permanent row: `ATTACHMENT_ADDED` with
 *                       `null → PENDING`. See the deviation note in §"Audit" below.
 *   finalizeUpload      verifies the object exists and its size matches what the intent declared,
 *                       re-verifies the client's sha256 itself on the filesystem backend, flips
 *                       PENDING → READY and writes `ATTACHMENT_ADDED` in the same transaction.
 *   removeAttachment    soft-removes: READY → REMOVED with `ATTACHMENT_REMOVED`. Nothing is ever hard
 *                       deleted in v1 — not the row (the DB trigger refuses DELETE) and not the
 *                       object. "Remove" means "off the ticket", not "gone".
 *   listTicketAttachments  the panel's loader. No audit row (CONTRACT §3 rule 3: metadata is not
 *                       client material; the DOWNLOAD is the audited read).
 *
 * The object key is ALWAYS `attachmentObjectKey(ticketId, attachmentId)`. The uploaded filename is
 * display text: it is PII-sanitized, filename-sanitized, and never touches a path (the DB CHECK
 * `attachment_object_key_shape` is the third layer).
 *
 * Audit — a deviation from the catalog, recorded in the build record.
 * The catalog gives `ATTACHMENT_ADDED` one shape, `"state" / "PENDING" / "READY"`, written by
 * `finalizeUpload`. An attachment now produces TWO rows under that action and they are told apart by
 * `newValue`:
 *
 *   null → PENDING   the reservation (`createUploadIntent`), metadata `{stage: "intent", …}`
 *   PENDING → READY  the attachment itself (`finalizeUpload`), metadata `{stage: "ready", …}`
 *
 * The right answer is a distinct `ATTACHMENT_INTENT_CREATED` action, which needs `schema.prisma` and
 * `src/types/domain.ts` — shared files this slice does not own. The exact enum change is requested in
 * the integration notes; until it lands, the reservation is recorded rather than left invisible,
 * because the row it creates can never be deleted. Callers that count attachments must filter on
 * `newValue = 'READY'`; `listTicketActivity` does exactly that so the ticket timeline still shows one
 * line per attachment rather than one per file picker.
 *
 * Nothing here transmits anything. With `ATTACHMENTS_BUCKET` unset — which is the state of every
 * environment in this wave — the store is the local filesystem backend.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActionResult, AttachmentDTO, AuditEntry, QueueKey, TicketStatus } from "@/types/domain";
import { ATTACHMENT_MIME_ALLOWLIST, INGEST_LIMITS } from "@/types/domain";
import { actorFromViewer, writeAuditMany } from "@/lib/audit";
import { prisma, withTx } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { sanitizePII } from "@/lib/pii";
import { assertCan, canWriteAttachment } from "@/lib/rbac";
import { DEMO_UPLOADS_OFF, demoMode } from "@/lib/demo/mode";
import { safeEqualStrings } from "@/lib/safe-equal";
import { attachmentObjectKey, attachmentStore, sanitizeFilename } from "@/lib/storage";
import { runAction } from "@/server/action-utils";
import { ATTACHMENT_DTO_SELECT, listAttachments, toAttachmentDTO } from "@/server/attachments";
import { assertTicketNotClosed } from "@/server/tickets";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Same id shape as `src/server/validation.ts` and the DB CHECK on the object key. */
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");

/** Lower-case hex SHA-256. Upper case is refused rather than folded: the column stores one form. */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Invalid sha256");

const FILENAME_MAX_CHARS = 255;

const createUploadIntentSchema = z.object({
  ticketId: idSchema,
  filename: z.string().trim().min(1).max(FILENAME_MAX_CHARS),
  mime: z.enum(ATTACHMENT_MIME_ALLOWLIST),
  size: z.number().int().positive().max(INGEST_LIMITS.attachmentMaxBytes),
});

const finalizeUploadSchema = z.object({
  attachmentId: idSchema,
  sha256: sha256Schema.optional(),
});

const attachmentRefSchema = z.object({ attachmentId: idSchema });

const ticketRefSchema = z.object({ ticketId: idSchema });

export type CreateUploadIntentInput = { ticketId: string; filename: string; mime: string; size: number };
export type CreateUploadIntentResult = {
  attachmentId: string;
  uploadUrl: string;
  expiresAt: string;
  objectKey: string;
};

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

type TicketForAttachment = { id: string; status: TicketStatus; queueId: string; queue: { key: QueueKey } };

async function loadTicketForAttachment(ticketId: string): Promise<TicketForAttachment> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, status: true, queueId: true, queue: { select: { key: true } } },
  });
  if (!ticket) throw new NotFoundError("Ticket not found");
  return ticket;
}

type AttachmentForMutation = {
  id: string;
  ticketId: string;
  state: AttachmentDTO["state"];
  size: number;
  objectKey: string;
  ticket: TicketForAttachment;
};

async function loadAttachmentForMutation(attachmentId: string): Promise<AttachmentForMutation> {
  const row = await prisma.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      id: true,
      ticketId: true,
      state: true,
      size: true,
      objectKey: true,
      ticket: { select: { id: true, status: true, queueId: true, queue: { select: { key: true } } } },
    },
  });
  if (!row) throw new NotFoundError("Attachment not found");
  return row;
}

/**
 * A fresh attachment id. Generated in the app rather than by `@default(cuid())` because the object
 * key is `<ticketId>/<attachmentId>` and the signed upload URL has to be minted for that exact key
 * in the same call that creates the row. URL-safe hex, so it satisfies the DB CHECK by construction.
 */
function newAttachmentId(): string {
  return `att_${randomUUID().replace(/-/g, "")}`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Reserves an attachment and returns a short-lived signed PUT URL the browser uploads to directly.
 *
 * RBAC is `attachment:write` — WRITE on the ticket's queue, the same bar as a public reply, so
 * `compliance_officers` (read-plus-annotate) never uploads. CLOSED tickets refuse: §b.9 makes a
 * closed record annotate-only for everyone.
 *
 * The declared mime must be in the nine-type non-executable allowlist and the declared size must be
 * within 25 MiB. Both are signed INTO the upload URL as well (`content-type` and
 * `x-goog-content-length-range`), so a client that lies about either is refused by the storage
 * backend rather than by us after the bytes have landed. The signed range is THIS intent's declared
 * size, not the global 25 MiB ceiling: signing the ceiling would let a 4 KB intent park 25 MiB of
 * unverifiable bytes in a books-and-records bucket under a PENDING row no surface ever shows, and
 * `finalizeUpload`'s size check would refuse them only after they had landed.
 *
 * Order matters. The URL is minted BEFORE the row is written, and the row is written with its audit
 * entry inside one transaction. A signing failure (metadata-server hiccup, a `signBlob` 403) then
 * leaves nothing behind, and no `Attachment` row — a row nothing can ever delete — exists without a
 * ledger entry naming who reserved it.
 */
export async function createUploadIntent(
  input: CreateUploadIntentInput,
): Promise<ActionResult<CreateUploadIntentResult>> {
  return runAction("createUploadIntent", async (viewer, ctx) => {
    // The demo serves only its seeded files: a visitor's upload would be a stranger's file on a shared desk.
    if (demoMode()) {
      throw new ValidationError("Uploads are off in this demo", { file: [DEMO_UPLOADS_OFF] });
    }
    const parsed = createUploadIntentSchema.parse(input);
    const ticket = await loadTicketForAttachment(parsed.ticketId);
    assertCan(canWriteAttachment(viewer.groups, ticket.queue.key), "attachment:write", ticket.id);
    assertTicketNotClosed(ticket);

    // The filename is free text from a client machine: PII-sanitize it like every other stored free
    // text, then strip anything that could act as a path or break a header. It is display text
    // only — the object key below is derived from ids.
    const filename = sanitizeFilename(sanitizePII(parsed.filename).text);

    const attachmentId = newAttachmentId();
    const objectKey = attachmentObjectKey(ticket.id, attachmentId);
    const store = attachmentStore();

    // `parsed.size` is already ≤ the cap (the zod schema refuses more), so the min is belt-and-braces
    // against a future caller that builds the input by hand.
    const signed = await store.signedPutUrl(objectKey, {
      contentType: parsed.mime,
      maxBytes: Math.min(parsed.size, INGEST_LIMITS.attachmentMaxBytes),
    });

    const actor = actorFromViewer(viewer);

    await withTx(async (tx) => {
      await tx.attachment.create({
        data: {
          id: attachmentId,
          ticketId: ticket.id,
          uploaderId: viewer.id,
          kind: "UPLOAD",
          filename,
          mime: parsed.mime,
          size: parsed.size,
          objectKey,
          state: "PENDING",
          visibility: "INTERNAL",
        },
        select: { id: true },
      });

      const entries: AuditEntry[] = [
        {
          // Wave B landed the dedicated enum value this row was borrowing: the
          // RESERVATION is `ATTACHMENT_INTENT_CREATED`, the file ARRIVING is `ATTACHMENT_ADDED`. A CSV
          // reader can now filter on the action instead of on `metadata.stage`. `stage` stays on the
          // metadata so the rows written before this change still read the same way.
          action: "ATTACHMENT_INTENT_CREATED",
          entityType: "ATTACHMENT",
          entityId: attachmentId,
          ticketId: ticket.id,
          fieldChanged: "state",
          oldValue: null,
          newValue: "PENDING",
          metadata: {
            stage: "intent",
            filename,
            mime: parsed.mime,
            size: parsed.size,
            backend: store.backend,
          },
        },
      ];
      await writeAuditMany(tx, actor, ctx, entries);
    });

    return { attachmentId, uploadUrl: signed.url, expiresAt: signed.expiresAt, objectKey };
  });
}

/**
 * Turns a completed upload into an attachment: PENDING → READY, audited in the same transaction.
 *
 * The object is verified before the flip — it must exist and its size must equal what the intent
 * declared. On the filesystem backend the digest is verified server-side (the bytes are re-read and
 * hashed), a client-supplied sha256 that disagrees is refused, and the proven digest is stored in
 * `Attachment.sha256`. On GCS there is no sha256 to read back (the API publishes md5/crc32c), so the
 * column stays NULL and the browser's claim is recorded only in the audit row
 * (`sha256Claimed` + `sha256Verified: false`). The integrity column never holds an unproven value.
 */
export async function finalizeUpload(input: {
  attachmentId: string;
  sha256?: string;
}): Promise<ActionResult<AttachmentDTO>> {
  return runAction("finalizeUpload", async (viewer, ctx) => {
    const parsed = finalizeUploadSchema.parse(input);
    const row = await loadAttachmentForMutation(parsed.attachmentId);
    assertCan(canWriteAttachment(viewer.groups, row.ticket.queue.key), "attachment:write", row.ticketId);
    assertTicketNotClosed(row.ticket);
    if (row.state !== "PENDING") throw new ConflictError("This upload has already been finalized");

    const store = attachmentStore();
    const head = await store.head(row.objectKey);
    if (!head.exists) {
      throw new ValidationError("The uploaded file was not found in storage", {
        attachmentId: ["Upload the file again — nothing arrived in storage for this attachment"],
      });
    }
    if (head.size !== row.size) {
      throw new ValidationError("The uploaded file does not match the declared size", {
        attachmentId: [`Expected ${row.size} bytes, found ${head.size}`],
      });
    }
    if (head.size > INGEST_LIMITS.attachmentMaxBytes) {
      throw new ValidationError("The uploaded file is larger than the 25 MB limit");
    }

    // `Attachment.sha256` is the integrity column on an append-only, books-and-records table, so it
    // holds ONLY a digest this server computed over the stored bytes. The filesystem backend re-reads
    // the object and hashes it, so `head.sha256` is proof. GCS publishes md5/crc32c and never a
    // sha256, so `head.sha256` is null there — and the column stays null rather than being filled
    // with the uploader's own claim. A reconciliation that re-hashes the object and compares it to
    // this column would otherwise be confirming a value the uploader chose, and a reader of the table
    // (or of the `attachments.ndjson` the duplicate-copy job writes, whose select carries this
    // column) could not tell a proven digest from a claimed one without joining back to the ledger.
    //
    // The browser's claim is not thrown away: it goes into the audit row as `sha256Claimed`, beside
    // `sha256Verified`, where its provenance is unambiguous. Making the COLUMN self-describing needs a
    // `sha256Verified Boolean` beside it in `schema.prisma` — requested in
    // the build record, which this slice does not own.
    const sha256 = head.sha256;
    const verified = sha256 !== null;
    // `safeEqualStrings` rather than `!==` (CWE-208): `parsed.sha256` came off the wire and `sha256`
    // is the digest the server proved for itself. Both are lower-case hex of a fixed length
    // (`sha256Schema` on one side, the store on the other), so the constant-time compare accepts and
    // refuses exactly the same pairs the operator did.
    if (sha256 !== null && parsed.sha256 !== undefined && !safeEqualStrings(parsed.sha256, sha256)) {
      throw new ValidationError("The uploaded file does not match the checksum the browser computed", {
        sha256: ["The file changed in transit — upload it again"],
      });
    }
    const actor = actorFromViewer(viewer);
    const readyAt = new Date();

    return withTx(async (tx) => {
      // Conditional transition: exactly one caller can move PENDING → READY, so a double
      // submit cannot produce two ATTACHMENT_ADDED rows for one file.
      const flipped = await tx.attachment.updateMany({
        where: { id: row.id, state: "PENDING" },
        data: { state: "READY", readyAt, sha256 },
      });
      if (flipped.count === 0) throw new ConflictError("This upload has already been finalized");

      const stored = await tx.attachment.findUniqueOrThrow({
        where: { id: row.id },
        select: ATTACHMENT_DTO_SELECT,
      });

      const entries: AuditEntry[] = [
        {
          action: "ATTACHMENT_ADDED",
          entityType: "ATTACHMENT",
          entityId: row.id,
          ticketId: row.ticketId,
          fieldChanged: "state",
          oldValue: "PENDING",
          newValue: "READY",
          metadata: {
            stage: "ready",
            filename: stored.filename,
            mime: stored.mime,
            size: stored.size,
            // `sha256Verified: false` means the column is null and the only digest anyone has is the
            // one the uploader sent, recorded here as a claim and nowhere else.
            sha256Verified: verified,
            ...(parsed.sha256 !== undefined ? { sha256Claimed: parsed.sha256 } : {}),
            backend: store.backend,
          },
        },
      ];
      await writeAuditMany(tx, actor, ctx, entries);

      return toAttachmentDTO(stored);
    });
  });
}

/**
 * Takes an attachment off the ticket. READY → REMOVED, audited in the same transaction.
 *
 * It is a SOFT remove and that is the point: the row survives (the DB trigger refuses DELETE on this
 * table) and the stored object survives, so a books-and-records request can still find what was once
 * on the ticket and who removed it. Nothing in v1 hard-deletes an attachment.
 */
export async function removeAttachment(input: { attachmentId: string }): Promise<ActionResult<{ id: string }>> {
  return runAction("removeAttachment", async (viewer, ctx) => {
    const parsed = attachmentRefSchema.parse(input);
    const row = await loadAttachmentForMutation(parsed.attachmentId);
    assertCan(canWriteAttachment(viewer.groups, row.ticket.queue.key), "attachment:write", row.ticketId);
    assertTicketNotClosed(row.ticket);
    if (row.state !== "READY") throw new ConflictError("This attachment is not on the ticket");

    const actor = actorFromViewer(viewer);
    const removedAt = new Date();

    return withTx(async (tx) => {
      const removed = await tx.attachment.updateMany({
        where: { id: row.id, state: "READY" },
        data: { state: "REMOVED", removedAt, removedById: viewer.id },
      });
      if (removed.count === 0) throw new ConflictError("This attachment is not on the ticket");

      const entries: AuditEntry[] = [
        {
          action: "ATTACHMENT_REMOVED",
          entityType: "ATTACHMENT",
          entityId: row.id,
          ticketId: row.ticketId,
          fieldChanged: "state",
          oldValue: "READY",
          newValue: "REMOVED",
        },
      ];
      await writeAuditMany(tx, actor, ctx, entries);

      return { id: row.id };
    });
  });
}

/**
 * The attachments panel's loader.
 *
 * Why an action and not a direct import of `listAttachments`: guardrail G1 treats everything under
 * `src/components/**` as a client surface and forbids it from importing a non-`.actions` server
 * module, and the panel is an async server component that lives there (CONTRACT §9 fixes its
 * location and props). This wrapper is the G1-clean seam — it re-authenticates through the action
 * runner and delegates straight to `listAttachments`, which stays exported with the contract's
 * signature for every other caller. Recorded as a deviation in the integration notes.
 */
export async function listTicketAttachments(input: { ticketId: string }): Promise<ActionResult<AttachmentDTO[]>> {
  return runAction("listTicketAttachments", async (viewer) => {
    const parsed = ticketRefSchema.parse(input);
    return listAttachments(viewer, parsed.ticketId);
  });
}
