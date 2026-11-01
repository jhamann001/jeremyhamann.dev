/**
 * Historical ticket import — node, layer L4.
 *
 * `importTicketCore` is the ONE write path for a ticket that already happened somewhere else. It is a
 * sibling of `createTicketCore` (src/server/ingest.ts), not a caller of it, because a backfill and an
 * arrival are different facts and the differences are all load-bearing:
 *
 *  - **The clock is the original one.** `createdAt`, `updatedAt`, `firstRespondedAt`, `resolvedAt` and
 *    `closedAt` are the values the source system recorded. `createTicketCore` stamps `now()` and a NEW
 *    status; an imported ticket that claimed to have arrived at import time would make every report,
 *    every SLA number and every retention calculation wrong on the day of cutover.
 *  - **Nothing fires.** No auto-acknowledgement, no auto-assignment, no notification, no outbox row.
 *    Importing four hundred tickets must not send four hundred clients an acknowledgement of a message
 *    they sent months ago; a backfill is a write to the ledger, not an event on the desk.
 *  - **Comments come with it.** A ticket without its correspondence is not the record — so the comments
 *    and their attachments are written in the SAME transaction as the ticket, and a partial import is
 *    not a state this module can leave behind (attachment BYTES are the one exception, below).
 *
 * What it shares with the ingest cores, because these are properties of the desk and not of a channel:
 *
 *  - **`sanitizePII` on every free-text field before any Prisma write**. The legacy help desk archive holds
 *    unredacted client NPI — legacy help desk never masked an SSN or an account number — and the desk must not
 *    acquire a second unredacted copy of it. The audit row records COUNTS, never the redacted values.
 *
 *    THIS IS THE BULK PATH, AND DECISION #116 CHANGED WHAT IT LANDS. the build record
 *    names what the archive holds in plain text: SSNs, bank account and routing numbers, brokerage
 *    account numbers, dates of birth and home addresses. Two of those five (routing numbers, dates of
 *    birth) are no longer redaction targets, so a one-off five-year whole-book backfill will now write
 *    them into the desk database — at import volume rather than at typing volume, and from there into
 *    the append-only audit ledger and its nightly retention-locked copy. Nothing is backfilled and
 *    there is no post-hoc redaction, so the import is a one-way door: the rule set in force on the day
 *    it RUNS is the rule set the imported corpus is minimised under, permanently. Decision #116 records
 *    that this was accepted rather than sequenced. If the archive should ever be minimised more
 *    aggressively than live tickets, this module is a distinct entry point and can take its own
 *    sanitizer configuration without re-widening the desk's.
 *  - **Idempotency is a row, not a guess.** `(source, externalId)` is unique on `IngestReceipt` and on
 *    `Ticket`, and the receipt is written in the same transaction. A re-run, a `--since` straggler pass
 *    and a resumed batch all return the same ids with `created: false` — never a second copy of a
 *    client's correspondence.
 *  - **`writeAuditMany` is the LAST statement of the transaction** (§3 rule 2), and every row carries
 *    `metadata.via = "import"` (§3 rule 1), so a backfilled row can never be mistaken for a live one.
 *
 * CONTRACT-GAPs, both recorded in the build record:
 *  1. `ImportTicketInput` (src/types/domain.ts) carries no `resolution`, no compliance flags and no
 *     brand, yet §10 B11 requires the importer to map "resolution and compliance flags". The input type
 *     here is `ImportTicketInput & ImportTicketExtras` — a WIDENING, so the contract's own type is still
 *     assignable and the published signature still holds.
 *  2. The contract's signature is `(input, call)`. Attachment bytes cannot be read from the archive by a
 *     module that knows nothing about the archive, so a third, OPTIONAL parameter carries the reader and
 *     the destination store. Omitting it imports the ticket and its comments and records the attachments
 *     as skipped, which is exactly what `--dry-run` and a metadata-only rehearsal want.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  ATTACHMENT_MIME_ALLOWLIST,
  ESCALATION_TARGETS,
  INGEST_LIMITS,
  PII_KINDS,
  QUEUE_KEYS,
  TICKET_BRANDS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_RESOLUTIONS,
  TICKET_STATUSES,
} from "@/types/domain";
import type {
  AuditEntry,
  EscalationTarget,
  ImportResult,
  ImportTicketInput,
  PiiKind,
  TicketBrand,
  TicketResolution,
} from "@/types/domain";
import { AUDIT_VIA, writeAuditMany } from "@/lib/audit";
import type { DbTx } from "@/lib/db";
import { prisma, withTx } from "@/lib/db";
import { AppError, ValidationError } from "@/lib/errors";
import { INTEGRATION_ACTOR_ID } from "@/lib/integration-auth";
import { formatPiiCounts, sanitizeFields, sanitizePII } from "@/lib/pii";
import { computeDueDates, slaPolicyFor } from "@/lib/sla";
import { attachmentObjectKey, attachmentStore, sanitizeFilename } from "@/lib/storage";
import type { ObjectStore } from "@/lib/storage";
import { findIngestReceipt, INGEST_OUTCOMES, truncateBody, truncateSubject } from "@/server/ingest";
import type { IngestCallContext } from "@/server/ingest";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** Every imported ticket's `externalId` is `zd:<legacyDesk ticket id>`; §10 B11 fixes the spelling. */
export const IMPORT_EXTERNAL_ID_PREFIX = "zd:" as const;

