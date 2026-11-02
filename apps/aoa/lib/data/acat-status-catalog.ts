import type { AcatToneKind } from "./acat-lane";

// CANONICAL ACAT STATUS CATALOG (ticket).
//
// The Transfer Tracker returns RAW PascalCase enum values (e.g. "PendingSettlement",
// "ToCome", "AcatReceived"), NOT the friendly labels an operator reads on the
// live tracker. The ACAT Tracking page used to display and group by that raw
// value, so (1) a "Pending Settlement" ACAT showed under a "PendingSettlement"
// header — never the friendly group the owner expects — and (2) the list row and
// the detail modal each classified the raw value with their OWN ad-hoc tone
// regex, so the same ACAT could render a different pill on the tab vs the modal.
//
// This module is the SINGLE SOURCE OF TRUTH that maps every raw tracker enum
// value → a friendly display label + a lifecycle order index + an ordering phase
// + a semantic tone. Everywhere the ACAT status is shown or ordered routes
// through `resolveAcatStatus`, so the label, tone and position are identical on
// the list, the drawer header and the detail card.
//
// PURE: no Prisma / server-only import, so it is fully unit-testable in the node
// vitest env (the acat-lane / acat-tracking idiom).
//
// SOURCE OF THE RAW VALUES: the tracker owns the vocabulary. The exact raw
// strings below were taken verbatim from the tracker's `AcatStatus` enum
// (transfer-tracker/transfer-tracker: prisma/schema.prisma `enum AcatStatus`
// and src/lib/types.ts `ACAT_STATUSES` / `ACAT_STATUS_LABELS`) and confirmed
// against live tracker data via the transfer-tracker MCP (e.g. a live
// "PendingSettlement" record). The 16 lifecycle statuses are the owner-provided
// canonical set; the tracker enum ALSO carries three legacy recon-derived values
// (Matched / Mismatch / Pending) kept so legacy records still render — they are
// mapped here too (with the tracker's own "Recon: …" labels) so the catalog is
// exhaustive against the enum. Any value NOT in this map falls back to a
// title-cased, space-inserted label and stays visible in its own group.

/** Lifecycle phase used to ORDER the status groups (in-flight first,
 *  needs-attention/terminal next, completed last — the page's existing band
 *  order). Derived from the tracker vocabulary; never replaces it. */
export type AcatPhase = "in_flight" | "attention" | "completed";

/** Rank of each phase for the primary group sort (in-flight → attention →
 *  completed, as the page has always ordered). Within a band, groups sort by the
 *  canonical lifecycle `order` index below. */
export const PHASE_RANK: Record<AcatPhase, number> = {
  in_flight: 0,
  attention: 1,
  completed: 2,
};

/** Resolved metadata for a raw tracker status value. */
export type AcatStatusMeta = {
  /** The raw tracker value this was resolved from (trimmed; "" for blank). */
  raw: string;
  /** Friendly display label (what the operator reads on the live tracker). */
  label: string;
  /** 1-based canonical lifecycle order index (higher = later in the flow).
   *  Unknown/blank values sort after everything known but stay visible. */
  order: number;
  /** Ordering / summary phase. */
  phase: AcatPhase;
  /** Semantic tone (reuses the AcatToneKind vocabulary → Pill green/amber/red/
   *  gray). */
  tone: AcatToneKind;
  /** True when the raw value was found in the catalog; false for the fallback. */
  known: boolean;
};

type CatalogEntry = Pick<AcatStatusMeta, "label" | "order" | "phase" | "tone">;

/**
 * Exhaustive raw-tracker-enum → metadata map, in canonical lifecycle order.
 * Keyed on the EXACT raw enum strings the tracker returns.
 *
 * Phases: 1–11 are in-flight; Completed is completed; Rejected / Purged /
 * Canceled / Deferred are the needs-attention / terminal band (Deferred is a
 * TERMINAL status on the tracker, so it sits with the other terminals rather
 * than in-flight). The three legacy recon-derived values trail the lifecycle.
 */
