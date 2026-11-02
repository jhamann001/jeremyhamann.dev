import type { AcatListRow, AcatListAssetMap } from "./acat-status";

// PURE ACAT helpers (ticket lineage) — NO Prisma / server-only import, so the
// status/tone classification and the transfer-centric chip-map build are all
// unit-testable in the node vitest env (the transfer-basis / transfer-stage
// idiom).
//
// TRANSFER-CENTRIC BOARD (step 1, owner decision 2026-07-15): the board's unit
// is the TRANSFER, not the ACAT. An ACAT is an ATTRIBUTE of a transfer (1:1 via
// acat_transfer_id), surfaced as a small status CHIP on the transfer card; full
// ACAT detail lives on the transfer detail page. This REVERSES the earlier
// "fold ACAT cards into the In Transfer column" display work (#140/#142): there
// are no longer separate ACAT cards, no residual/unlinked lane cards, no
// show-all-in-flight display list. `buildAcatChipMap` (below) is the whole board
// data path now — the tracker list is fetched ONCE, reduced to a per-ACAT chip,
// and looked up by each linked transfer card.

/** Roles that may see an UNLINKED firm-wide ACAT's detail (no per-book scoping
 *  key exists for them). Mirrors the firm-household / audit-read gate pattern.
 *  HoA is retired and folds into OPERATIONS at the Okta/session/RLS boundaries, so the
 *  firm-wide gate is ADMIN / OPERATIONS only.
 *  Consulted today by the DORMANT unlinked-ACAT drawer action only
 *  (acat-lane-actions.ts) — the board no longer surfaces unlinked cards. */
export const ACAT_UNLINKED_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "OPERATIONS",
]);

/** True when the caller's role may see an unlinked firm-wide ACAT's detail. */
export function canSeeUnlinkedAcats(role: string | null | undefined): boolean {
  return role != null && ACAT_UNLINKED_ROLES.has(role);
}

/** Known NON-linkable placeholder values a tracker record's `acatTransferId`
 *  can carry instead of a real transfer id (compared case-insensitively after
 *  trimming). `acatTransferId` is nullable and non-unique — these literals mean
 *  "no real id yet", and you cannot link an app.transfer to an ACAT through one.
 *  Kept as an explicit DENYLIST (not a length/shape heuristic) so real tracker
 *  ids of ANY length or format are accepted — only these sentinels are refused. */
const ACAT_ID_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "n/a",
  "na",
  "none",
  "-",
  "to come",
  "tbd",
  "pending",
  "manual",
]);

/** True when `acatTransferId` is a REAL, linkable tracker transfer id — i.e. a
 *  non-empty value that is not one of the known placeholders. `acatTransferId`
 *  is a nullable, non-unique field on a tracker record; you cannot link an
 *  app.transfer to an ACAT via a placeholder ("", null, "N/A", "Manual", …).
 *  This is the guard for BOTH the ACAT Tracking drawer's link action and the
 *  transfer board's chip map (a placeholder id must never key a chip built from
 *  the wrong newest-placeholder record). Any other non-empty value is accepted,
 *  so real ids of any length/format pass. */
export function isLinkableAcatTransferId(
  acatTransferId: string | null | undefined,
): boolean {
  if (typeof acatTransferId !== "string") return false;
  const normalized = acatTransferId.trim();
  if (normalized === "") return false;
  return !ACAT_ID_PLACEHOLDERS.has(normalized.toLowerCase());
}

/** Status → semantic tone (the mockup's contract): Accepted → accent (green),
 *  Submitted/Pending → warning (amber), Rejected → danger (red), else neutral.
 *  The tracker owns the status vocabulary; we classify defensively. */
export type AcatToneKind = "accepted" | "submitted" | "rejected" | "neutral";

export function acatToneKind(status: string | null | undefined): AcatToneKind {
  const s = (status ?? "").toUpperCase();
  if (/REJECT|CANCEL|FAIL|ERROR/.test(s)) return "rejected";
  if (/ACCEPT|SETTLED|COMPLETE|RECEIVED|FUNDED/.test(s)) return "accepted";
  if (/SUBMIT|PENDING|REVIEW|HOLD|PROGRESS|IN[_ ]?TRANSFER/.test(s))
    return "submitted";
  return "neutral";
}

/** Asset-map one-liner: "{mapped} / {total} mapped" when clean, else
 *  "{n} mismatch" (warning). Exceptions = unmapped + pending; a mapped/expected
 *  shortfall also counts. All counts are nullable → treated as 0. Reused by the
 *  chip as the at-a-glance POSITION-MISMATCH signal (see `warning`). */
export function acatMapSummary(m: AcatListAssetMap): {
  text: string;
  warning: boolean;
} {
  const total = m.total ?? 0;
  const mapped = m.mapped ?? 0;
  const unmapped = m.unmapped ?? 0;
  const pending = m.pending ?? 0;
  const expected = m.expected ?? total;
  const shortfall = Math.max(0, expected - mapped);
  const exceptions = unmapped + pending + Math.max(0, shortfall - unmapped - pending);
  if (exceptions > 0) {
    return { text: `${exceptions} mismatch`, warning: true };
  }
  return { text: `${mapped} / ${total} mapped`, warning: false };
}