/** `zd:<id>` for a legacy help desk ticket id. The one place the prefix is spelled. */
export function legacyDeskExternalId(legacyDeskTicketId: string | number): string {
  return `${IMPORT_EXTERNAL_ID_PREFIX}${String(legacyDeskTicketId).trim()}`;
}

/**
 * Prefix on a comment whose legacy help desk author could not be resolved to a `User` row.
 *
 * The row is SYSTEM-authored (the DB CHECK `comment_staff_has_author` means a STAFF row must name a
 * real user, and inventing one would put words in a named person's mouth), but a reader of the record
 * still has to be able to see who wrote it — "System" where a departed agent replied to a client is a
 * record that misleads. So the original name travels in the stored body as a code-written prefix, the
 * same way a disclaimer and the truncation note are code-written parts of a stored body, AND on the
 * `TICKET_IMPORTED` audit row. Recommended default, pending confirmation.
 */
export const IMPORT_AUTHOR_PREFIX = "Imported — originally written by" as const;

/** The attribution line for an unresolved author, above the original body. */
export function formatImportedAuthorNote(authorName: string, body: string): string {
  return `_${IMPORT_AUTHOR_PREFIX} ${authorName}._\n\n${body}`;
}

/**
 * The fields §10 B11 requires and `ImportTicketInput` does not carry (CONTRACT-GAP 1 above).
 * All optional: an archive that cannot answer one of them omits it rather than guessing.
 */
export type ImportTicketExtras = {
  resolution?: TicketResolution;
  isComplaint?: boolean;
  complaintFiledAt?: string | null;
  escalationTarget?: EscalationTarget;
  brand?: TicketBrand;
  householdId?: string | null;
  requesterExternalId?: string | null;
  followUpAt?: string | null;
};

export type ImportTicketCoreInput = ImportTicketInput & ImportTicketExtras;

/** How an imported attachment's bytes reach the desk's own object store. */
export type ImportOptions = {
  /**
   * Reads one attachment from the archive by the `sourcePath` the manifest recorded. Omitted → the
   * attachment ROWS are not written at all and `attachments: 0` comes back: a PENDING row whose bytes
   * nobody ever intends to fetch is a permanent, unexplained row in a books-and-records table.
   */
  readAttachment?: (sourcePath: string) => Promise<Uint8Array>;
  /** Destination. Defaults to the app's attachment store. */
  store?: ObjectStore;
};

// ---------------------------------------------------------------------------
// Validation (zod 4). Mirrors the DB CHECKs so a bad row is a 422 naming the field, not a 500.
// ---------------------------------------------------------------------------

