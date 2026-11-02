-- Repair the legacy standard partial-ACAT backfill without modifying the
-- already-applied 20260909184500 migration or its checksum. FORCE RLS binds
-- non-superuser migration owners too, so that migration could see zero cases
-- and record success without moving their execution work into direct tasks.
--
-- Only still-open automatic excluded-position cases are eligible. Preserve
-- existing task status, completed work, snapshots, and all prior audit events.
-- Successful replay is a no-op once the legacy cases have been resolved.
--
-- Rollback: a failure rolls back the data changes AND restores FORCE RLS.
-- After commit, retain the tasks/history on an application traffic rollback;
-- recovery is a reviewed forward fix, never deletion of workflow history.
BEGIN;

-- Temporarily use the normal table-owner bypass, never grant runtime bypass.
-- ALTER TABLE locks and the surrounding transaction prevent runtime access
-- from observing a state where these tables do not force row-level security.
ALTER TABLE "app"."decision_case" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."decision_task" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."decision_case_event" NO FORCE ROW LEVEL SECURITY;

WITH standard_cases AS (
  SELECT id, transfer_id, COALESCE(created_by, 'system@ops-portal') AS actor
  FROM "app"."decision_case"
  WHERE source = 'ASSET_TRANSFER'
    AND source_key LIKE 'asset-transfer:%:excluded-positions'
    AND status <> 'RESOLVED'
), task_specs(task_key, title, owner_team, sort_order) AS (
  VALUES
    (
      'prepare-wet-signature-paperwork',
      'Prepare partial-ACAT paperwork and arrange the client wet-signature package',
      'CLIENT_SERVICE'::"app"."DecisionOwnerTeam",
      20
    ),
    (
      'review-submit-partial-acat',
      'Review the completed paperwork, then submit the partial ACAT',
      'OPERATIONS'::"app"."DecisionOwnerTeam",
      30
    ),
    (
      'track-partial-acat',
      'Track the partial ACAT through completion',
      'OPERATIONS'::"app"."DecisionOwnerTeam",
      40
    )
)
INSERT INTO "app"."decision_task" (
  id, source_key, decision_id, transfer_id, task_key, title, owner_team,
  status, priority, sort_order, created_by, created_at, updated_at
)
SELECT
  'task_' || substr(md5(c.id || ':' || s.task_key), 1, 24),
  'asset-transfer:' || c.transfer_id || ':standard-partial-acat:' || s.task_key,
  NULL,
  c.transfer_id,
  s.task_key,
  s.title,
  s.owner_team,
  'TODO'::"app"."DecisionTaskStatus",
  'HIGH'::"app"."DecisionTaskPriority",
  s.sort_order,
  c.actor,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM standard_cases c
CROSS JOIN task_specs s
ON CONFLICT ("source_key") DO NOTHING;

-- Retire, rather than delete, the old false-decision records so their source
-- snapshot and history remain available for audit reconstruction.
UPDATE "app"."decision_task" task
SET status = 'DONE',
    completed_by = COALESCE(c.created_by, 'system@ops-portal'),
    completed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
FROM "app"."decision_case" c
WHERE task.decision_id = c.id
  AND task.task_key = 'resolve-excluded-positions'
  AND task.status <> 'DONE'
  AND c.source = 'ASSET_TRANSFER'
  AND c.source_key LIKE 'asset-transfer:%:excluded-positions'
  AND c.status <> 'RESOLVED';

INSERT INTO "app"."decision_case_event" (
  decision_id, action, actor_email, actor_role, from_status, to_status,
  note_present, detail, at
)
SELECT
  c.id,
  'RESOLVED',
  COALESCE(c.created_by, 'system@ops-portal'),
  'SYSTEM',
  c.status,
  'RESOLVED',
  false,
  jsonb_build_object(
    'resolutionCode', 'STANDARD_PARTIAL_ACAT',
    'reason', 'known_route_not_decision',
    'generatedTaskCount', 3
  ),
  CURRENT_TIMESTAMP
FROM "app"."decision_case" c
WHERE c.source = 'ASSET_TRANSFER'
  AND c.source_key LIKE 'asset-transfer:%:excluded-positions'
  AND c.status <> 'RESOLVED';

UPDATE "app"."decision_case"
SET status = 'RESOLVED',
    blocks_transfer = false,
    resolution_code = 'STANDARD_PARTIAL_ACAT',
    resolution_summary = 'The approved funding plan establishes the standard partial-ACAT route; no separate decision is required.',
    version = version + 1,
    resolved_by = COALESCE(created_by, 'system@ops-portal'),
    resolved_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE source = 'ASSET_TRANSFER'
  AND source_key LIKE 'asset-transfer:%:excluded-positions'
  AND status <> 'RESOLVED';

ALTER TABLE "app"."decision_case" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."decision_task" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."decision_case_event" FORCE ROW LEVEL SECURITY;

COMMIT;
