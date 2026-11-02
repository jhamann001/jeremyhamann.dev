import { Prisma } from "@prisma/client";
import { withUserScope } from "@/lib/rls";
import type { Identity } from "./types";
import type {
  TransferRow,
  TransferTaskRow,
  TransferDecisionRow,
  TransferAccountRow,
} from "./transfer-types";
import {
  DECISION_HIDDEN_TASK_TITLES,
  PARTIAL_ACAT_ONLY_TASK_TITLES,
  DEFAULT_TASKS,
  STATEMENTS_TITLE,
  ASSET_MAPPER_TITLE,
} from "./transfer-types";
import {
  mergeCloseoutItems,
  type SlackCloseoutItemView,
} from "./slack-closeout-template";
import { hideDemoTransferCardsEnabled } from "@/lib/flags";
import type { DerivedReceivingAccount } from "./receiving-account-match";
import { drsStageTaskProgressJoin } from "./drs-workflow-query";

// Transfers seam (TDD ticket §4 — signatures FROZEN: T3's detail route and
// server actions compile against `listTransfers` / `getTransfer` /
// `transferOpsStats` and the exported row types; only BODIES may change later,
// e.g. the Phase D read-time sf_id join). Every read runs inside
// `withUserScope`, so the Postgres RLS policies decide visibility — the
// functions add NO role branching. Today's locked posture (TDD ADR-4,
// all-roles-read) means every app role — VIEWER included — sees the identical
// board; if book scoping tightens later, only the DB policies change.
//
// DECIMAL TRAP (carried, see lib/data/deals.ts): `value` and the decision
// rows' `value`/`cost_basis` are Postgres `numeric` → Prisma hands back
// Decimal objects at runtime, which do NOT serialize across the Server →
// Client Component boundary (TransferBoard is "use client"). Coerce with
// Number() HERE, at the seam, before a row ever reaches a component. Same for
// the aggregates (COUNT → bigint, SUM → Decimal).
//
// Derived, never stored (TDD ADR-2/ADR-7, locked 2026-07-02):
//   daysInStage — from `stage_entered_at` (reset on every stage transition).
//   bouncing    — owner_kind === "ADVISOR" && stage !== "FUNDED".

/** Board row: the full record + task counts + the two derived fields. */
export type TransferBoardRow = TransferRow & {
  tasksDone: number;
  tasksTotal: number;
  /** First unfinished task in the same visible/current-stage projection as X/Y. */
  nextIncompleteTask: string | null;
  /** Board-only enrichment; omitted by shared listTransfers callers. */
  receivingAccount?: DerivedReceivingAccount | null;
  daysInStage: number;
  bouncing: boolean;
};

/** Detail: the full record + its three child collections (T3's read). */
export type TransferDetail = TransferRow & {
  tasks: TransferTaskRow[];
  decisions: TransferDecisionRow[];
  accounts: TransferAccountRow[];
};

/** Opsbar aggregates — SQL-computed, never hard-coded (the mockup's
 *  fabricated `$38M · 27` is deliberately NOT reproduced). */
