import { acatMapSummary, type AcatToneKind } from "./acat-lane";
import type { AcatListRow } from "./acat-status";
import {
  resolveAcatStatus,
  PHASE_RANK,
  type AcatPhase,
} from "./acat-status-catalog";

// PURE grouping/summary helper for the standalone ACAT Tracking page
// (transfer-centric step 2). NO Prisma / server-only import — the whole
// bucketing / ordering / summary path is unit-testable in the node vitest env
// (the acat-lane / transfer-basis idiom).
//
// The board is now transfer-centric (an ACAT is a status CHIP on a transfer
// card), so UN-LINKED / residual tracker ACATs — a tracker record with no
// app.transfer — have no home on the board. This page lists ALL tracker ACATs
// (linked + un-linked), grouped by their FRIENDLY status LABEL and ordered by
// lifecycle position, mirroring the mockup's `page-acat`.
//
// ticket: the tracker returns RAW PascalCase enum values ("PendingSettlement",
// "ToCome", …), NOT friendly labels. Grouping/ordering/tone now route through
// the canonical status catalog (`resolveAcatStatus`) so a "PendingSettlement"
// ACAT lands in a "Pending Settlement" group in the right lifecycle position,
// and the list, drawer and detail card all show the identical label + tone. The
// catalog BACKS the phase + tone that the old ad-hoc `DONE_RE` /
// `acatToneKind`-based logic used to derive.

// Re-exported for continuity — the phase vocabulary now lives in the catalog.
export type { AcatPhase };

/** status → ordering phase, backed by the canonical status catalog. Kept as a
 *  named export so callers/tests keep a single phase entry point. */
export function acatPhase(status: string | null | undefined): AcatPhase {
  return resolveAcatStatus(status).phase;
}

/** Raw tracker status values that are TERMINAL and deliberately NOT shown on
 *  the AOA ACAT Tracking tab (a display-level decision — the tracker still
 *  returns them and the external "Open full tracker" link remains the place to
 *  review them). Today: `Rejected` (owner-confirmed terminal). This is scoped to
 *  THIS page's grouped list + counts; the status catalog's tone/phase for
 *  Rejected is unchanged and still drives the transfer-board chip elsewhere. */
const HIDDEN_TRACKING_STATUSES: ReadonlySet<string> = new Set(["Rejected"]);

/** True when a row's status is one the tracking tab hides (terminal Rejected). */
function isHiddenTrackingStatus(status: string | null | undefined): boolean {
  return HIDDEN_TRACKING_STATUSES.has((status ?? "").trim());
}

/** A list row enriched with its LINKAGE to a visible app.transfer and the
 *  needs-attention flag. `linked` is true when the row's acatTransferId matches
 *  a transfer the caller can see (so we can offer a "View transfer →" link);
 *  un-linked rows are the residual ACATs this page exists to surface. Rows are
 *  keyed by their tracker record `id` (inherited from AcatListRow) — always
 *  present, even when `acatTransferId` is empty for a legacy/manual ACAT. */
export type AcatTrackingRow = AcatListRow & {
  linked: boolean;
  transferId: string | null;
  /** Rejected (red tone) OR a position mismatch (acatMapSummary warning) —
   *  reuses the exact signals the transfer-card chip uses; no new vocabulary. */
  needsAttention: boolean;
};

/** One status group: every row that shares a FRIENDLY status label (from the
 *  canonical catalog), plus the catalog tone (color), ordering phase and
 *  lifecycle order index. */
export type AcatStatusGroup = {
  /** Friendly display label (e.g. "Pending Settlement", or "Unknown status"). */
  label: string;
  /** Canonical lifecycle order index (secondary group sort within a phase). */
  order: number;
  tone: AcatToneKind;
  phase: AcatPhase;
  count: number;
  rows: AcatTrackingRow[];
};

/** The summary bar counts — every number is derived from the live/fixture list,
 *  never hard-coded (the mockup's fabricated counts are deliberately not
 *  reproduced). */
export type AcatTrackingSummary = {
  total: number;
  inFlight: number;
  attention: number;
  completed: number;
  needsAttention: number;
  linked: number;
  unlinked: number;
};

export type AcatTracking = {
  groups: AcatStatusGroup[];
  summary: AcatTrackingSummary;
};

// Most-recent-first within a group: latest activity, else the ACAT date. Both
// are ISO-ish strings that sort lexicographically; a missing key sorts last.
const recencyKey = (r: AcatTrackingRow): string =>
  r.lastActivityAt ?? r.acatDate ?? "";

