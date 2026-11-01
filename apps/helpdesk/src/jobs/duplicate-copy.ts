/**
 * Nightly duplicate copy — node only.
 *
 * A books-and-records duplicate: the chain-verified audit ledger as CSV, plus the record metadata needed
 * to reconcile it (Ticket / Comment / Attachment), written to a retention-locked bucket under YYYY/MM/DD/
 * with a sha256 manifest. The point is that a copy exists somewhere the application cannot rewrite, and
 * that its integrity is provable without the application: every file carries a digest, the manifest
 * carries the chain verdict, and the CSV carries seq / prevHash / hash so the chain re-verifies offline.
 *
 * THE LEDGER IS PINNED BEFORE ANYTHING IS READ. `maxAuditSeq()` is taken once; the verification and the
 * CSV are both bounded by it. Without the pin, rows written while the job runs would appear in the file
 * but not in the verified range — the file would carry a claim the manifest does not support.
 *
 * A BROKEN CHAIN STILL PRODUCES A COPY. If verification fails the job writes everything anyway, records
 * the failing seq in the manifest, and reports `ok: false`. The copy of a ledger that has been tampered
 * with is more valuable than no copy, not less.
 *
 * WHAT IS DELIBERATELY NOT COPIED: ticket subjects and descriptions, comment bodies, requester names,
 * addresses and phone numbers. This is a reconciliation and integrity copy, not a second warm store of
 * client correspondence outside the desk's own access controls. Recorded as a recommended default in
 * the integration notes — widening it is a decision, not a code change.
 *
 * WHAT THE AUDIT CSV CARRIES ANYWAY, AND WHY IT MATTERS MORE SINCE DECISION #116. The list above is
 * about the TICKET tables; it is not a claim that free text stays out of this bucket. It does not:
 *   - `TICKET_FIELD_CHANGED` diffs `subject` and `description` and writes the FULL text into
 *     `oldValue`/`newValue` (`TICKET_DIFFED_COLUMNS`, `src/server/tickets.actions.ts`).
 *   - `COMMENT_ADDED_INTERNAL` / `COMMENT_ADDED_PUBLIC` write the entire body into `newValue`.
 *   - `AUDIT_CSV_COLUMNS` includes `oldValue`, `newValue` and `userAgent`, and this job streams that
 *     CSV to a bucket under a 17a-4 retention lock.
 * Those values are PII-sanitized, and Decision #116 narrowed "sanitized" from seven kinds to three. So
 * from the first write after that change, a date of birth, routing number, passport or licence number
 * typed into a ticket description, an edited subject or an internal note is copied VERBATIM into
 * storage that by design cannot be deleted for the retention period — and `AuditLog` itself is
 * append-only and hash-chained, with no post-hoc redaction path. That permanence is the accepted
 * consequence of the decision, not a defect in this job. If it is ever judged unacceptable, the lever
 * is to stop putting free-text `subject`/`description`/note bodies in `oldValue`/`newValue` (a
 * field-name-only diff row, leaving the text on the record), NOT to re-widen the sanitizer.
 *
 * DISABLED UNLESS `DUPLICATE_COPY_BUCKET` IS SET: the job logs "disabled" and exits 0.
 *
 * KEY SHAPE: the files are keyed `YYYY/MM/DD/<name>.<ext>`, which is NOT the `<ticketId>/<attachmentId>`
 * shape an attachment store enforces. `loadObjectStore` therefore builds a `"document"` store
 * (`src/lib/storage.ts`), and `putCopy` re-checks each key against the same predicate before any
 * I/O — a job that cannot write its copy must fail loudly at the first file, not silently produce a
 * prefix with three of five files in it.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AuditQuery } from "@/types/domain";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { verifyChainRows } from "@/lib/audit";
import type { AuditChainRow } from "@/lib/audit";
import { auditRowsToCsv, iterateAuditRows, maxAuditSeq } from "@/server/audit-export";
import type { JobContext, JobOutcome } from "@/jobs/types";
import type { ObjectStore } from "@/jobs/object-store";
import { isValidDocumentKey, loadObjectStore } from "@/jobs/object-store";

/** Rows per page, for both the chain walk and the CSV stream. */
export const DUPLICATE_COPY_PAGE_SIZE = 1000;

export const DUPLICATE_COPY_CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  ndjson: "application/x-ndjson; charset=utf-8",
  json: "application/json; charset=utf-8",
} as const;