const BODY_HARD_MAX = 400_000;
const SUBJECT_HARD_MAX = 2_000;
const REQUESTER_NAME_MAX = 120;
const CLIENT_REFERENCE_MAX = 200;
const EXTERNAL_REF_MAX = 200;
const EXTERNAL_ID_MAX = 512;
const AUTHOR_NAME_MAX = 120;

const emailSchema = z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.email().toLowerCase());
const phoneSchema = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Phone must be E.164, e.g. +14155550123");
const pointerSchema = z.string().trim().min(1).max(128);
const isoSchema = z
  .string()
  .trim()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Expected an ISO-8601 timestamp" });

const externalIdSchema = z
  .string()
  .trim()
  .min(IMPORT_EXTERNAL_ID_PREFIX.length + 1)
  .max(EXTERNAL_ID_MAX)
  .refine((s) => s.startsWith(IMPORT_EXTERNAL_ID_PREFIX), {
    message: `externalId must start with "${IMPORT_EXTERNAL_ID_PREFIX}"`,
  });

const importCommentSchema = z
  .object({
    externalId: z.string().trim().min(1).max(EXTERNAL_ID_MAX),
    authorKind: z.enum(["REQUESTER", "STAFF", "SYSTEM"]),
    authorEmail: emailSchema.nullable().optional(),
    authorName: z.string().trim().max(AUTHOR_NAME_MAX).nullable().optional(),
    visibility: z.enum(["INTERNAL", "PUBLIC"]),
    body: z.string().min(1).max(BODY_HARD_MAX),
    createdAt: isoSchema,
  })
  // I7 in reverse: a requester's own words are never an internal note, whatever the source system said.
  .refine((c) => c.authorKind !== "REQUESTER" || c.visibility === "PUBLIC", {
    message: "A requester-authored comment is always PUBLIC",
    path: ["visibility"],
  });

const importAttachmentSchema = z.object({
  externalId: z.string().trim().min(1).max(EXTERNAL_ID_MAX),
  filename: z.string().trim().min(1).max(400),
  mime: z.string().trim().min(1).max(200),
  size: z.number().int().min(0).max(INGEST_LIMITS.attachmentMaxBytes),
  sourcePath: z.string().trim().min(1).max(1024),
  /** Which comment the attachment hung off, by its legacy help desk id. Null → the ticket itself. */
  commentExternalId: z.string().trim().min(1).max(EXTERNAL_ID_MAX).nullable().optional(),
});

export const importTicketSchema = z
  .object({
    externalId: externalIdSchema,
    subject: z.string().trim().min(1).max(SUBJECT_HARD_MAX),
    description: z.string().min(1).max(BODY_HARD_MAX),
    category: z.enum(TICKET_CATEGORIES),
    priority: z.enum(TICKET_PRIORITIES),
    status: z.enum(TICKET_STATUSES),
    queueKey: z.enum(QUEUE_KEYS),
    requesterName: z.string().trim().min(1).max(REQUESTER_NAME_MAX),
    requesterEmail: emailSchema.nullable().optional(),
    requesterPhone: phoneSchema.nullable().optional(),
    createdAt: isoSchema,
    updatedAt: isoSchema.nullable().optional(),
    firstRespondedAt: isoSchema.nullable().optional(),
    resolvedAt: isoSchema.nullable().optional(),
    closedAt: isoSchema.nullable().optional(),
    externalRef: z.string().trim().max(EXTERNAL_REF_MAX).nullable().optional(),
    clientReference: z.string().trim().max(CLIENT_REFERENCE_MAX).nullable().optional(),
    comments: z.array(importCommentSchema).max(2_000),
    attachments: z.array(importAttachmentSchema).max(500).optional(),
    // --- the widening (CONTRACT-GAP 1) ---
    resolution: z.enum(TICKET_RESOLUTIONS).optional(),
    isComplaint: z.boolean().optional(),
    complaintFiledAt: isoSchema.nullable().optional(),
    escalationTarget: z.enum(ESCALATION_TARGETS).optional(),
    brand: z.enum(TICKET_BRANDS).optional(),
    householdId: pointerSchema.nullable().optional(),
    requesterExternalId: pointerSchema.nullable().optional(),
    followUpAt: isoSchema.nullable().optional(),
  })
  // The DB CHECK `ticket_requester_contact_present`, restated so the caller is told which field.
  .refine((v) => (v.requesterEmail ?? null) !== null || (v.requesterPhone ?? null) !== null, {
    message: "At least one of requesterEmail or requesterPhone is required",
    path: ["requesterEmail"],
  })
  // VOIDED needs the void triple, which an import has no way to supply. §2: it is not a transition.
  .refine((v) => v.status !== "VOIDED", {
    message: "VOIDED cannot be imported: voiding is a deliberate act with a recorded reason (Decision #96)",
    path: ["status"],
  });