/**
 * Reduce the firm-wide tracker list to status groups + summary counts.
 *   • Buckets rows by their FRIENDLY status LABEL (raw tracker enum → label via
 *     the canonical catalog); a null/blank status falls into an "Unknown status"
 *     bucket and an unmapped raw value into its own humanized-label bucket, so
 *     nothing is silently dropped and unknowns stay visible.
 *   • Orders groups by phase (in-flight → attention → completed, as the page has
 *     always banded them), then by the canonical lifecycle order index within a
 *     band (label as the final tiebreak) for a stable, deterministic order.
 *   • Tone + phase come from the catalog (the same source the drawer/detail card
 *     use), so a group's color and its rows' pills always agree.
 *   • Marks each row linked vs un-linked with record-id PRECEDENCE:
 *     `linkedByRecordId` (tracker record `id` → transferId — the PRIMARY link
 *     key, matches record-id-linked transfers incl. UUID-less "N/A" records)
 *     first, then `linkedTransferIds` (acatTransferId → transferId — the
 *     legacy UUID leg for transfers linked before record-id linking). Both are
 *     built from the caller's visible transfers. Omit the maps (or pass empty)
 *     and every row is treated as un-linked.
 *   • EXCLUDES terminal statuses this tab hides (today: Rejected) BEFORE
 *     grouping and counting — no Rejected group renders and Rejected rows never
 *     inflate any summary count (the external tracker link remains the place to
 *     review terminal records). Mismatch-based needs-attention on the remaining
 *     (non-Rejected) rows is preserved.
 *   • An empty/degraded list yields no groups and an all-zero summary.
 * PURE: no I/O, no ordering side effects on the input array.
 */
export function buildAcatTracking(
  rows: AcatListRow[],
  linkedTransferIds?: ReadonlyMap<string, string>,
  linkedByRecordId?: ReadonlyMap<string, string>,
): AcatTracking {
  // Display-level filter: drop terminal statuses the tab hides (Rejected) up
  // front so they leave the grouped list AND every summary count.
  const visible = rows.filter((r) => !isHiddenTrackingStatus(r.status));

  const enriched: AcatTrackingRow[] = visible.map((r) => {
    const transferId =
      linkedByRecordId?.get(r.id) ?? // PRIMARY: the tracker record PK
      linkedTransferIds?.get(r.acatTransferId) ?? // legacy UUID fallback
      null;
    return {
      ...r,
      linked: transferId != null,
      transferId,
      needsAttention:
        resolveAcatStatus(r.status).tone === "rejected" ||
        acatMapSummary(r.assetMap).warning,
    };
  });

  // Bucket by friendly label. Carry the catalog meta (tone/phase/order) so every
  // group in the same label shares one identity regardless of row order.
  const byLabel = new Map<
    string,
    { meta: ReturnType<typeof resolveAcatStatus>; rows: AcatTrackingRow[] }
  >();
  for (const row of enriched) {
    const meta = resolveAcatStatus(row.status);
    const bucket = byLabel.get(meta.label);
    if (bucket) bucket.rows.push(row);
    else byLabel.set(meta.label, { meta, rows: [row] });
  }

  const groups: AcatStatusGroup[] = [...byLabel.values()].map(
    ({ meta, rows: gRows }) => {
      const sorted = [...gRows].sort((a, b) =>
        recencyKey(b).localeCompare(recencyKey(a)),
      );
      return {
        label: meta.label,
        order: meta.order,
        tone: meta.tone,
        phase: meta.phase,
        count: sorted.length,
        rows: sorted,
      };
    },
  );

  groups.sort((a, b) => {
    const byPhase = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
    if (byPhase !== 0) return byPhase;
    const byOrder = a.order - b.order;
    return byOrder !== 0 ? byOrder : a.label.localeCompare(b.label);
  });

  const summary: AcatTrackingSummary = {
    total: enriched.length,
    inFlight: enriched.filter((r) => acatPhase(r.status) === "in_flight").length,
    attention: enriched.filter((r) => acatPhase(r.status) === "attention")
      .length,
    completed: enriched.filter((r) => acatPhase(r.status) === "completed")
      .length,
    needsAttention: enriched.filter((r) => r.needsAttention).length,
    linked: enriched.filter((r) => r.linked).length,
    unlinked: enriched.filter((r) => !r.linked).length,
  };

  return { groups, summary };
}
