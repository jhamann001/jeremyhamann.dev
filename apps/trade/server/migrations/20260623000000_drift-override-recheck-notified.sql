-- Up Migration
--
-- Idempotency marker for re-check reminders. When an override carries an
-- `expires_on` (a "check back on this date" reminder), the daily drift run
-- notifies the trader who set it once the date arrives — `recheck_notified_at`
-- records that the reminder fired so it isn't re-sent every subsequent day.
-- Cleared back to NULL whenever the override is re-set (a new date re-arms it).

ALTER TABLE drift_status_overrides
    ADD COLUMN IF NOT EXISTS recheck_notified_at TIMESTAMPTZ;

-- Down Migration

ALTER TABLE drift_status_overrides
    DROP COLUMN IF EXISTS recheck_notified_at;