export type ParsedImportTicket = z.output<typeof importTicketSchema>;

// ---------------------------------------------------------------------------
// Pure helpers — exported because the CLI reports on them before it writes anything
// ---------------------------------------------------------------------------

/**
 * How one imported comment is authored, given the desk's `User` rows.
 *
 * STAFF is only possible when the archive's author email resolves to a real, existing user. Everything
 * else lands as SYSTEM with the original name in the body prefix and on the audit row: a STAFF row with
 * an invented author would attribute a client-facing reply to whoever happened to share a name, and a
 * STAFF row with no author violates `comment_staff_has_author`.
 */
export function resolveImportAuthor(
  comment: { authorKind: "REQUESTER" | "STAFF" | "SYSTEM"; authorEmail?: string | null; authorName?: string | null },
  usersByEmail: ReadonlyMap<string, string>,
): { authorKind: "REQUESTER" | "STAFF" | "SYSTEM"; authorId: string | null; unresolvedName: string | null } {
  if (comment.authorKind === "REQUESTER") return { authorKind: "REQUESTER", authorId: null, unresolvedName: null };
  const email = (comment.authorEmail ?? "").trim().toLowerCase();
  const id = email === "" ? undefined : usersByEmail.get(email);
  if (comment.authorKind === "STAFF" && id !== undefined) {
    return { authorKind: "STAFF", authorId: id, unresolvedName: null };
  }
  const name = (comment.authorName ?? "").trim();
  return { authorKind: "SYSTEM", authorId: null, unresolvedName: name === "" ? null : name };
}

/** An attachment the desk will not store, and why. v1 is INTERNAL-only and MIME-allowlisted (#69). */
export function attachmentRejection(a: { mime: string; size: number }): string | null {
  if (!(ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(a.mime)) return "mime-not-allowed";
  if (a.size > INGEST_LIMITS.attachmentMaxBytes) return "too-large";
  return null;
}

function emptyToNull(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
}

function dateOrNull(v: string | null | undefined): Date | null {
  return v === null || v === undefined ? null : new Date(v);
}

/** An object-key segment: the same shape `persistAttachmentParts` mints (UUID without its dashes). */
function newRecordId(): string {
  return randomUUID().replaceAll("-", "");
}

/**
 * `Ticket.createdById` is a required FK and the importer is a machine caller. A named actor owns the
 * row when the caller has one; otherwise the desk's integration identity does, exactly as the ingest
 * cores resolve it.
 */
async function resolveCreatorId(tx: DbTx, actorId: string | null): Promise<string> {
  if (actorId !== null) return actorId;
  const fallback = await tx.user.findUnique({ where: { id: INTEGRATION_ACTOR_ID }, select: { id: true } });
  if (fallback === null) throw new AppError("INTERNAL", "integration actor is not provisioned", 500);
  return fallback.id;
}

/** The answer a replay gives: the ids that already exist, with `created: false` and the stored counts. */
async function replayResult(ticketId: string): Promise<ImportResult> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, number: true, _count: { select: { comments: true, attachments: true } } },
  });
  if (ticket === null) throw new AppError("INTERNAL", "import receipt points at a missing ticket", 500);
  return {
    ticketId: ticket.id,
    ticketNumber: ticket.number,
    created: false,
    comments: ticket._count.comments,
    attachments: ticket._count.attachments,
  };
}