/** The compact, at-a-glance ACAT indicator a linked transfer card renders. It
 *  carries only what the chip shows — the full picture lives on the transfer
 *  detail page. `tone` reuses `acatToneKind` (green/amber/red/neutral vocab);
 *  `needsAttention` is the red "attention" flag, true when the ACAT is REJECTED
 *  or has a POSITION MISMATCH (reuses the existing `acatToneKind` /
 *  `acatMapSummary` signals — no new vocabulary). */
export type AcatChip = {
  /** The tracker status verbatim (never null here — a chip is only built when
   *  the tracker carries a live status; see buildAcatChipMap). */
  status: string;
  tone: AcatToneKind;
  needsAttention: boolean;
};

/** Link id → its chip, keyed by BOTH tracker identities (record `id` and, when
 *  real, `acatTransferId`) so a transfer linked by EITHER column finds its
 *  chip. A plain record (serializes cleanly across the server → client
 *  component boundary; TransferBoard is "use client"). */
export type AcatChipMap = Record<string, AcatChip>;

/** The ACAT link columns that are safe to expose for one already-visible
 * transfer row. Kept structural so this pure module does not import the
 * Prisma-backed transfer data seam. */
export type VisibleAcatLink = {
  acat_record_id: string | null;
  acat_transfer_id: string | null;
};

/**
 * Reduce a server-built, firm-wide chip map to the exact identifiers already
 * present on RLS-scoped transfer rows before crossing the server → browser
 * boundary. The full tracker inventory must remain server-side: otherwise
 * every authenticated Asset Transfer session can inspect unrelated record IDs
 * and UUIDs in its serialized component props.
 *
 * Only the keys literally present on a visible row are copied. If a tracker
 * row is keyed by both record ID and UUID but the visible transfer stores just
 * one of them, the alternate identifier stays private. This still satisfies
 * TransferLane's record-ID-first / UUID-fallback lookup.
 */
export function filterAcatChipMapForVisibleRows(
  chips: AcatChipMap,
  rows: readonly VisibleAcatLink[],
): AcatChipMap {
  const visible: AcatChipMap = {};
  for (const row of rows) {
    for (const id of [row.acat_record_id, row.acat_transfer_id]) {
      if (
        id &&
        Object.prototype.hasOwnProperty.call(chips, id) &&
        !Object.prototype.hasOwnProperty.call(visible, id)
      ) {
        visible[id] = chips[id];
      }
    }
  }
  return visible;
}

/**
 * Reduce the firm-wide tracker list to a per-ACAT chip map (transfer-centric
 * board, step 1). Keyed by BOTH tracker identities so a transfer card can look
 * up its chip by whichever link column it carries (record id primary since
 * record-id linking, legacy UUID fallback):
 *   • the tracker RECORD `id` — always real (the row PK; fetchAcatList drops
 *     id-less rows), so EVERY status-carrying row keys a record-id chip. This
 *     is the D6 follow-up: a record-id-only linked transfer (UUID-less "N/A"
 *     ACAT) now shows its live chip like UUID-linked ones do.
 *   • `acatTransferId` — only when REAL (linkable): a PLACEHOLDER ("", "N/A",
 *     "Manual", …) must never key a chip built from the wrong
 *     newest-placeholder record (the same collision the by-record drawer read
 *     fixes).
 * ROLE-INDEPENDENT and STAGE-INDEPENDENT: a chip is produced for every list
 * row that carries a live status; the card decides whether it has a linked
 * ACAT to show it for. A row with NO status is skipped (no meaningful chip).
 * The empty/degraded list yields an empty map, so every card simply renders
 * without a chip. The two key spaces cannot collide in practice (record PKs
 * are cuids, transfer ids are UUIDs); first entry wins defensively regardless.
 */
export function buildAcatChipMap(list: AcatListRow[]): AcatChipMap {
  const map: AcatChipMap = {};
  for (const row of list) {
    if (!row.status) continue;
    const tone = acatToneKind(row.status);
    const needsAttention =
      tone === "rejected" || acatMapSummary(row.assetMap).warning;
    const chip: AcatChip = { status: row.status, tone, needsAttention };
    // RECORD-ID leg — the row PK, always present and real.
    if (row.id !== "" && !(row.id in map)) {
      map[row.id] = chip;
    }
    // UUID leg (legacy) — only a REAL, linkable acatTransferId keys a chip.
    if (
      isLinkableAcatTransferId(row.acatTransferId) &&
      !(row.acatTransferId in map)
    ) {
      map[row.acatTransferId] = chip;
    }
  }
  return map;
}

/**
 * What the transfer detail page's ACAT section renders (pure — the node-env
 * testable data branch of <AcatStatusSection>):
 *   • "card"         — the tracker returned a status → the full status card.
 *   • "missing_link" — a link id IS stored but the tracker 404'd → a quiet but
 *     VISIBLE note (the stored id matches no tracker record — a stale/mistyped
 *     legacy link), never a silent blank. Before this, the 404 degrade
 *     rendered nothing and a bad link read as "the ACAT disappeared".
 *   • "none"         — no ids at all (defensive: the page gates the section on
 *     having a link, so this arm is unreachable from the detail page).
 */
export type AcatSectionOutcome = "card" | "missing_link" | "none";

export function acatSectionOutcome(
  hasStatus: boolean,
  acatRecordId: string | null,
  acatTransferId: string | null,
): AcatSectionOutcome {
  if (hasStatus) return "card";
  return acatRecordId != null || acatTransferId != null
    ? "missing_link"
    : "none";
}
