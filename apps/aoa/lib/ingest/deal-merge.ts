import type { DealStage } from "@/lib/data/deal-types";

// The stage-merge rule for POST /api/ingest/deals (the FIRST ingest writer into
// an app-owned table). n8n replays the CRM pipeline nightly, but AOA is
// the source of truth for a deal's stage once it has advanced: the real feed
// only ever carries POTENTIAL / WON / LOST, and a non-terminal import must NEVER
// downgrade a stage an advisor has already moved forward inside the app.
//
// Rule (PURE — no Prisma, unit-tested directly in test/ingest/deals-route.test):
//   - incoming WON or LOST  → terminal, ALWAYS overwrites (a funded/lost deal is
//     funded/lost regardless of what the app shows);
//   - incoming POTENTIAL / COMMITTED / FUNDING → keep the STORED stage if the
//     deal already exists (never overwrite/downgrade with a non-terminal
//     import); a brand-new deal has no stored stage, so use the incoming one.
//
// `changed` drives BOTH the stage write and the stage_history append: it is true
// on insert (no stored stage) and whenever the effective stage differs from the
// stored one — so a preserved stage writes no history entry.

export type StageMerge = {
  /** The stage to persist (upsert `update.stage`; on insert this equals `incoming`). */
  stage: DealStage;
  /** True on insert or when `stage` differs from the stored stage — append history. */
  changed: boolean;
};

export function mergeStage(
  incoming: DealStage,
  existing: DealStage | null | undefined,
): StageMerge {
  const stage =
    incoming === "WON" || incoming === "LOST"
      ? incoming
      : (existing ?? incoming);
  return { stage, changed: existing == null || stage !== existing };
}
