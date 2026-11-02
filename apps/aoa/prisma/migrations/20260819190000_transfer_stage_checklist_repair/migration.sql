-- Repair legacy active transfers whose stage was advanced before destination-
-- stage checklist seeding existed. Tasks are append-only: retain every prior
-- row and add only missing DEFAULT_TASKS titles for the transfer's CURRENT
-- stage. The deterministic id makes the repair safe to replay; NOT EXISTS
-- makes it safe for partially seeded transfers.
WITH stage_template(stage, title, ordinal) AS (
  VALUES
    ('DECISION', 'Collect statements', 1),
    ('DECISION', 'Run asset mapper', 2),
    ('DECISION', 'Send decision worksheet', 3),
    ('DECISION', 'Asset decisions finalized', 4),
    ('DECISION', 'Open receiving accounts', 5),
    ('DECISION', 'Confirm account numbers', 6),
    ('IN_TRANSFER', 'ACAT submitted to Apex', 1),
    ('IN_TRANSFER', 'Transfer accepted by contra', 2),
    ('IN_TRANSFER', 'Positions settling', 3),
    ('IN_TRANSFER', 'Cost basis received', 4),
    ('FUNDED', 'All positions received', 1),
    ('FUNDED', 'Cost basis verified', 2),
    ('FUNDED', 'Transition template applied', 3),
    ('FUNDED', 'Fee reimbursement filed', 4)
),
missing AS (
  SELECT
    t.id AS transfer_id,
    template.title,
    existing.max_sort_order + ROW_NUMBER() OVER (
      PARTITION BY t.id
      ORDER BY template.ordinal
    )::integer AS sort_order
  FROM app.transfer t
  JOIN stage_template template ON template.stage = t.stage::text
  CROSS JOIN LATERAL (
    SELECT COALESCE(MAX(task.sort_order), -1) AS max_sort_order
    FROM app.transfer_task task
    WHERE task.transfer_id = t.id
  ) existing
  WHERE t.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM app.transfer_task task
      WHERE task.transfer_id = t.id
        AND task.title = template.title
    )
)
INSERT INTO app.transfer_task (
  id,
  transfer_id,
  title,
  sort_order,
  done,
  completed_at,
  completed_by,
  created_at,
  updated_at
)
SELECT
  'repair-task-' || md5(missing.transfer_id || ':' || missing.title),
  missing.transfer_id,
  missing.title,
  missing.sort_order,
  false,
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM missing
ON CONFLICT (id) DO NOTHING;