// ---------------------------------------------------------------------------
// importTicketCore
// ---------------------------------------------------------------------------

/**
 * Import one historical ticket with its comments and attachments. Idempotent on `(IMPORT, externalId)`.
 *
 * The SLA snapshot is computed from the policy in force TODAY against the ticket's ORIGINAL creation
 * time, so an imported ticket's clock reads the same as it would have read on the source system. For
 * an already-closed ticket that is bookkeeping; for an in-flight one it is the point — the desk shows
 * the true age of the request rather than pretending it arrived at cutover. (Recommended default; the
 * alternative, restarting every clock at import, is in the integration notes.)
 */
export async function importTicketCore(
  input: ImportTicketCoreInput,
  call: IngestCallContext,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const data = importTicketSchema.parse(input);

  // §3 rule 1. A backfilled row that is indistinguishable from a live one is the failure this labels
  // away, so the label is a precondition rather than a decoration the caller may forget.
  if (call.via !== AUDIT_VIA.import) {
    throw new ValidationError(`importTicketCore requires via="${AUDIT_VIA.import}"`);
  }

  const existing = await findIngestReceipt("IMPORT", data.externalId);
  if (existing !== null && existing.ticketId !== null) return replayResult(existing.ticketId);

  // Cut to the stored caps BEFORE sanitizing, so a redaction token can never be cut in half.
  const subjectRaw = truncateSubject(data.subject);
  const bodyRaw = truncateBody(data.description);

  // I4. Contact data (email, phone) is validated, not redacted — by definition not a redaction target.
  const s = sanitizeFields({
    subject: subjectRaw,
    description: bodyRaw.body,
    clientReference: data.clientReference ?? null,
    requesterName: data.requesterName,
    externalRef: data.externalRef ?? null,
  });
  const subject = s.values.subject ?? subjectRaw;
  const description = s.values.description ?? bodyRaw.body;

  // Staff authors, resolved once for the whole ticket. Inactive users still resolve: the person who
  // wrote the reply in 2024 may well have left, and the record is about who wrote it, not who is here.
  const authorEmails = Array.from(
    new Set(
      data.comments
        .map((c) => (c.authorEmail ?? "").trim().toLowerCase())
        .filter((e) => e.length > 0),
    ),
  );
  const users =
    authorEmails.length === 0
      ? []
      : await prisma.user.findMany({ where: { email: { in: authorEmails } }, select: { id: true, email: true } });
  const usersByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  // --- plan the comments -------------------------------------------------------------------------
  type PlannedComment = {
    id: string;
    externalId: string;
    authorId: string | null;
    authorKind: "REQUESTER" | "STAFF" | "SYSTEM";
    visibility: "INTERNAL" | "PUBLIC";
    body: string;
    createdAt: Date;
    piiRedacted: boolean;
    piiCount: number;
    unresolvedName: string | null;
  };

  // The redaction tally spans the ticket's own fields AND every comment body: the SSN legacy help desk never
  // masked is far more often in a reply than in the description, and a `PII_REDACTED` row that
  // reported `SSN=0` beside a non-zero count would be worse than no row at all.
  let piiCount = s.count;
  const piiByKind: Partial<Record<PiiKind, number>> = {};
  const addKinds = (byKind: Partial<Record<PiiKind, number>>): void => {
    for (const kind of PII_KINDS) piiByKind[kind] = (piiByKind[kind] ?? 0) + (byKind[kind] ?? 0);
  };
  addKinds(s.byKind);
  const redactedComments: string[] = [];
  const unresolvedAuthors: string[] = [];
  const plannedComments: PlannedComment[] = data.comments.map((c) => {
    const author = resolveImportAuthor(c, usersByEmail);
    const cut = truncateBody(c.body);
    const clean = sanitizePII(cut.body);
    piiCount += clean.count;
    if (clean.redacted) {
      addKinds(clean.byKind);
      redactedComments.push(c.externalId);
    }
    if (author.unresolvedName !== null) unresolvedAuthors.push(author.unresolvedName);
    const named =
      author.unresolvedName === null
        ? clean.text
        : formatImportedAuthorNote(sanitizePII(author.unresolvedName).text, clean.text);
    return {
      id: newRecordId(),
      externalId: c.externalId,
      authorId: author.authorId,
      authorKind: author.authorKind,
      visibility: c.visibility,
      body: named,
      createdAt: new Date(c.createdAt),
      piiRedacted: clean.redacted,
      piiCount: clean.count,
      unresolvedName: author.unresolvedName,
    };
  });
  const commentIdByExternalId = new Map(plannedComments.map((c) => [c.externalId, c.id]));

  // --- plan the attachments ----------------------------------------------------------------------
  type PlannedAttachment = {
    id: string;
    commentId: string | null;
    filename: string;
    mime: string;
    sourcePath: string;
    bytes: Uint8Array;
  };
  const plannedAttachments: PlannedAttachment[] = [];
  const skippedAttachments: Array<{ externalId: string; reason: string }> = [];
  if (options.readAttachment) {
    for (const a of data.attachments ?? []) {
      const rejection = attachmentRejection(a);
      if (rejection !== null) {
        skippedAttachments.push({ externalId: a.externalId, reason: rejection });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await options.readAttachment(a.sourcePath);
      } catch {
        // The archive could not produce the object. The ticket and its words are the record and must
        // not be lost over a missing file; the skip is reported and the re-run can pick it up.
        skippedAttachments.push({ externalId: a.externalId, reason: "unreadable" });
        continue;
      }
      if (bytes.byteLength > INGEST_LIMITS.attachmentMaxBytes) {
        skippedAttachments.push({ externalId: a.externalId, reason: "too-large" });
        continue;
      }
      plannedAttachments.push({
        id: newRecordId(),
        commentId: a.commentExternalId ? (commentIdByExternalId.get(a.commentExternalId) ?? null) : null,
        filename: sanitizeFilename(sanitizePII(a.filename).text),
        mime: a.mime,
        sourcePath: a.sourcePath,
        bytes,
      });
    }
  } else {
    for (const a of data.attachments ?? []) skippedAttachments.push({ externalId: a.externalId, reason: "no-reader" });
  }

  const originalCreatedAt = new Date(data.createdAt);
  const metadata: Prisma.InputJsonObject = {
    via: AUDIT_VIA.import,
    source: "IMPORT",
    externalId: data.externalId,
  };

  const result = await withTx(async (tx) => {
    const queue = await tx.queue.findUnique({ where: { key: data.queueKey }, select: { id: true } });
    if (queue === null) throw new AppError("INTERNAL", `queue ${data.queueKey} is not provisioned`, 500);

    const policy = slaPolicyFor(data.priority, await tx.sLA.findUnique({ where: { priority: data.priority } }));
    const due = computeDueDates(originalCreatedAt, policy);
    const createdById = await resolveCreatorId(tx, call.actor.id);

    const ticket = await tx.ticket.create({
      data: {
        subject,
        description,
        clientReference: emptyToNull(s.values.clientReference),
        requesterName: s.values.requesterName ?? data.requesterName,
        requesterEmail: data.requesterEmail ?? null,
        requesterPhone: data.requesterPhone ?? null,
        brand: data.brand ?? "CEDAR_RIDGE_WEALTH",
        source: "IMPORT",
        externalId: data.externalId,
        householdId: data.householdId ?? null,
        requesterExternalId: data.requesterExternalId ?? null,
        externalRef: emptyToNull(s.values.externalRef),
        isComplaint: data.isComplaint ?? false,
        complaintFiledAt: dateOrNull(data.complaintFiledAt) ?? (data.isComplaint === true ? originalCreatedAt : null),
        escalationTarget: data.escalationTarget ?? "NONE",
        followUpAt: dateOrNull(data.followUpAt),
        resolution: data.resolution ?? "NONE",
        category: data.category,
        priority: data.priority,
        status: data.status,
        queueId: queue.id,
        createdById,
        assigneeId: null,
        slaFirstResponseMinutes: policy.firstResponseMinutes,
        slaResolutionMinutes: policy.resolutionMinutes,
        firstResponseDueAt: due.firstResponseDueAt,
        resolutionDueAt: due.resolutionDueAt,
        firstRespondedAt: dateOrNull(data.firstRespondedAt),
        resolvedAt: dateOrNull(data.resolvedAt),
        closedAt: dateOrNull(data.closedAt),
        piiRedacted: piiCount > 0,
        piiRedactionCount: piiCount,
        // The original clock (both columns are explicit; `@updatedAt` only fills what a write omits).
        createdAt: originalCreatedAt,
        updatedAt: dateOrNull(data.updatedAt) ?? originalCreatedAt,
      },
      select: { id: true, number: true },
    });

    if (plannedComments.length > 0) {
      await tx.comment.createMany({
        data: plannedComments.map((c) => ({
          id: c.id,
          ticketId: ticket.id,
          authorId: c.authorId,
          authorKind: c.authorKind,
          visibility: c.visibility,
          body: c.body,
          disclaimerKey: "NONE" as const,
          piiRedacted: c.piiRedacted,
          piiRedactionCount: c.piiCount,
          createdAt: c.createdAt,
        })),
      });
    }

    if (plannedAttachments.length > 0) {
      await tx.attachment.createMany({
        data: plannedAttachments.map((a) => ({
          id: a.id,
          ticketId: ticket.id,
          commentId: a.commentId,
          uploaderId: null,
          kind: "SYSTEM" as const,
          filename: a.filename,
          mime: a.mime,
          size: a.bytes.byteLength,
          objectKey: attachmentObjectKey(ticket.id, a.id),
          state: "PENDING" as const,
          createdAt: originalCreatedAt,
        })),
      });
    }

    await tx.ingestReceipt.create({
      data: {
        source: "IMPORT",
        externalId: data.externalId,
        ticketId: ticket.id,
        commentId: null,
        outcome: INGEST_OUTCOMES.ticket,
      },
    });

    const entries: AuditEntry[] = [
      {
        action: "TICKET_IMPORTED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        oldValue: null,
        newValue: JSON.stringify({
          externalId: data.externalId,
          source: "IMPORT",
          originalCreatedAt: originalCreatedAt.toISOString(),
          comments: plannedComments.length,
          attachments: plannedAttachments.length,
        }),
        metadata: {
          ...metadata,
          status: data.status,
          resolution: data.resolution ?? "NONE",
          queueKey: data.queueKey,
          // Who wrote the comments the desk could not attribute to a user row. Names, never addresses.
          unresolvedAuthors: unresolvedAuthors.slice(0, 20),
          skippedAttachments: skippedAttachments.length,
          piiRedactionCount: piiCount,
        },
      },
    ];
    if (piiCount > 0) {
      // ONE row for the whole import, naming the fields and the comment count it covers — the ticket
      // and its correspondence arrive in one transaction, so one row is the honest grain. The counts
      // are the combined tally (§3: counts, never the redacted values).
      const fields = [...s.redactedFields, ...(redactedComments.length > 0 ? ["comments"] : [])];
      entries.push({
        action: "PII_REDACTED",
        entityType: "TICKET",
        entityId: ticket.id,
        ticketId: ticket.id,
        fieldChanged: fields.join(","),
        oldValue: null,
        newValue: formatPiiCounts(piiByKind),
        metadata: { ...metadata, total: piiCount, comments: redactedComments.length },
      });
    }
    for (const a of plannedAttachments) {
      entries.push({
        action: "ATTACHMENT_ADDED",
        entityType: "ATTACHMENT",
        entityId: a.id,
        ticketId: ticket.id,
        fieldChanged: "state",
        oldValue: null,
        newValue: "PENDING",
        metadata: { ...metadata, stage: "intent", filename: a.filename, mime: a.mime, size: a.bytes.byteLength },
      });
    }

    await writeAuditMany(tx, call.actor, call.ctx, entries);
    return { ticketId: ticket.id, ticketNumber: ticket.number };
  }).catch(async (e: unknown) => {
    // Two passes racing the same ticket: one wins `(source, externalId)` and the other resolves into
    // the winner's answer rather than a duplicate or a 500.
    if (!isUniqueViolation(e)) throw e;
    const raced = await findIngestReceipt("IMPORT", data.externalId);
    if (raced === null || raced.ticketId === null) throw e;
    return { ticketId: raced.ticketId, ticketNumber: -1 };
  });

  if (result.ticketNumber === -1) return replayResult(result.ticketId);

  // --- the bytes, AFTER the record ---------------------------------------------------------------
  // Outside the transaction on purpose: an object write is network I/O and holding a books-and-records
  // transaction open across it is how a 15-second timeout loses a ticket. A row whose object write
  // failed stays PENDING — invisible to every read surface — and the re-run heals it.
  const stored = await storeImportedAttachments(
    result.ticketId,
    plannedAttachments.map((a) => ({ id: a.id, mime: a.mime, filename: a.filename, bytes: a.bytes })),
    call,
    options.store ?? attachmentStore(),
  );

  return {
    ticketId: result.ticketId,
    ticketNumber: result.ticketNumber,
    created: true,
    comments: plannedComments.length,
    attachments: stored,
  };
}

