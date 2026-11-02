// Pure helpers for the transfer soft-archive surface
// (feat/transfer-archive-falloff) — the lib/data/deal-archive.ts idiom: no
// Prisma, no React, unit-tested in test/transfer-archive-action.test.ts and
// consumed by the detail page + the archive button.

/**
 * The archived_reason vocabulary. The S4 reconciler stamps "deal_lost" /
 * "uncommitted" / "deal_gone" (lib/data/transfer-sync.ts reconcileAction /
 * orphanAction); the manual archiveTransfer action stamps "manual". Stored as
 * plain text, so the banner mapper below tolerates anything.
 */
export const MANUAL_ARCHIVE_REASON = "manual";

/**
 * Friendly text for the detail page's archived banner — mirrors DealDetail's
 * "Removed from the pipeline …" note. Maps the machine reason stamps to plain
 * English; an unknown stamp is shown verbatim (never hidden — this is an audit
 * surface), and null yields null so the banner simply omits the reason clause.
 */
export function archivedReasonLabel(
  reason: string | null,
  archivedBy: string | null,
): string | null {
  switch (reason) {
    case "deal_lost":
      return "the linked deal was marked Lost";
    case "uncommitted":
      return "the linked deal returned to Potential";
    case "deal_gone":
      return "the linked deal was removed from the pipeline";
    case MANUAL_ARCHIVE_REASON:
      return archivedBy ? `archived by ${archivedBy}` : "archived manually";
    default:
      return reason;
  }
}

/**
 * Friendly text for the detail page's NEEDS-REVIEW banner and the board chip's
 * tooltip (transfer-syncflag-surface) — the archivedReasonLabel sibling for the
 * OTHER reconciler stamp, `sync_flag`. The S4 reconciler sets
 * "uncommitted_review" (linked deal regressed to Potential) and "orphan_review"
 * (linked deal archived/deleted directly — the §4.1 orphan sweep) on a
 * PROGRESSED transfer instead of auto-archiving it (owner decision 2026-07-24:
 * flag + manual button, never auto-teardown). An unknown stamp renders a
 * generic review prompt that still shows the raw value (audit surface — never
 * hidden); null yields null so both surfaces simply omit.
 */
export function syncFlagLabel(flag: string | null): string | null {
  switch (flag) {
    case null:
      return null;
    case "uncommitted_review":
      return "The linked deal moved back to Potential — review whether this transfer should stay on the board.";
    case "orphan_review":
      return "The linked deal was removed — review whether this transfer should stay on the board.";
    default:
      return `This transfer was flagged for review (${flag}) — review whether it should stay on the board.`;
  }
}

/** Locked confirm copy for the manual archive affordance (the deals
 *  ARCHIVE_CONFIRM_COPY idiom). */
export const TRANSFER_ARCHIVE_CONFIRM_COPY =
  "Archive this transfer? It leaves the Asset Transfer board and its ops " +
  "stats, but the record and its audit trail are kept and stay reachable by " +
  "direct link.";