export const ACAT_STATUS_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  // 1–11 — in flight
  WaitingForApex: { label: "Waiting for Apex", order: 1, phase: "in_flight", tone: "neutral" },
  PendingAccountOpening: { label: "Pending Account Opening", order: 2, phase: "in_flight", tone: "submitted" },
  WaitingOnClient: { label: "Waiting on Client", order: 3, phase: "in_flight", tone: "neutral" },
  AcatReceived: { label: "ACAT Received", order: 4, phase: "in_flight", tone: "accepted" },
  ToCome: { label: "To Come", order: 5, phase: "in_flight", tone: "neutral" },
  Submitted: { label: "Submitted", order: 6, phase: "in_flight", tone: "submitted" },
  PendingReview: { label: "Pending Review", order: 7, phase: "in_flight", tone: "submitted" },
  PendingContraResponse: { label: "Pending Contra Response", order: 8, phase: "in_flight", tone: "submitted" },
  Accepted: { label: "Accepted", order: 9, phase: "in_flight", tone: "accepted" },
  PendingSettlement: { label: "Pending Settlement", order: 10, phase: "in_flight", tone: "submitted" },
  PendingBookkeeping: { label: "Pending Bookkeeping", order: 11, phase: "in_flight", tone: "submitted" },
  // 12 — completed
  Completed: { label: "Completed", order: 12, phase: "completed", tone: "accepted" },
  // 13–16 — needs-attention / terminal
  Rejected: { label: "Rejected", order: 13, phase: "attention", tone: "rejected" },
  Purged: { label: "Purged", order: 14, phase: "attention", tone: "neutral" },
  Canceled: { label: "Canceled", order: 15, phase: "attention", tone: "rejected" },
  Deferred: { label: "Deferred", order: 16, phase: "attention", tone: "neutral" },
  // Legacy recon-derived values (kept on the tracker enum so legacy records
  // still render). Not part of the owner's 16 lifecycle statuses; mapped to the
  // tracker's own "Recon: …" labels and ordered after the lifecycle.
  Matched: { label: "Recon: Matched", order: 17, phase: "completed", tone: "accepted" },
  Mismatch: { label: "Recon: Mismatch", order: 18, phase: "attention", tone: "rejected" },
  Pending: { label: "Recon: Pending", order: 19, phase: "in_flight", tone: "submitted" },
};

/** The raw tracker enum keys this catalog maps, in canonical order. */
export const CANONICAL_ACAT_STATUS_KEYS: readonly string[] =
  Object.keys(ACAT_STATUS_CATALOG);

/** Order index for the blank / null "Unknown status" bucket — after every real
 *  status but before any humanized-unknown so the two never interleave. */
const BLANK_ORDER = 998;
/** Order index for a non-blank but UNMAPPED status — after everything known so
 *  a status the tracker adds later surfaces at the end of its band, visible. */
const UNKNOWN_ORDER = 999;

/** Label shown for a null / blank status (nothing is ever silently dropped). */
export const UNKNOWN_STATUS_LABEL = "Unknown status";

/**
 * SAFE FALLBACK for an unmapped raw value: split PascalCase / snake / kebab into
 * words and upper-case each word's first letter, so an unknown enum the tracker
 * adds later renders readable ("SomeNewStatus" → "Some New Status") rather than
 * crashing or disappearing.
 */
export function humanizeStatus(raw: string): string {
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const titled = spaced.replace(/\b\w/g, (c) => c.toUpperCase());
  return titled || raw;
}

/**
 * Resolve a raw tracker status value to its canonical display metadata. Never
 * throws and never returns null:
 *   • a known raw enum value → its catalog entry;
 *   • a null / blank value → the "Unknown status" bucket (neutral, attention);
 *   • any other value → a humanized label (neutral, attention) that stays
 *     visible in its own group.
 * Unknown/blank values sit in the attention band (an unmapped status is exactly
 * what an operator should notice) but never claim a canonical tone/order.
 */
export function resolveAcatStatus(
  raw: string | null | undefined,
): AcatStatusMeta {
  const key = (raw ?? "").trim();
  if (key === "") {
    return {
      raw: "",
      label: UNKNOWN_STATUS_LABEL,
      order: BLANK_ORDER,
      phase: "attention",
      tone: "neutral",
      known: false,
    };
  }
  const hit = ACAT_STATUS_CATALOG[key];
  if (hit) {
    return { raw: key, known: true, ...hit };
  }
  return {
    raw: key,
    label: humanizeStatus(key),
    order: UNKNOWN_ORDER,
    phase: "attention",
    tone: "neutral",
    known: false,
  };
}

/** Hue ids for the ACAT book (epic hue list). Separate from the catalog tone so
 *  the flag-off page keeps its four tones. WaitingForStatement is on the tracker
 *  enum but not in the catalog. */
export const ACAT_BOOK_HUES = [
  "slate", "blue", "amber", "sky", "indigo", "violet", "cyan", "teal", "emerald",
  "lime", "purple", "green", "red", "gray", "orange", "yellow", "unknown",
] as const;
export type AcatBookHue = (typeof ACAT_BOOK_HUES)[number];

const ACAT_BOOK_HUE_BY_STATUS: Readonly<Record<string, AcatBookHue>> = {
  WaitingForApex: "slate",
  PendingAccountOpening: "blue",
  WaitingOnClient: "amber",
  WaitingForStatement: "amber",
  AcatReceived: "sky",
  ToCome: "indigo",
  Submitted: "violet",
  PendingReview: "cyan",
  PendingContraResponse: "teal",
  Accepted: "emerald",
  PendingSettlement: "lime",
  PendingBookkeeping: "purple",
  Completed: "green",
  Rejected: "red",
  Purged: "gray",
  Canceled: "orange",
  Deferred: "yellow",
};

export function acatBookHue(raw: string | null | undefined): AcatBookHue {
  return ACAT_BOOK_HUE_BY_STATUS[(raw ?? "").trim()] ?? "unknown";
}