/** Prisma's unique-constraint violation, detected structurally (never a value import of @prisma/client). */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "P2002";
}

/**
 * Writes the planned objects and flips their rows PENDING → READY, one audit row each.
 *
 * Mirrors `persistAttachmentParts` (src/server/email-intake.ts) deliberately: the two paths produce the
 * same kind of row from the same kind of source (bytes that arrived with a message rather than through
 * a browser), and a second shape for the same fact is how the sweep that looks for stuck PENDING rows
 * ends up only finding half of them.
 */
async function storeImportedAttachments(
  ticketId: string,
  planned: ReadonlyArray<{ id: string; mime: string; filename: string; bytes: Uint8Array }>,
  call: IngestCallContext,
  store: ObjectStore,
): Promise<number> {
  if (planned.length === 0) return 0;
  const ready: Array<{ id: string; size: number; sha256: string; filename: string; mime: string }> = [];
  for (const a of planned) {
    try {
      const written = await store.put(attachmentObjectKey(ticketId, a.id), a.bytes, a.mime);
      ready.push({ id: a.id, size: written.size, sha256: written.sha256, filename: a.filename, mime: a.mime });
    } catch {
      // Row stays PENDING. Reported by the CLI; healed by a re-run.
    }
  }
  if (ready.length === 0) return 0;

  await withTx(async (tx) => {
    const readyAt = new Date();
    const entries: AuditEntry[] = [];
    for (const r of ready) {
      const flipped = await tx.attachment.updateMany({
        where: { id: r.id, state: "PENDING" },
        data: { state: "READY", readyAt, size: r.size, sha256: r.sha256 },
      });
      if (flipped.count === 0) continue;
      entries.push({
        action: "ATTACHMENT_ADDED",
        entityType: "ATTACHMENT",
        entityId: r.id,
        ticketId,
        fieldChanged: "state",
        oldValue: "PENDING",
        newValue: "READY",
        metadata: {
          via: AUDIT_VIA.import,
          source: "IMPORT",
          stage: "ready",
          filename: r.filename,
          mime: r.mime,
          size: r.size,
          backend: store.backend,
        },
      });
    }
    if (entries.length > 0) await writeAuditMany(tx, call.actor, call.ctx, entries);
  });

  return ready.length;
}

/**
 * Has this legacy help desk ticket already been imported? The CLI asks before it reads an archive file, so a
 * straggler pass over ten thousand ids costs ten thousand index lookups rather than ten thousand
 * file reads — and `--dry-run` can say "already imported" without touching the database's write path.
 */
export async function importedExternalIds(externalIds: readonly string[]): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const rows = await prisma.ingestReceipt.findMany({
    where: { source: "IMPORT", externalId: { in: [...externalIds] } },
    select: { externalId: true },
  });
  return new Set(rows.map((r) => r.externalId));
}