/** File names inside the day's prefix. Stable, so a reconciliation script can hard-code them. */
export const DUPLICATE_COPY_FILES = {
  audit: "audit-chain.csv",
  tickets: "tickets.ndjson",
  comments: "comments.ndjson",
  attachments: "attachments.ndjson",
  manifest: "manifest.json",
} as const;

/**
 * Ticket columns copied: identifiers, routing, state, compliance flags, SLA snapshot and timestamps.
 * NOT copied: subject, description, clientReference, requesterName, requesterEmail, requesterPhone.
 */
export const TICKET_COPY_SELECT = {
  id: true,
  number: true,
  category: true,
  priority: true,
  status: true,
  brand: true,
  source: true,
  externalId: true,
  householdId: true,
  requesterExternalId: true,
  isComplaint: true,
  complaintFiledAt: true,
  escalationTarget: true,
  followUpAt: true,
  externalRef: true,
  linkedFromTicketId: true,
  queueId: true,
  createdById: true,
  assigneeId: true,
  slaFirstResponseMinutes: true,
  slaResolutionMinutes: true,
  firstResponseDueAt: true,
  resolutionDueAt: true,
  firstRespondedAt: true,
  resolvedAt: true,
  closedAt: true,
  piiRedacted: true,
  piiRedactionCount: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TicketSelect;

/** Comment columns copied. `body` is deliberately absent — see the module comment. */
export const COMMENT_COPY_SELECT = {
  id: true,
  ticketId: true,
  authorId: true,
  authorKind: true,
  visibility: true,
  disclaimerKey: true,
  macroId: true,
  piiRedacted: true,
  piiRedactionCount: true,
  createdAt: true,
} as const satisfies Prisma.CommentSelect;

/** Attachment columns copied: everything except the object bytes, which stay in the attachments bucket. */
export const ATTACHMENT_COPY_SELECT = {
  id: true,
  ticketId: true,
  commentId: true,
  uploaderId: true,
  kind: true,
  filename: true,
  mime: true,
  size: true,
  sha256: true,
  objectKey: true,
  state: true,
  visibility: true,
  createdAt: true,
  readyAt: true,
  removedAt: true,
  removedById: true,
} as const satisfies Prisma.AttachmentSelect;

export type TicketCopyRow = Prisma.TicketGetPayload<{ select: typeof TICKET_COPY_SELECT }>;
export type CommentCopyRow = Prisma.CommentGetPayload<{ select: typeof COMMENT_COPY_SELECT }>;
export type AttachmentCopyRow = Prisma.AttachmentGetPayload<{ select: typeof ATTACHMENT_COPY_SELECT }>;

export type CopiedFile = { path: string; bytes: number; sha256: string; rows: number };

export type DuplicateCopyManifest = {
  generatedAt: string;
  jobRequestId: string;
  prefix: string;
  ledger: {
    toSeq: string;
    verified: boolean;
    checkedRows: number;
    firstBadSeq: string | null;
    reason: "OK" | "HASH_MISMATCH" | "PREV_HASH_MISMATCH" | "EMPTY";
  };
  files: CopiedFile[];
};

/** `YYYY/MM/DD` in UTC. UTC and not local time so a copy is never written twice or skipped at a DST edge. */
export function duplicateCopyPrefix(now: Date): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

/** Lower-case hex sha256 of the bytes — the same digest shape the object store reports. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Dates as ISO, bigint as a decimal string; everything else as JSON.stringify would have it. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** One JSON object per line, trailing newline. Empty input produces an empty string, not "\n". */
export function toNdjson(rows: readonly unknown[]): string {
  if (rows.length === 0) return "";
  return `${rows.map((row) => JSON.stringify(row, jsonReplacer)).join("\n")}\n`;
}

/**
 * Walks the ledger seq-ascending to `toSeq` with the same pure walker the compliance action uses.
 *
 * CONTRACT-GAP: the brief says "runs verifyAuditChain", but `verifyAuditChain` in
 * `src/server/audit-log.actions.ts` is a `"use server"` action that runs through `runAction(viewer, ctx)`
 * and asserts the `audit:verify` capability — it needs a signed-in compliance officer, which a Cloud Run
 * Job does not have, and calling it would mean minting a fake viewer. This walks the same rows with the
 * same `verifyChainRows` from `src/lib/audit.ts`, so the verdict is computed by identical code. Recorded
 * in the build record.
 */
export async function verifyLedgerChain(toSeq: bigint | undefined): Promise<DuplicateCopyManifest["ledger"]> {
  let previousHash: string | null = null;
  let cursor: bigint | undefined = undefined;
  let checkedRows = 0;
  let reason: DuplicateCopyManifest["ledger"]["reason"] = "EMPTY";
  let verified = true;
  let firstBadSeq: bigint | null = null;

  for (;;) {
    // Annotated: without it TypeScript reports a circular inference through `cursor`, which this loop
    // assigns from the rows it just read.
    const rows: AuditChainRow[] = await prisma.auditLog.findMany({
      where: {
        seq: {
          ...(cursor !== undefined ? { gt: cursor } : {}),
          ...(toSeq !== undefined ? { lte: toSeq } : {}),
        },
      },
      orderBy: { seq: "asc" },
      take: DUPLICATE_COPY_PAGE_SIZE,
    });
    if (rows.length === 0) break;

    const result = verifyChainRows(rows, previousHash);
    checkedRows += result.checked;
    if (!result.ok) {
      verified = false;
      firstBadSeq = result.firstBadSeq;
      reason = result.reason;
      break;
    }
    reason = "OK";
    const tail = rows[rows.length - 1];
    previousHash = tail.hash;
    cursor = tail.seq;
    if (rows.length < DUPLICATE_COPY_PAGE_SIZE) break;
  }

  return {
    toSeq: (toSeq ?? BigInt(0)).toString(),
    verified,
    checkedRows,
    firstBadSeq: firstBadSeq === null ? null : firstBadSeq.toString(),
    reason,
  };
}

/** The whole ledger to `toSeq` as one CSV string, header first, in the export module's own format. */
export async function buildAuditCsv(toSeq: bigint | undefined): Promise<{ csv: string; rows: number }> {
  const query: AuditQuery = { limit: DUPLICATE_COPY_PAGE_SIZE };
  const chunks: string[] = [];
  let rows = 0;
  let header = true;
  for await (const page of iterateAuditRows(query, DUPLICATE_COPY_PAGE_SIZE, toSeq)) {
    chunks.push(auditRowsToCsv(page, header));
    header = false;
    rows += page.length;
  }
  if (header) chunks.push(auditRowsToCsv([], true)); // an empty ledger still gets its header row
  return { csv: chunks.join(""), rows };
}

type Paged<T> = { rows: T[]; count: number };

/** Every row of a table, paged by id so a long table does not need one enormous query. */
async function readAll<T extends { id: string }>(
  page: (cursorId: string | undefined) => Promise<T[]>,
): Promise<Paged<T>> {
  const rows: T[] = [];
  let cursorId: string | undefined = undefined;
  for (;;) {
    const batch = await page(cursorId);
    if (batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < DUPLICATE_COPY_PAGE_SIZE) break;
    cursorId = batch[batch.length - 1].id;
  }
  return { rows, count: rows.length };
}

export async function readTicketMetadata(): Promise<Paged<TicketCopyRow>> {
  return readAll((cursorId) =>
    prisma.ticket.findMany({
      select: TICKET_COPY_SELECT,
      orderBy: { id: "asc" },
      take: DUPLICATE_COPY_PAGE_SIZE,
      ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
    }),
  );
}

export async function readCommentMetadata(): Promise<Paged<CommentCopyRow>> {
  return readAll((cursorId) =>
    prisma.comment.findMany({
      select: COMMENT_COPY_SELECT,
      orderBy: { id: "asc" },
      take: DUPLICATE_COPY_PAGE_SIZE,
      ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
    }),
  );
}

export async function readAttachmentMetadata(): Promise<Paged<AttachmentCopyRow>> {
  return readAll((cursorId) =>
    prisma.attachment.findMany({
      select: ATTACHMENT_COPY_SELECT,
      orderBy: { id: "asc" },
      take: DUPLICATE_COPY_PAGE_SIZE,
      ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
    }),
  );
}

/**
 * Writes one file and records what was written. The store reports the size and digest it actually stored;
 * this asserts that digest against the bytes handed in, so a backend that silently transforms the body
 * (a stray gzip, a text-mode write) fails here rather than producing a manifest that lies.
 */
export async function putCopy(
  store: ObjectStore,
  prefix: string,
  name: string,
  body: string,
  contentType: string,
  rows: number,
): Promise<CopiedFile> {
  const bytes = new TextEncoder().encode(body);
  const expected = sha256Hex(bytes);
  const path = `${prefix}/${name}`;
  // The store refuses a malformed key anyway; this names the file in the message and keeps the key
  // contract visible where the key is built.
  if (!isValidDocumentKey(path)) {
    throw new Error(`duplicate copy: ${path} is not a writable object key`);
  }
  const stored = await store.put(path, bytes, contentType);
  if (stored.sha256 !== expected || stored.size !== bytes.byteLength) {
    throw new Error(`duplicate copy: stored object ${path} does not match the bytes written`);
  }
  return { path, bytes: bytes.byteLength, sha256: expected, rows };
}

/** The manifest object, exactly as it is serialised into manifest.json. */
export function buildManifest(input: {
  now: Date;
  requestId: string;
  prefix: string;
  ledger: DuplicateCopyManifest["ledger"];
  files: CopiedFile[];
}): DuplicateCopyManifest {
  return {
    generatedAt: input.now.toISOString(),
    jobRequestId: input.requestId,
    prefix: input.prefix,
    ledger: input.ledger,
    files: [...input.files].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export type DuplicateCopyDeps = { store?: ObjectStore };

/** The job. `deps.store` exists so the tests can drive a fake store; production passes nothing. */
export async function runDuplicateCopy(job: JobContext, deps: DuplicateCopyDeps = {}): Promise<JobOutcome> {
  const bucket = env.DUPLICATE_COPY_BUCKET;
  if (bucket === undefined && deps.store === undefined) {
    job.log.info("disabled", { reason: "DUPLICATE_COPY_BUCKET is not set" });
    return { processed: 0, skipped: 0, posted: 0, metadata: { disabled: true } };
  }

  const store = deps.store ?? (await loadObjectStore(bucket));
  const prefix = duplicateCopyPrefix(job.now);

  const toSeq = await maxAuditSeq();
  const ledger = await verifyLedgerChain(toSeq);
  job.log.info("chain-verified", {
    verified: ledger.verified,
    checkedRows: ledger.checkedRows,
    reason: ledger.reason,
    toSeq: ledger.toSeq,
  });

  const audit = await buildAuditCsv(toSeq);
  const tickets = await readTicketMetadata();
  const comments = await readCommentMetadata();
  const attachments = await readAttachmentMetadata();

  const files: CopiedFile[] = [
    await putCopy(store, prefix, DUPLICATE_COPY_FILES.audit, audit.csv, DUPLICATE_COPY_CONTENT_TYPES.csv, audit.rows),
    await putCopy(
      store,
      prefix,
      DUPLICATE_COPY_FILES.tickets,
      toNdjson(tickets.rows),
      DUPLICATE_COPY_CONTENT_TYPES.ndjson,
      tickets.count,
    ),
    await putCopy(
      store,
      prefix,
      DUPLICATE_COPY_FILES.comments,
      toNdjson(comments.rows),
      DUPLICATE_COPY_CONTENT_TYPES.ndjson,
      comments.count,
    ),
    await putCopy(
      store,
      prefix,
      DUPLICATE_COPY_FILES.attachments,
      toNdjson(attachments.rows),
      DUPLICATE_COPY_CONTENT_TYPES.ndjson,
      attachments.count,
    ),
  ];

  const manifest = buildManifest({ now: job.now, requestId: job.ctx.requestId, prefix, ledger, files });
  const manifestFile = await putCopy(
    store,
    prefix,
    DUPLICATE_COPY_FILES.manifest,
    `${JSON.stringify(manifest, jsonReplacer, 2)}\n`,
    DUPLICATE_COPY_CONTENT_TYPES.json,
    files.length,
  );

  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0) + manifestFile.bytes;
  job.log.info("copy-written", {
    prefix,
    backend: store.backend,
    files: files.length + 1,
    bytes: totalBytes,
    manifestSha256: manifestFile.sha256,
  });
  if (!ledger.verified) {
    job.log.error("chain-verification-failed", { firstBadSeq: ledger.firstBadSeq, reason: ledger.reason });
  }

  return {
    processed: audit.rows + tickets.count + comments.count + attachments.count,
    skipped: 0,
    posted: files.length + 1,
    ok: ledger.verified,
    metadata: {
      prefix,
      backend: store.backend,
      bytes: totalBytes,
      auditRows: audit.rows,
      tickets: tickets.count,
      comments: comments.count,
      attachments: attachments.count,
      chainVerified: ledger.verified,
      chainReason: ledger.reason,
      chainToSeq: ledger.toSeq,
      manifestSha256: manifestFile.sha256,
    },
  };
}
