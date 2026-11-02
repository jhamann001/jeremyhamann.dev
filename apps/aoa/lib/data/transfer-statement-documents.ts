import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { writeAudit, TRANSFER_STATEMENT_DOWNLOAD, TRANSFER_STATEMENT_UPLOAD } from "@/lib/audit";
import { lockTransferPlan } from "@/lib/data/transfer-plan-lock";
import { acceptStatement } from "@/lib/transfers/intake-gates";
import { outcomeRecordsEnabled, preparationPausedFor } from "@/lib/transfers/outcomes";
import { easternToday, parseIsoDay } from "@/lib/transfers/eastern-day";
import {
  NO_STATEMENT,
  STATEMENT_MAX_BYTES,
  STATEMENT_MESSAGES,
  STATEMENT_REVIEW_STATUSES,
  reviewStatusFromOption,
  statementSavedMessage,
  type StatementReviewStatus,
  type StatementView,
} from "@/lib/transfers/statement-document";

// Statement files for an asset transfer (ticket). The bytes are stored in
// app.transfer_statement_document, following the custodian fee-schedule
// document pattern: Cloud SQL storage, a sha256 and size CHECK, no DELETE.
// Every read and write runs in the caller's user-scoped transaction.

export type StatementContentType = "application/pdf" | "image/png" | "image/jpeg";

export class StatementUploadError extends Error {
  constructor(message: string, public readonly status: 400 | 413 | 415) {
    super(message);
    this.name = "StatementUploadError";
  }
}

const SUPPORTED: Record<StatementContentType, readonly string[]> = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
};

function isSupported(type: string): type is StatementContentType {
  return Object.hasOwn(SUPPORTED, type);
}

export function safeStatementFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? "";
  const safe = basename.replace(/[^a-zA-Z0-9._ ()-]/g, "-").replace(/^[.\s]+/, "").trim();
  const extension = safe.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? "";
  const stem = extension ? safe.slice(0, -extension.length) : safe;
  return `${stem.slice(0, 180) || "statement"}${extension}`;
}

