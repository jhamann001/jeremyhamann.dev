import { Prisma } from "@prisma/client";
import { drsTasksForStage } from "./drs-workflow";
import { STAGE_ORDER } from "./transfer-types";

/**
 * One row of current-stage DRS progress for an outer transfer aliased as `t`.
 * Expected registry rows drive the denominator, so an older DRS record with
 * missing tasks remains incomplete. Exact unique source keys prevent fan-out;
 * unrelated decision tasks and legacy transfer checklists cannot count here.
 * This runs in the caller's RLS-scoped transaction and exposes static titles
 * and counts only, never task notes, account data or approval snapshots.
 */
export function drsStageTaskProgressJoin(): Prisma.Sql {
  const expected = STAGE_ORDER.flatMap((stage) =>
    drsTasksForStage(stage, true).map((task, index) =>
      Prisma.sql`(${stage}, ${task.key}, ${task.taskKey}, ${task.title}, ${task.ownerTeam}, ${index}, ${stage === "IN_TRANSFER" && task.requiredBefore === "IN_TRANSFER"})`,
    ),
  );
  return Prisma.sql`LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE task.status::text = 'DONE') AS done,
           COUNT(*) AS total,
           (ARRAY_AGG(expected.title ORDER BY expected.sort_order)
             FILTER (WHERE task.status::text IS DISTINCT FROM 'DONE'))[1] AS next_task
    FROM (VALUES ${Prisma.join(expected)})
      AS expected(stage, key, task_key, title, owner_team, sort_order, needs_method_change)
    LEFT JOIN app.decision_task task
      ON task.source_key = 'asset-transfer:' || t.id || ':drs:' || expected.key
      AND task.transfer_id = t.id
      AND task.decision_id IS NULL
      AND task.task_key = expected.task_key
      AND task.owner_team::text = expected.owner_team
    WHERE t.funding_type::text = 'DRS' AND expected.stage = t.stage::text
      AND (NOT expected.needs_method_change OR t.drs_method_change_pending)
  ) drs_progress ON TRUE`;
}
