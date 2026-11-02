-- ATW-01 (ticket): task status separate from the funding stage, and the
-- owning team the work queue filters on. Additive only. The columns inherit
-- app.transfer_task's existing RLS policies and grants; no DELETE policy.

ALTER TABLE app.transfer_task ADD COLUMN status text NOT NULL DEFAULT 'Ready';
ALTER TABLE app.transfer_task ADD CONSTRAINT transfer_task_status_check
  CHECK (status IN ('Ready', 'Waiting', 'Completed'));
UPDATE app.transfer_task SET status = 'Completed' WHERE done = true;

ALTER TABLE app.transfer_task ADD COLUMN team text;
ALTER TABLE app.transfer_task ADD CONSTRAINT transfer_task_team_check
  CHECK (team IS NULL OR team IN ('Client Service', 'Operations', 'Operations / Client Service'));
