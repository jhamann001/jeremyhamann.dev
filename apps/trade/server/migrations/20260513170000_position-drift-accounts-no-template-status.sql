-- Up Migration
--
-- Extend `position_drift_accounts.status` to allow the new `no_template`
-- value and make `max_bucket_delta_pct` nullable so a `no_template` row
-- can persist a NULL delta (we have nothing to measure against without an
-- Meridian allocation target). `worst_bucket` is already nullable in
-- the v2 schema migration so it needs no change.
--
-- Backward-compatible: every row that satisfied the old CHECK still
-- satisfies the new one, and existing non-null `max_bucket_delta_pct`
-- values keep their semantics — DROP NOT NULL only widens what is
-- allowed.

ALTER TABLE position_drift_accounts
    DROP CONSTRAINT position_drift_accounts_status_check;

ALTER TABLE position_drift_accounts
    ADD CONSTRAINT position_drift_accounts_status_check
    CHECK (status IN ('in', 'out', 'uninvested', 'no_template'));

ALTER TABLE position_drift_accounts
    ALTER COLUMN max_bucket_delta_pct DROP NOT NULL;

-- Down Migration
--
-- Reverting requires deleting or down-converting any `no_template` rows
-- and any NULL `max_bucket_delta_pct` rows first, because the old CHECK
-- and NOT NULL constraints would reject them. We do that defensively
-- so the down migration is safe to run.

DELETE FROM position_drift_accounts WHERE status = 'no_template';
UPDATE position_drift_accounts SET max_bucket_delta_pct = 0 WHERE max_bucket_delta_pct IS NULL;

ALTER TABLE position_drift_accounts
    ALTER COLUMN max_bucket_delta_pct SET NOT NULL;

ALTER TABLE position_drift_accounts
    DROP CONSTRAINT position_drift_accounts_status_check;

ALTER TABLE position_drift_accounts
    ADD CONSTRAINT position_drift_accounts_status_check
    CHECK (status IN ('in', 'out', 'uninvested'));
