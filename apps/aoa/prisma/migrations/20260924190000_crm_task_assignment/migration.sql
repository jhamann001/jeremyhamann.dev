-- ticket: optional, source-confirmed assignment on the existing task mirror.
-- Existing rows remain unavailable until observed by an enriched feed. No
-- backfill, task-population change, new role/grant, RLS change or content audit.
-- Mirror tables remain SQL-owned rather than Prisma models (ADR-9).
ALTER TABLE mirror.task
  ADD COLUMN assignment_state text NOT NULL DEFAULT 'UNAVAILABLE',
  ADD COLUMN assignee_sf_id text,
  ADD COLUMN assignee_type text,
  ADD COLUMN assignee_name text,
  ADD COLUMN assignment_observed_at timestamptz,
  ADD CONSTRAINT task_assignment_state_check CHECK (
    assignment_state IN ('ASSIGNED', 'UNASSIGNED', 'UNAVAILABLE')
  ),
  ADD CONSTRAINT task_assignment_tuple_check CHECK (
    (assignment_state = 'ASSIGNED'
      AND assignee_sf_id IS NOT NULL
      AND assignee_type IS NOT NULL
      AND assignment_observed_at IS NOT NULL
      AND ((assignee_type = 'USER' AND assignee_sf_id ~ '^005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$')
        OR (assignee_type = 'QUEUE' AND assignee_sf_id ~ '^00G[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$')))
    OR (assignment_state IN ('UNASSIGNED', 'UNAVAILABLE')
      AND assignee_sf_id IS NULL AND assignee_type IS NULL AND assignee_name IS NULL
      AND (assignment_state = 'UNAVAILABLE' OR assignment_observed_at IS NOT NULL))
  ),
  ADD CONSTRAINT task_assignment_name_check CHECK (
    assignee_name IS NULL OR (char_length(assignee_name) BETWEEN 1 AND 255
      AND btrim(assignee_name) <> '' AND assignee_name !~ '[[:cntrl:]]')
  );

COMMENT ON COLUMN mirror.task.assignment_observed_at IS
  'UTC source-read time, retained on retries; only strictly newer assignment observations replace stored assignment.';
