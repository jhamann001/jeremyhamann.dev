// Deal soft-delete contract module (WO ticket) — PURE: no Prisma import, so
// unit tests and client components consume it without touching the DB client
// (the deal-filter.ts idiom).
//
// Soft delete only: "Delete" archives (sets archived_at/archived_by); the row
// and its audit trail always survive — hard DELETE stays revoked at the grant
// level (D1). Archived deals leave the pipeline table, KPI tiles, search and
// CSV export (all fed by the one seam filter in lib/data/deals.ts), and are
// reachable only through the gated "Removed" view.

// Who may see the Removed view / restore archived deals: ADMIN + OPERATIONS
// only — the O1 audit-read precedent (lib/data/audit-log.ts). Fail closed:
// unknown/missing roles are never in the set.
export const ARCHIVED_DEALS_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);

export function canSeeArchivedDeals(
  role: string | null | undefined,
): boolean {
  return ARCHIVED_DEALS_ROLES.has(role ?? "");
}

// Locked confirm copy (WO ticket) — the confirm step and its unit test share
// this constant so the wording can never silently drift.
export const ARCHIVE_CONFIRM_COPY =
  "Removes this deal from the pipeline. It's kept in the audit history and an admin can restore it.";

// D8 (WO ticket): why a deal is being removed — the mockup's delete-reason
// list, verbatim and in its order. The confirm step requires one; the optional
// note is appended ("<reason> · <note>") into archived_reason and the
// deal.archive audit payload carries both raw.
export const ARCHIVE_REASONS = [
  "Duplicate",
  "Entered in error",
  "Test / invalid data",
  "No longer a real opportunity",
  "Other",
] as const;

/** archived_reason as stored: the reason, with the optional note appended. */
export function archivedReasonText(reason: string, note: string): string {
  const n = note.trim();
  return n === "" ? reason : `${reason} · ${n}`;
}

// QC LOW-2 (PR #80): the optional note is capped — it lands in a row column
// AND the audit payload, so an unbounded paste would bloat both. The input's
// maxLength and the server check share this constant.
export const ARCHIVE_NOTE_MAX = 500;

/** Server-side note check; null = fine, string = the field error message. */
export function archiveNoteError(note: string): string | null {
  return note.trim().length > ARCHIVE_NOTE_MAX
    ? `Note must be ${ARCHIVE_NOTE_MAX} characters or fewer.`
    : null;
}