function matchesSignature(type: StatementContentType, content: Buffer): boolean {
  switch (type) {
    case "application/pdf":
      return content.subarray(0, 5).equals(Buffer.from("%PDF-"));
    case "image/png":
      return content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}

export type BuiltStatementDocument = {
  filename: string;
  contentType: StatementContentType;
  content: Buffer;
  byteSize: number;
  sha256: string;
};

/** Extension, declared type and magic bytes must agree; 10 MB or smaller. */
export function buildStatementDocument(input: {
  filename: string;
  contentType: string;
  content: Uint8Array;
}): BuiltStatementDocument {
  if (input.content.byteLength === 0) throw new StatementUploadError(STATEMENT_MESSAGES.badFile, 400);
  if (input.content.byteLength > STATEMENT_MAX_BYTES) throw new StatementUploadError(STATEMENT_MESSAGES.tooLarge, 413);
  const extension = input.filename.split(/[\\/]/).pop()?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? "";
  let type = input.contentType.toLowerCase().trim();
  if (!type || type === "application/octet-stream") {
    type = (Object.keys(SUPPORTED) as StatementContentType[]).find((key) => SUPPORTED[key].includes(extension)) ?? type;
  }
  if (!isSupported(type) || !SUPPORTED[type].includes(extension)) {
    throw new StatementUploadError(STATEMENT_MESSAGES.badFile, 415);
  }
  const content = Buffer.from(input.content);
  if (!matchesSignature(type, content)) throw new StatementUploadError(STATEMENT_MESSAGES.signature, 415);
  return {
    filename: safeStatementFilename(input.filename),
    contentType: type,
    content,
    byteSize: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

/** A strict YYYY-MM-DD that is not after today's Eastern day. */
export function parseStatementDate(text: string, now: Date = new Date()): Date | string {
  const day = parseIsoDay(text.trim());
  if (!day) return STATEMENT_MESSAGES.badDate;
  if (text.trim() > easternToday(now)) return STATEMENT_MESSAGES.futureDate;
  return day;
}

function isReviewStatus(value: string | null): value is StatementReviewStatus {
  return value != null && (STATEMENT_REVIEW_STATUSES as readonly string[]).includes(value);
}

export type StoredStatementFile = { id: string; filename: string; byteSize: number; contentType: string };

export type StatementRecords = {
  /** Id of the latest statement row, used as the dialog's version token. */
  version: string;
  latest: StatementView;
  /** The latest file when its review is still pending, for "Review statement". */
  pendingFile: (StoredStatementFile & { statementDate: string }) | null;
  latestFile: StoredStatementFile | null;
  /** Earlier files, newest first: filename, date and 1-based version. */
  previous: { id: string; filename: string; statementDate: string | null; version: number }[];
};

const LATEST = [{ created_at: "desc" as const }, { id: "desc" as const }];
const MAX_ROWS = 500;

const isoDay = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

export async function readStatementRecords(tx: Prisma.TransactionClient, transferId: string): Promise<StatementRecords> {
  const [rows, documents] = await Promise.all([
    tx.transferStatement.findMany({
      where: { transfer_id: transferId },
      orderBy: LATEST,
      take: MAX_ROWS,
      select: { id: true, accepted: true, document_id: true, statement_date: true, review_status: true },
    }),
    tx.transferStatementDocument.findMany({
      where: { transfer_id: transferId },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      take: MAX_ROWS,
      select: { id: true, filename: true, byte_size: true, content_type: true },
    }),
  ]);
  const latestRow = rows[0];
  if (!latestRow) return { version: "none", latest: NO_STATEMENT, pendingFile: null, latestFile: null, previous: [] };
  const reviewStatus = isReviewStatus(latestRow.review_status) ? latestRow.review_status : null;
  const file = (id: string | null): StoredStatementFile | null => {
    const doc = id ? documents.find((d) => d.id === id) : undefined;
    return doc ? { id: doc.id, filename: doc.filename, byteSize: doc.byte_size, contentType: doc.content_type } : null;
  };
  const latestFile = file(latestRow.document_id);
  const latestDate = isoDay(latestRow.statement_date);
  const dateOf = (documentId: string) => isoDay(rows.find((row) => row.document_id === documentId)?.statement_date ?? null);
  const previous = documents
    .map((doc, index) => ({ id: doc.id, filename: doc.filename, statementDate: dateOf(doc.id), version: index + 1 }))
    .filter((doc) => doc.id !== latestFile?.id)
    .reverse();
  return {
    version: latestRow.id,
    latest: {
      provided: true,
      accepted: latestRow.accepted,
      reviewStatus,
      filename: latestFile?.filename ?? null,
      statementDate: latestDate,
    },
    pendingFile: latestFile && reviewStatus === "pending" && latestDate ? { ...latestFile, statementDate: latestDate } : null,
    latestFile,
    previous,
  };
}

export type StatementSubmission = {
  /** The latest statement row id the dialog was opened on, or "none". */
  version: string;
  statementDate: string;
  review: string;
  /** A new file, already validated by `buildStatementDocument`. */
  file?: BuiltStatementDocument;
  /** The public demo's sample statement: point at this transfer's stored copy of the same bytes when there is one,
   *  so choosing the sample again adds no file. Uploads never set it. */
  reuseStoredCopy?: boolean;
  /** Review-only: the pending file the latest statement already points at. */
  documentId?: string;
};

export type StatementWriteResult =
  | { ok: true; message: string; reviewStatus: StatementReviewStatus }
  | { ok: false; status: 400 | 404 | 409; message: string };

/**
 * Stores a new statement file (or re-reviews the pending one) and records the
 * review through `acceptStatement`, which clears the funding-plan approval
 * pointer when it replaces an earlier statement. Refused once a submission is
 * logged or while an outcome pauses the transfer.
 */
export async function recordStatementSubmission(
  tx: Prisma.TransactionClient,
  identity: Identity,
  transferId: string,
  input: StatementSubmission,
  now: Date = new Date(),
): Promise<StatementWriteResult> {
  const reviewStatus = reviewStatusFromOption(input.review);
  if (!reviewStatus) return { ok: false, status: 400, message: STATEMENT_MESSAGES.badReview };
  const statementDate = parseStatementDate(input.statementDate, now);
  if (typeof statementDate === "string") return { ok: false, status: 400, message: statementDate };
  if (!input.file && !input.documentId) return { ok: false, status: 400, message: STATEMENT_MESSAGES.noFile };

  try {
    await lockTransferPlan(tx, transferId);
  } catch {
    return { ok: false, status: 404, message: STATEMENT_MESSAGES.unavailable };
  }
  const transfer = await tx.transfer.findUnique({ where: { id: transferId }, select: { archived_at: true } });
  if (!transfer || transfer.archived_at) return { ok: false, status: 404, message: STATEMENT_MESSAGES.unavailable };
  const submitted = await tx.transferSubmission.findFirst({ where: { transfer_id: transferId }, select: { id: true } });
  if (submitted) return { ok: false, status: 409, message: STATEMENT_MESSAGES.submitted };
  if (await preparationPausedFor(tx, transferId, outcomeRecordsEnabled())) {
    return { ok: false, status: 409, message: STATEMENT_MESSAGES.paused };
  }
  const latest = await tx.transferStatement.findFirst({
    where: { transfer_id: transferId },
    orderBy: LATEST,
    select: { id: true, document_id: true, review_status: true },
  });
  if ((latest?.id ?? "none") !== input.version) return { ok: false, status: 409, message: STATEMENT_MESSAGES.stale };

  let documentId: string;
  const storedCopy = input.file && input.reuseStoredCopy
    ? await tx.transferStatementDocument.findFirst({
      where: { transfer_id: transferId, sha256: input.file.sha256, filename: input.file.filename },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      select: { id: true },
    })
    : null;
  if (storedCopy) {
    documentId = storedCopy.id;
  } else if (input.file) {
    documentId = randomUUID();
    const { filename, contentType, content, byteSize, sha256 } = input.file;
    await tx.transferStatementDocument.create({
      data: {
        id: documentId,
        transfer_id: transferId,
        filename,
        content_type: contentType,
        content: new Uint8Array(content),
        sha256,
        byte_size: byteSize,
        created_by: identity.email ?? "",
      },
      select: { id: true },
    });
    await writeAudit(tx, identity, {
      action: TRANSFER_STATEMENT_UPLOAD,
      entityType: "transfer",
      entityId: transferId,
      detail: { documentId, contentType, byteSize, sha256 },
    });
  } else {
    if (!latest || latest.review_status !== "pending" || latest.document_id !== input.documentId) {
      return { ok: false, status: 409, message: STATEMENT_MESSAGES.stale };
    }
    documentId = latest.document_id;
  }
  await acceptStatement(tx, identity, transferId, reviewStatus === "accepted", true, {
    documentId,
    statementDate,
    reviewStatus,
  });
  return { ok: true, message: statementSavedMessage(reviewStatus), reviewStatus };
}

export type StatementDownload = { filename: string; contentType: string; content: Buffer; sha256: string };

/** The stored file, read under RLS; the read is audited on the document. */
export async function readStatementDownload(
  identity: Identity,
  transferId: string,
  documentId: string,
): Promise<StatementDownload | null> {
  return withUserScope(identity, async (tx) => {
    const row = await tx.transferStatementDocument.findFirst({
      where: { id: documentId, transfer_id: transferId },
      select: { filename: true, content_type: true, content: true, sha256: true },
    });
    if (!row) return null;
    await writeAudit(tx, identity, {
      action: TRANSFER_STATEMENT_DOWNLOAD,
      entityType: "transfer_statement_document",
      entityId: documentId,
      detail: { transferId, sha256: row.sha256 },
    });
    return { filename: row.filename, contentType: row.content_type, content: Buffer.from(row.content), sha256: row.sha256 };
  });
}
