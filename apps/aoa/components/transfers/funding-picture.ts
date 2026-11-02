import type { AcatStatusAsset } from "@/lib/data/acat-status";
import { isAcatFunding } from "@/lib/data/transfer-types";
import type { FundingType } from "@/lib/data/transfer-types";

// Pure helpers for the Full Funding Picture rework (ticket Slice 5). PURE: no
// Prisma, no React, no server-only import (the AcatStatusAsset import is TYPE
// ONLY — erased at runtime — so this module stays consumable by the node vitest
// env). The server card renders these; the tracker read stays in the data layer.

/**
 * Whether a transfer is funded by a *genuinely linked* ACAT — the ONLY state
 * that reads the tracker's redacted asset map (Slice 5, §1.5c). Requires an
 * ACAT rail (`isAcatFunding` — ACAT_FULL or ACAT_PARTIAL) AND a real, non-blank
 * link id: the tracker RECORD PK (`acat_record_id` — primary, record-id
 * linking; covers UUID-less "N/A" tracker records) OR the legacy
 * `acat_transfer_id` UUID (rows linked before record-id linking). Per the #151
 * reconciliation the sole writer of BOTH columns is the hardened
 * AcatLinkPicker / acat-link.ts path (each backed by its own partial unique
 * index), which refuses blanks/placeholders — so a non-blank id is real. The
 * blank guards are belt-and-braces so we NEVER key the tracker on ""/"N/A".
 */
export function isAcatLinked(
  fundingType: FundingType | null,
  acatTransferId: string | null,
  acatRecordId: string | null,
): boolean {
  return isAcatFunding(fundingType) && hasAcatLink(acatTransferId, acatRecordId);
}

/**
 * Whether the transfer stores a real, non-blank ACAT link id AT ALL — record
 * id (primary) or legacy UUID — REGARDLESS of funding type. This gates the
 * hub's ACAT-status row and the tracker-count line: the ACAT-link writer never
 * sets funding_type, so an id-linked transfer with funding_type null/CHECK/
 * WIRE/ACH must still show its live status (the removed standalone section
 * gated on ids alone; this preserves that contract). `isAcatLinked` above
 * stays deliberately rail-dependent — it drives the funding-type row's
 * affordances, not the status view.
 */
export function hasAcatLink(
  acatTransferId: string | null,
  acatRecordId: string | null,
): boolean {
  return (
    (typeof acatRecordId === "string" && acatRecordId.trim() !== "") ||
    (typeof acatTransferId === "string" && acatTransferId.trim() !== "")
  );
}

/** Whether the hub's Trade-requests row renders (S4): only when the transfer's
 *  client resolved to a non-blank cedar_ridge_user_id (transfer.client_sf_id →
 *  mirror.client.cedar_ridge_user_id, resolved server-side on the page). A transfer
 *  with no client_sf_id — or a client with no id — shows no row (nothing to join
 *  on), the same "no client, no link" limit as elsewhere. Trim-aware, mirroring
 *  hasAcatLink. */
export function tradeRequestRowVisible(
  tradeRequestUserId: string | null,
): boolean {
  return (
    typeof tradeRequestUserId === "string" && tradeRequestUserId.trim() !== ""
  );
}

/** Rollup of the redacted asset-map projection for the Asset Mapping row: the
 *  position count, how many carry an asset class (classified), and how many
 *  raise a reconciliation flag (`issue != null`). Counts only — no PII, no
 *  position lines leave here (the full masked table lives on /acat-tracking). */
export type AssetMapSummary = {
  total: number;
  classified: number;
  issues: number;
};

export function assetMapSummary(assets: AcatStatusAsset[]): AssetMapSummary {
  let classified = 0;
  let issues = 0;
  for (const a of assets) {
    if (a.assetClass != null) classified += 1;
    if (a.issue != null) issues += 1;
  }
  return { total: assets.length, classified, issues };
}

/** Deal-row mode for the hub: "linked" → expandable deal summary; "rollup" →
 *  the household-rollup link row (unchanged, no expansion); "none" → empty
 *  state (no-household vs no-deals text chosen by the caller from deals). */
export type DealRowMode = "linked" | "rollup" | "none";
export function dealRowMode(hasLinkedDeal: boolean, rollupCount: number): DealRowMode {
  if (hasLinkedDeal) return "linked";
  return rollupCount > 0 ? "rollup" : "none";
}

/** Whether the assigned-map expansion renders: #186's flag must be ON and the
 *  transfer must carry the full assignment triple (folder + custodian + number
 *  — the same all-three condition FundingPictureCard uses for `current`).
 *  Blank-string parts count as unset (same trim posture as hasAcatLink, and
 *  the same effective gate the page's fetch uses). */
export function assignedMapExpandable(
  flagEnabled: boolean,
  folderId: string | null,
  custodian: string | null,
): boolean {
  const set = (v: string | null): boolean => v != null && v.trim() !== "";
  // S5: a linked account no longer needs an account_number — folder + custodian
  // (+ type in the stored key) identify it, so numberless links are expandable too.
  return flagEnabled && set(folderId) && set(custodian);
}

/** Rollup line for the assigned account's positions ("N positions · $X"). Pure
 *  over the plain rows the read seam returns; null market values are skipped
 *  in the total (never NaN). */
export type AssignedPositionsRollup = { count: number; totalValue: number };
export function assignedPositionsRollup(
  positions: ReadonlyArray<{ marketValue: number | null }>,
): AssignedPositionsRollup {
  let totalValue = 0;
  for (const p of positions) if (p.marketValue != null) totalValue += p.marketValue;
  return { count: positions.length, totalValue };
}
