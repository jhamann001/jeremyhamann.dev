import type { FunnelStage } from "./types";
import type { DealStage, StageHistoryEntry } from "./deal-types";
import { STAGE_LABEL } from "./deal-types";

// Command Center "Transfer pipeline" funnel — the PURE bucketer (rows in →
// FunnelStage[] out). No Prisma, no `server-only`, no clock of its own (`now` is
// injected): this repo has no React component-test harness, so the card's rules
// live here where a unit test can pin them. The DB query is the thin server-only
// reader in lib/data/deal-funnel.ts.
//
// UNIT = the DEAL (owner decision, 2026-07-27). One row is counted once, in one
// stage bucket, so nothing double-counts against the transfers pipeline. The
// mock fixture's "Proposal" bucket is DROPPED — no such stage exists in CRM
// or in AOA (DealStage is POTENTIAL | COMMITTED | FUNDING | WON | LOST).
//
// Labels come from STAGE_LABEL (the CRM display vocabulary) — never
// hardcoded here, so a relabel lands on this card for free.

/**
 * The minimal `app.deal` projection the funnel needs. Deliberately narrow (five
 * columns) so the read stays cheap and the pure function has nothing PII-ish to
 * hold. `created_date` is CRM's BUSINESS creation date — deliberately not
 * `created_at`, which is the row-insert timestamp (every CSV-imported deal
 * shares the one import instant, so it carries no per-deal signal).
 */
export type FunnelDealRow = {
  stage: DealStage;
  created_date: Date | null;
  last_activity_date: Date | null;
  stage_history: StageHistoryEntry[] | null;
  archived_at: Date | null;
};

/** Pipeline order, tone and blurb per bucket. LOST is absent by design — a lost
 *  deal is out of the pipeline, not a stage of it. The tone sequence
 *  (blue → gold → amber → green, then red for the overlay) is the mock's, so the
 *  card's shape is unchanged when the flag flips. */
const PIPELINE: readonly {
  stage: DealStage;
  tone: FunnelStage["tone"];
  desc: string;
}[] = [
  { stage: "POTENTIAL", tone: "blue", desc: "Open opportunities" },
  { stage: "COMMITTED", tone: "gold", desc: "Committed, not yet funding" },
  { stage: "FUNDING", tone: "amber", desc: "Funding in process" },
  // All-time, unlike the three buckets above it (which are current state).
  // Said plainly in the desc so the number is not read as "this period".
  { stage: "WON", tone: "green", desc: "Assets received · all time" },
];

/** Stages a deal can still stall IN. WON is terminal — a funded deal that has
 *  not moved in a month is finished, not stuck. */
const AT_RISK_STAGES = new Set<DealStage>(["POTENTIAL", "COMMITTED", "FUNDING"]);

/** Strictly MORE than this many whole days without movement = at risk. Exactly
 *  30 is not at risk; 31 is. Matches the mock card's "Stalled > 30 days". */
export const AT_RISK_DAYS = 30;

export const AT_RISK_LABEL = "At risk";

/** Says out loud that this segment is an OVERLAY, not a sixth bucket: every deal
 *  it counts is also counted in its own stage above. */
export const AT_RISK_DESC = "Stalled 30+ days · also in the stages above";

const DAY_MS = 86_400_000;