export type TransferOpsStats = {
  /** SUM(value) over non-FUNDED transfers (the in-flight book, $). */
  outstanding: number;
  /** COUNT(*) of non-FUNDED transfers. */
  active: number;
  /** COUNT(*) of ADVISOR-owned non-FUNDED transfers (the derived rule). */
  bouncing: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days since the record entered its current stage (floor, never
 *  negative — a just-moved record reads 0d). */
const daysInStage = (enteredAt: Date): number =>
  Math.max(0, Math.floor((Date.now() - new Date(enteredAt).getTime()) / MS_PER_DAY));

type RawBoardRow = TransferRow & {
  tasksDone: bigint;
  tasksTotal: bigint;
  nextIncompleteTask: string | null;
};

/** Options for {@link listTransfers}. */
export type ListTransfersOptions = {
  /**
   * Count only the current stage's DEFAULT_TASKS, matching StageChecklistCard.
   * The Asset Transfer board enables this with CHECKLIST_STAGE_GATE; shared
   * ACAT/meeting consumers keep the legacy all-task projection by default.
   */
  currentStageChecklistOnly?: boolean;
  /**
   * Board fall-off (TKT board-behavior). When true, a FUNDED transfer with NO
   * incomplete checklist task (every to-do done — or zero tasks, vacuously) is
   * omitted from the result. DEFAULT false: `listTransfers` is a SHARED seam
   * with three callers, and only the Asset Transfer BOARD wants this filter —
   * the Transfer-Tracker consumers (components/transfers/AcatTrackingData.tsx build
   * the acat_transfer_id → transfer.id map + linked/unlinked KPIs; the
   * acat-tracking loadLinkTargets action) MUST still see completed-FUNDED
   * transfers, or a linked ACAT would wrongly flip linked→unlinked. So the
   * filter is opt-in per caller, never applied at the seam unconditionally.
   */
  hideCompletedFunded?: boolean;
  /**
   * Archived fall-off (feat/transfer-archive-falloff). DEFAULT false: archived
   * transfers (archived_at set — by the S4 reconciler's deal_lost/uncommitted
   * sweeps or the manual archive action) are EXCLUDED, mirroring the deals D7
   * posture (listDeals: `WHERE archived_at IS NULL`). This is the seam-level
   * bug fix: the reconciler stamped archived_at but no read respected it, so
   * archived transfers stayed on the board as zombie cards. Unlike
   * hideCompletedFunded this default applies to EVERY caller — an archived
   * transfer is out of the working set, not merely off one view. Opt IN with
   * `includeArchived: true` when archived rows still matter (AcatTrackingData's
   * linkage map — an ACAT linked to an archived transfer must stay "linked",
   * and its "View transfer →" deep link still resolves via getTransfer).
   */
  includeArchived?: boolean;
};

export function transferBoardQuery(
  options: ListTransfersOptions = {},
): Prisma.Sql {
  const {
    hideCompletedFunded = false,
    includeArchived = false,
    currentStageChecklistOnly = false,
  } = options;
  // The WHERE clause is composed from TWO independent predicates, each degrading
  // to TRUE when inactive, ANDed under one always-present WHERE. Both fragments
  // are static SQL (no user input); the parentheses around the fall-off's OR are
  // load-bearing — `archived AND (not-funded OR EXISTS…)`, never
  // `(archived AND not-funded) OR EXISTS…`.
  //
  // Archived fall-off — default ON (see ListTransfersOptions.includeArchived).
  const archivedFilter = includeArchived
    ? Prisma.sql`TRUE`
    : Prisma.sql`t.archived_at IS NULL`;
  // Canonical dev may contain both the repository's stable DEMO-T-* baseline
  // and transfers materialized by the reconciler from synthetic DEMO-* deals.
  // Hide both shapes when the dev parity switch is on. Prefer the transfer's
  // snapshotted external id, but fall back to the joined deal so an older or
  // partially reconciled row cannot leak. This is a read filter, not cleanup:
  // rollback is an env-var flip and the seed remains idempotent/recoverable.
  const demoFilter = hideDemoTransferCardsEnabled()
    ? Prisma.sql`(t.id NOT LIKE 'DEMO-T-%'
        AND COALESCE(t.deal_sf_id, d.sf_deal_id, '') NOT LIKE 'DEMO-%')`
    : Prisma.sql`TRUE`;
  // Board fall-off filter — opt-in per caller. The correlated NOT-done EXISTS
  // runs in the same withUserScope/RLS tx as the outer read, so a FUNDED
  // transfer's task rows are visible under the identical policy. Keep a row iff
  // it is not-FUNDED, OR it still has ≥1 incomplete task. Edge: a FUNDED
  // transfer with ZERO tasks → EXISTS is false → hidden (vacuously "no
  // incomplete task"). The clause sits before GROUP BY and touches only t
  // (grouped by its PK) + the correlated subquery, so it never perturbs the
  // tasksDone/tasksTotal aggregates for the rows that remain.
  // S2: the "incomplete task" test resolves the synced tasks against the linked
  // deal (COALESCE(override_done, deal flag, done)) — the SAME resolution as the
  // tasksDone CASE below and resolveTaskDone — so a deal-completed FUNDED transfer
  // (its synced rows auto-done via the mirror, raw `done` still false) correctly
  // falls off. It references the outer `d` (LEFT JOIN app.deal, below); no deal →
  // NULL → COALESCE falls to raw `tt.done` (pre-S2 behavior).
  const boardFilter = hideCompletedFunded
    ? Prisma.sql`(t.stage <> 'FUNDED'
         OR CASE WHEN t.funding_type::text = 'DRS'
           THEN drs_progress.done < drs_progress.total
           ELSE EXISTS (
              SELECT 1 FROM app.transfer_task tt
              WHERE tt.transfer_id = t.id
                ${
                  currentStageChecklistOnly
                    ? Prisma.sql`AND tt.title = ANY(${[
                        ...DEFAULT_TASKS.FUNDED,
                      ]}::text[])`
                    : Prisma.empty
                }
                AND NOT (
                  CASE tt.title
                    WHEN ${STATEMENTS_TITLE} THEN COALESCE(tt.override_done, d.statements, tt.done)
                    WHEN ${ASSET_MAPPER_TITLE} THEN COALESCE(tt.override_done, d.asset_mapped, tt.done)
                    ELSE tt.done
                  END
                )
            ) END)`
    : Prisma.sql`TRUE`;
  const checklistJoin = currentStageChecklistOnly
    ? Prisma.sql`AND (
        (t.stage::text = 'DECISION'
          AND k.title = ANY(${[...DEFAULT_TASKS.DECISION]}::text[])
          AND NOT (
            k.title = ANY(${[...PARTIAL_ACAT_ONLY_TASK_TITLES]}::text[])
            AND t.funding_type::text IS DISTINCT FROM 'ACAT_PARTIAL'
          ))
        OR (t.stage::text = 'IN_TRANSFER'
          AND k.title = ANY(${[...DEFAULT_TASKS.IN_TRANSFER]}::text[]))
        OR (t.stage::text = 'FUNDED'
          AND k.title = ANY(${[...DEFAULT_TASKS.FUNDED]}::text[]))
      )`
    : Prisma.sql`AND NOT (
        t.stage::text = 'DECISION'
        AND (
          k.title = ANY(${[...DECISION_HIDDEN_TASK_TITLES]}::text[])
          OR (
            k.title = ANY(${[...PARTIAL_ACAT_ONLY_TASK_TITLES]}::text[])
            AND t.funding_type::text IS DISTINCT FROM 'ACAT_PARTIAL'
          )
        )
      )`;
  // One definition for both the completed count and first incomplete task.
  // Keep this aligned with resolveTaskDone (transfer-types.ts).
  const resolvedTaskDone = Prisma.sql`CASE k.title
    WHEN ${STATEMENTS_TITLE} THEN COALESCE(k.override_done, d.statements, k.done)
    WHEN ${ASSET_MAPPER_TITLE} THEN COALESCE(k.override_done, d.asset_mapped, k.done)
    ELSE k.done
  END`;
  return Prisma.sql`
      SELECT t.id, t.source, t.client_first_name, t.client_last_name,
             t.client_sf_id, t.household_name, t.household_sf_id,
             -- value follows the linked deal LIVE (deal owns the amount — mirrors
             -- resolveTransferValue: COALESCE(d.amount, t.value)). d is at most one
             -- row per transfer (deal_id → PK) and is in GROUP BY, so no fan-out.
             COALESCE(d.amount, t.value) AS value,
             t.stage, t.stage_entered_at, t.owner_kind, t.owner_name,
             t.next_step, t.next_step_owner, t.pending_nudge,
             t.acat_transfer_id,
             t.funding_type, t.recorded_funding_type, t.funding_method_revision,
             t.drs_method_change_pending, t.funding_route_change_pending,
             t.accounts_opened_at_apex, t.funding_plan_complete,
             t.funding_plan_version, t.funding_plan_approved_at,
             t.funding_plan_approved_by,
             t.funding_initiated, t.cash_in_flight, t.deal_id, t.deal_sf_id,
             t.transferring_firm, t.archived_at, t.archived_by,
             t.archived_reason, t.sync_flag, t.acat_record_id,
             t.asset_map_folder_id, t.asset_map_custodian, t.asset_map_account_number,
             t.asset_map_account_type,
             t.created_by, t.updated_by, t.created_at, t.updated_at,
             -- tasksDone uses the RESOLVED done (deal-card mirror S2): a synced
             -- task follows its deal flag unless ops overrode it — COALESCE(
             -- override_done, deal flag, done). Mirrors resolveTaskDone exactly
             -- (the title literals are the SAME exported constants), so the card
             -- X/Y agrees with the detail checklist. d is at most one row per
             -- transfer (deal_id → deal PK), so no COUNT fan-out.
             CASE WHEN t.funding_type::text = 'DRS' THEN MAX(drs_progress.done)
               ELSE COUNT(k.id) FILTER (WHERE ${resolvedTaskDone}) END AS "tasksDone",
             CASE WHEN t.funding_type::text = 'DRS' THEN MAX(drs_progress.total)
               ELSE COUNT(k.id) END AS "tasksTotal",
             CASE WHEN t.funding_type::text = 'DRS' THEN MAX(drs_progress.next_task)
               ELSE (ARRAY_AGG(k.title ORDER BY k.sort_order, k.id)
               FILTER (WHERE k.id IS NOT NULL AND NOT (${resolvedTaskDone}))
             )[1] END AS "nextIncompleteTask"
      FROM app.transfer t
      -- The board can request CURRENT-STAGE tasks so its X/Y matches
      -- StageChecklistCard exactly (stageChecklistTasks, transfer-types.ts).
      -- Shared callers retain the legacy visibleTasks projection by default.
      -- Both branches interpolate the SAME exported title lists as the detail
      -- selector, and the join predicate excludes out-of-scope rows from BOTH
      -- counts.
      LEFT JOIN app.transfer_task k ON k.transfer_id = t.id
        AND t.funding_type::text IS DISTINCT FROM 'DRS'
        ${checklistJoin}
      ${drsStageTaskProgressJoin()}
      -- The linked deal (at most one row per transfer) supplies the mirrored
      -- flags for the resolved tasksDone above. LEFT JOIN → no deal / RLS-hidden
      -- deal yields NULL, and COALESCE falls back to k.done.
      LEFT JOIN app.deal d ON d.id = t.deal_id
      WHERE ${archivedFilter}
        AND ${boardFilter}
        AND ${demoFilter}
      -- d.id joins the group so the SELECT's COALESCE(d.amount, …) is legal
      -- (d.amount is functionally dependent on d.id); one deal per transfer keeps
      -- the grouping cardinality identical to GROUP BY t.id alone.
      GROUP BY t.id, d.id
      ORDER BY t.stage_entered_at ASC, t.id`;
}

export async function listTransfers(identity: Identity, options: ListTransfersOptions = {}): Promise<TransferBoardRow[]> {
  const rows = await withUserScope(identity, tx => tx.$queryRaw<RawBoardRow[]>(transferBoardQuery(options)));
  return rows.map((r) => ({
    ...r,
    value: Number(r.value),
    tasksDone: Number(r.tasksDone), // COUNT → bigint at runtime
    tasksTotal: Number(r.tasksTotal),
    daysInStage: daysInStage(r.stage_entered_at),
    bouncing: r.owner_kind === "ADVISOR" && r.stage !== "FUNDED",
  }));
}

export async function getTransfer(
  identity: Identity,
  id: string,
): Promise<TransferDetail | null> {
  return withUserScope(identity, async (tx) => {
    const records = await tx.$queryRaw<TransferRow[]>`
      SELECT id, source, client_first_name, client_last_name, client_sf_id,
             household_name, household_sf_id, value, stage, stage_entered_at,
             owner_kind, owner_name, next_step, next_step_owner, pending_nudge,
             acat_transfer_id,
             funding_type, recorded_funding_type, funding_method_revision,
             drs_method_change_pending, funding_route_change_pending,
             accounts_opened_at_apex, funding_plan_complete,
             funding_plan_version, funding_plan_approved_at,
             funding_plan_approved_by,
             funding_initiated, cash_in_flight, deal_id, deal_sf_id,
             transferring_firm, archived_at, archived_by, archived_reason,
             sync_flag, acat_record_id,
             asset_map_folder_id, asset_map_custodian, asset_map_account_number,
             asset_map_account_type,
             created_by, updated_by, created_at, updated_at
      FROM app.transfer
      WHERE id = ${id}
      LIMIT 1`;
    const record = records[0];
    if (!record) return null;

    const [tasks, decisions, accounts] = await Promise.all([
      tx.$queryRaw<TransferTaskRow[]>`
        SELECT id, transfer_id, title, sort_order, done, override_done,
               completed_at, completed_by, created_at, updated_at
        FROM app.transfer_task
        WHERE transfer_id = ${id}
        ORDER BY sort_order ASC, id`,
      tx.$queryRaw<TransferDecisionRow[]>`
        SELECT id, transfer_id, symbol, description, value, cost_basis,
               decision, decided_by, decided_at, created_at, updated_at
        FROM app.transfer_decision
        WHERE transfer_id = ${id}
        ORDER BY created_at ASC, id`,
      tx.$queryRaw<TransferAccountRow[]>`
        SELECT id, transfer_id, label, status, opened_at, created_at,
               updated_at
        FROM app.transfer_account
        WHERE transfer_id = ${id}
        ORDER BY created_at ASC, id`,
    ]);

    return {
      ...record,
      value: Number(record.value),
      tasks,
      decisions: decisions.map((d) => ({
        ...d,
        value: Number(d.value),
        cost_basis: d.cost_basis == null ? null : Number(d.cost_basis),
      })),
      accounts,
    };
  });
}

export async function transferOpsStats(
  identity: Identity,
): Promise<TransferOpsStats> {
  const demoFilter = hideDemoTransferCardsEnabled()
    ? Prisma.sql`(t.id NOT LIKE 'DEMO-T-%'
        AND COALESCE(t.deal_sf_id, d.sf_deal_id, '') NOT LIKE 'DEMO-%')`
    : Prisma.sql`TRUE`;
  const rows = await withUserScope(identity, (tx) =>
    tx.$queryRaw<{ outstanding: unknown; active: bigint; bouncing: bigint }[]>`
      -- The in-flight book sums the DISPLAYED value, so it agrees with the board
      -- cards + detail: linked transfers use the live deal amount
      -- (COALESCE(d.amount, t.value) — mirrors resolveTransferValue), unlinked use
      -- the stored value. LEFT JOIN → no/RLS-hidden deal falls back to t.value.
      -- Archived fall-off (feat/transfer-archive-falloff): archived rows are off
      -- the board (listTransfers default), so they must be out of EVERY opsbar
      -- aggregate too — one top-level WHERE (all three FILTERs share it) keeps
      -- "outstanding == the visible non-FUNDED cards' sum" true by construction.
      SELECT COALESCE(SUM(COALESCE(d.amount, t.value)) FILTER (WHERE t.stage <> 'FUNDED'), 0) AS "outstanding",
             COUNT(*) FILTER (WHERE t.stage <> 'FUNDED')                AS "active",
             COUNT(*) FILTER (WHERE t.owner_kind = 'ADVISOR'
                                AND t.stage <> 'FUNDED')                AS "bouncing"
      FROM app.transfer t
      LEFT JOIN app.deal d ON d.id = t.deal_id
      WHERE t.archived_at IS NULL
        AND ${demoFilter}`,
  );
  const r = rows[0];
  return {
    outstanding: Number(r?.outstanding ?? 0), // SUM(numeric) → Decimal
    active: Number(r?.active ?? 0), // COUNT → bigint
    bouncing: Number(r?.bouncing ?? 0),
  };
}

/** Slack closeout status for the detail page (SLACK_TRANSFER_CLOSEOUT). Null
 *  when no closeout has been seeded (flag off, or the transfer never reached
 *  IN_TRANSFER). Read under withUserScope (RLS all-roles-read), so any role that sees
 *  the transfer sees its closeout status. `items` carries the per-item rows
 *  (merged with the template's display metadata — label/group/note — and
 *  display-ordered) so the card can show the full read-only checklist, not
 *  just the count; done/total are derived from the same rows. */
export type SlackCloseoutStatus = {
  status: string;
  done: number;
  total: number;
  items: SlackCloseoutItemView[];
};

export async function getSlackCloseout(
  identity: Identity,
  transferId: string,
): Promise<SlackCloseoutStatus | null> {
  return withUserScope(identity, async (tx) => {
    const closeout = await tx.transferSlackCloseout.findUnique({
      where: { transfer_id: transferId },
      select: { status: true },
    });
    if (!closeout) return null;
    const rows = await tx.transferSlackItem.findMany({
      where: { transfer_id: transferId },
      select: {
        item_key: true,
        label: true,
        sort: true,
        done: true,
        done_by: true,
        done_at: true,
      },
    });
    const items = mergeCloseoutItems(rows);
    return {
      status: closeout.status,
      done: items.filter((i) => i.done).length,
      total: items.length,
      items,
    };
  });
}
