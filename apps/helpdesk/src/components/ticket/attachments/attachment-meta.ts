/**
 * Pure presentation helpers for the attachments panel.
 *
 * No imports beyond `@/types/domain` and `lucide-react`'s types, so the panel (a server component)
 * and its client subcomponents can share them without crossing a layer boundary.
 */
import { File, FileImage, FileSpreadsheet, FileText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ATTACHMENT_MIME_ALLOWLIST, INGEST_LIMITS } from "@/types/domain";
import type { AttachmentKind, AttachmentMime, UserRef } from "@/types/domain";

/** `accept` for the file picker: exactly the nine types the server will allow, plus their extensions. */
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_MIME_ALLOWLIST,
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".heic",
  ".heif",
  ".csv",
  ".txt",
  ".xlsx",
  ".docx",
].join(",");

/** Human cap used in the hint text and the client-side size refusal. */
export const ATTACHMENT_MAX_BYTES = INGEST_LIMITS.attachmentMaxBytes;
export const ATTACHMENT_MAX_LABEL = "25 MB";

/** True when the browser-reported type is one the server will accept. */
export function isAllowedMime(mime: string): mime is AttachmentMime {
  return (ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(mime);
}

/** Short, readable type label — "PDF", "Excel", "Photo". Falls back to the subtype. */
export function mimeLabel(mime: string): string {
  switch (mime) {
    case "application/pdf":
      return "PDF";
    case "image/png":
      return "PNG";
    case "image/jpeg":
      return "JPEG";
    case "image/heic":
    case "image/heif":
      return "HEIC";
    case "text/csv":
      return "CSV";
    case "text/plain":
      return "Text";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return "Excel";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "Word";
    default: {
      const sub = mime.split("/")[1] ?? mime;
      return sub.toUpperCase().slice(0, 8);
    }
  }
}

/** One icon per family: image, spreadsheet, document, everything else. */
export function mimeIcon(mime: string): LucideIcon {
  if (mime.startsWith("image/")) return FileImage;
  if (mime === "text/csv" || mime.endsWith("spreadsheetml.sheet")) return FileSpreadsheet;
  if (mime === "application/pdf" || mime === "text/plain" || mime.endsWith("wordprocessingml.document")) {
    return FileText;
  }
  return File;
}

/**
 * Bytes as a desk reader wants them: whole numbers under a megabyte, one decimal above. Binary units
 * with decimal labels, matching what macOS and Windows show for the same file.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/**
 * Who put a file on the ticket — the one thing the panel got wrong.
 *
 * `src/server/email-intake.ts` stores an inbound email part with `uploaderId: null` and
 * `kind: "EMAIL_PART"`, so a uploader-only line rendered a form the CLIENT emailed in as having been
 * attached by the firm ("Help desk"), on a surface an examiner reads. The kind is already on
 * `AttachmentDTO` (contract §10 S4); this branches on it.
 */
export const EMAIL_PART_ORIGIN_LABEL = "Received from the client by email" as const;

/** The short form of the same fact, for a badge beside the filename where the meta line truncates. */
export const EMAIL_PART_ORIGIN_BADGE = "From client" as const;

/** A file the desk produced for itself — a job's output, not a person's upload. */
export const SYSTEM_ORIGIN_LABEL = "Added automatically by the help desk" as const;

/** An UPLOAD whose uploader row is missing. Rare, and never used for an inbound or system file. */
export const UNKNOWN_UPLOADER_LABEL = "Help desk" as const;

export function attachmentOriginLabel(kind: AttachmentKind, uploader: UserRef | null): string {
  switch (kind) {
    case "EMAIL_PART":
      return EMAIL_PART_ORIGIN_LABEL;
    case "SYSTEM":
      return SYSTEM_ORIGIN_LABEL;
    case "UPLOAD":
      return uploader === null ? UNKNOWN_UPLOADER_LABEL : uploader.name?.trim() || uploader.email;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** True when the file came IN from the client rather than going out from, or staying inside, the desk. */
export function isInboundAttachment(kind: AttachmentKind): boolean {
  return kind === "EMAIL_PART";
}