function ms(d: Date | null | undefined): number | null {
  if (d == null) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * A stage_history entry is a REAL TRANSITION only when it carries a prior stage.
 *
 * Every writer stamps the OPENING entry — "this deal first existed / AOA first
 * saw it" — with `from: null`, and only that entry:
 *   • /api/ingest/deals: `from: existingStage`, and `existingStage` is
 *     `existing?.stage ?? null`, so it is null exactly on CREATE;
 *   • the in-app create action (app/(authenticated)/deals/actions.ts):
 *     `stageEntry(input.stage, null, …)` — "the timeline starts at creation";
 *   • every real move (in-app stage edit, ingest stage merge, the dedupe carry)
 *     passes the stage it moved FROM.
 * DealDetail already reads it this way, rendering a `from`-less entry as
 * "· created" rather than as a move.
 *
 * Absent/undefined `from` is treated as an opening entry too (fail-safe: an
 * entry that cannot prove it was a transition is not counted as one).
 */
function isRealTransition(entry: StageHistoryEntry | null | undefined): boolean {
  return entry?.from != null;
}

/**
 * When this deal last visibly MOVED — the most recent of three signals, because
 * no single one is populated across the whole book:
 *
 *  1. the latest `stage_history[].at` of a REAL TRANSITION (see
 *     `isRealTransition`). Coverage differs sharply by write path, and BOTH
 *     shapes are live at once:
 *       – CSV-imported rows (lib/deals/import-csv.ts) have NO history at all —
 *         the importer never writes the column (0 of 24 rows in the local seed).
 *       – Ingest-created rows (/api/ingest/deals — the path dev and prod
 *         actually run) ALWAYS carry at least one entry: the opening
 *         `from: null` stamp written on create, dated at the ingest run, not at
 *         any business event.
 *     So "has a stage_history entry" does NOT mean "has moved". Only entries
 *     with a prior stage count; the opening stamp is skipped. Counting it was
 *     the bug behind at-risk reading 0 on dev with 110 open deals — a nightly
 *     ingest re-stamped every deal as freshly "moved", so nothing could ever
 *     age past the threshold.
 *  2. `last_activity_date` — CRM's last logged touch. Sparse (2 of 24 in
 *     the local seed), so it cannot stand alone, but when it IS set it stops us
 *     calling a deal stalled that somebody worked last week.
 *  3. `created_date` — CRM's business creation date. Populated on 100% of
 *     rows with a real spread, so it is the always-present FLOOR: a deal nobody
 *     has touched since it was created has been sitting since it was created.
 *
 * Taking the MAX of those three still holds, and now means what it claims: the
 * answer only gets more generous as a genuinely newer BUSINESS signal arrives,
 * never because a pipeline re-read the row. Entries with unparseable/absent
 * timestamps contribute nothing; a row with no usable date at all returns null
 * (and is never flagged — fail-open, we do not accuse a deal of stalling on
 * missing data).
 */
export function lastMovementAt(row: FunnelDealRow): Date | null {
  let best: number | null = null;
  const consider = (t: number | null) => {
    if (t != null && (best == null || t > best)) best = t;
  };
  for (const entry of row.stage_history ?? []) {
    if (!isRealTransition(entry)) continue;
    consider(entry?.at ? ms(new Date(entry.at)) : null);
  }
  consider(ms(row.last_activity_date));
  consider(ms(row.created_date));
  return best == null ? null : new Date(best);
}

/** Whole days since the deal last moved; null when it has no usable date. */
export function daysSinceLastMovement(
  row: FunnelDealRow,
  now: Date,
): number | null {
  const at = lastMovementAt(row);
  if (at == null) return null;
  return Math.floor((now.getTime() - at.getTime()) / DAY_MS);
}

/** At risk = live, non-terminal, and untouched for more than AT_RISK_DAYS. */
export function isAtRisk(row: FunnelDealRow, now: Date): boolean {
  if (row.archived_at != null) return false;
  if (!AT_RISK_STAGES.has(row.stage)) return false;
  const days = daysSinceLastMovement(row, now);
  return days != null && days > AT_RISK_DAYS;
}

/**
 * The five funnel segments: four stage buckets in pipeline order, then the "At
 * risk" overlay. Always returns all five (zero-filled) so an empty book renders
 * the card rather than an empty div.
 *
 * Excluded here as well as in the reader's WHERE clause (belt and braces — the
 * exclusions are UI rules and this is where they are tested):
 *   • `archived_at IS NOT NULL` — D7 soft delete; an archived deal has left the pipeline.
 *   • LOST — terminal, and not part of an ACTIVE pipeline.
 *   • any stage outside PIPELINE — unknown values are dropped, never bucketed blind.
 */
export function dealFunnelStages(
  rows: readonly FunnelDealRow[],
  now: Date = new Date(),
): FunnelStage[] {
  const counts = new Map<DealStage, number>(PIPELINE.map((p) => [p.stage, 0]));
  let atRisk = 0;

  for (const row of rows) {
    if (row.archived_at != null) continue;
    const current = counts.get(row.stage);
    if (current === undefined) continue; // LOST / unknown
    counts.set(row.stage, current + 1);
    if (isAtRisk(row, now)) atRisk += 1;
  }

  return [
    ...PIPELINE.map((p) => ({
      stage: STAGE_LABEL[p.stage],
      count: counts.get(p.stage) ?? 0,
      desc: p.desc,
      tone: p.tone,
    })),
    { stage: AT_RISK_LABEL, count: atRisk, desc: AT_RISK_DESC, tone: "red" },
  ];
}
