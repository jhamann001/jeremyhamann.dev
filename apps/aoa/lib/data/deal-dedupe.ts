// One-time dedupe planning (tkt-deals-dedupe) — PURE: no Prisma import, so the
// dedupe script and its unit test share ONE definition of the decision rules.
//
// THE PROBLEM (verified in prod): `app.deal` is doubled. 267 legacy rows carry
// a 15-char `sf_deal_id` (the old one-time D4 import); 275 rows carry the
// 18-char form (`Deal: ID` from the live n8n CRM feed). A 15-char
// Salesforce id is the first 15 chars of its 18-char form — same deal — but the
// feed upserts on the full-width `sf_deal_id`, so it never matched the legacy
// rows and duplicated every deal. The 18-char rows are now the source of truth;
// the 15-char rows must be archived. A handful of legacy rows carry manual
// stage promotions (COMMITTED / FUNDING) the feed cannot reproduce (its twin
// sits at POTENTIAL) — those promotions are carried onto the twin first.
//
// `planDedupe` is the single decision function the script's dry-run and live
// paths both call, so what the dry-run reports is EXACTLY what the live run
// writes. The script owns the DB round-trips and the clock; this file owns the
// rules and stays deterministic (the caller passes `now`).

import type { DealStage, StageHistoryEntry } from "./deal-types";

// The two enum keys that encode a MANUAL promotion the feed can't reproduce
// ("Potential-Committed" / "Potential-In Process", see deal-types STAGE_LABEL).
export const CARRY_STAGES = ["COMMITTED", "FUNDING"] as const;
// Terminal stages: the feed is authoritative here, so a promotion is NEVER
// carried onto a twin the feed has already moved to WON/LOST.
export const TERMINAL_STAGES = ["WON", "LOST"] as const;

// Provenance strings written by the live run (kept here so the script and any
// test reference one source of truth).
export const CARRY_BY = "dedupe-legacy-migration"; // stage_history entry `by`
export const ARCHIVE_BY = "dedupe-legacy-15char"; // app.deal.archived_by

// The minimal row shape the planner needs (the script SELECTs exactly these).
export type DedupeRow = {
  id: string;
  sf_deal_id: string;
  stage: DealStage;
};

// A promotion to carry from a legacy row onto its POTENTIAL twin.
export type DedupeCarry = {
  twinId: string; // the current18 (source-of-truth) row to promote
  legacyId: string; // the legacy15 row the promotion came from
  key15: string; // the shared 15-char id (logging)
  fromStage: DealStage; // always POTENTIAL (the twin's current stage)
  toStage: DealStage; // COMMITTED | FUNDING (the legacy row's stage)
  entry: StageHistoryEntry; // appended to the twin's stage_history
};

// A legacy15 row to archive (it has a confirmed twin; the twin is authoritative).
export type DedupeArchive = {
  id: string;
  sf_deal_id: string;
};

// A legacy15 row with NO twin — never archived (we don't silently drop a
// historical deal); collected for manual review.
export type DedupeOrphan = {
  id: string;
  sf_deal_id: string;
  stage: DealStage;
};

export type DedupePlan = {
  carries: DedupeCarry[];
  archives: DedupeArchive[];
  orphans: DedupeOrphan[];
  // Counts (the dry-run report).
  legacy15Count: number;
  current18Count: number;
  twinsMatched: number; // legacy15 rows that resolved to a twin (== archives)
  terminalSkips: number; // promotions NOT carried because the twin is WON/LOST
};

const key15 = (sfDealId: string): string => sfDealId.slice(0, 15);

const isCarryStage = (s: DealStage): boolean =>
  (CARRY_STAGES as readonly string[]).includes(s);
const isTerminal = (s: DealStage): boolean =>
  (TERMINAL_STAGES as readonly string[]).includes(s);

/**
 * Compute the dedupe plan. Pure and deterministic — `now` (ISO) is stamped into
 * every carried stage_history entry so tests can assert exact output.
 *
 * Rules (operate on active `archived_at IS NULL` rows the caller supplies):
 *  1. Map each current18 row by its 15-char id prefix → `twinByKey`.
 *  2. For each legacy15 row:
 *     - no twin → ORPHAN (not archived);
 *     - has a twin → ARCHIVE the legacy row; AND, if the legacy stage is a
 *       manual promotion (COMMITTED / FUNDING):
 *         · twin at POTENTIAL      → CARRY the promotion onto the twin;
 *         · twin at WON / LOST     → SKIP the carry (terminal, feed wins) — the
 *                                    legacy row is still archived;
 *         · twin already promoted  → no carry, no skip (nothing to do).
 *  A twin is carried at most once (first legacy promotion wins) so two legacy
 *  rows pointing at one twin can't double-append.
 */
export function planDedupe(
  legacy15: DedupeRow[],
  current18: DedupeRow[],
  now: string,
): DedupePlan {
  const twinByKey = new Map<string, DedupeRow>();
  for (const row of current18) twinByKey.set(key15(row.sf_deal_id), row);

  const carries: DedupeCarry[] = [];
  const archives: DedupeArchive[] = [];
  const orphans: DedupeOrphan[] = [];
  const carriedTwins = new Set<string>();
  let terminalSkips = 0;

  for (const row of legacy15) {
    const twin = twinByKey.get(key15(row.sf_deal_id));
    if (!twin) {
      orphans.push({ id: row.id, sf_deal_id: row.sf_deal_id, stage: row.stage });
      continue;
    }

    // Confirmed twin → the legacy row is a duplicate; archive it.
    archives.push({ id: row.id, sf_deal_id: row.sf_deal_id });

    // Carry a manual promotion the feed can't reproduce.
    if (isCarryStage(row.stage)) {
      if (isTerminal(twin.stage)) {
        terminalSkips++; // feed already terminal — never override
      } else if (twin.stage === "POTENTIAL" && !carriedTwins.has(twin.id)) {
        carries.push({
          twinId: twin.id,
          legacyId: row.id,
          key15: key15(row.sf_deal_id),
          fromStage: "POTENTIAL",
          toStage: row.stage,
          entry: {
            stage: row.stage,
            from: "POTENTIAL",
            at: now,
            by: CARRY_BY,
          },
        });
        carriedTwins.add(twin.id);
      }
      // twin already COMMITTED/FUNDING → nothing to carry, not a terminal skip.
    }
  }

  return {
    carries,
    archives,
    orphans,
    legacy15Count: legacy15.length,
    current18Count: current18.length,
    twinsMatched: archives.length,
    terminalSkips,
  };
}
