-- Up Migration

-- Idempotency marker for the nightly drift Slack alert: one row per
-- run_date_local once that day's report has been posted. The alert claims the
-- date with INSERT ... ON CONFLICT DO NOTHING — the run that wins the insert
-- sends; everyone else (re-runs, scheduler retries, manual triggers, the next
-- morning's first run) sees the conflict and skips.
--
-- Replaces the previous gate, which fired only on rows "freshly inserted this
-- run" (xmax=0). That was silently defeated whenever any earlier run claimed a
-- date's rows first — so e.g. the 2026-06-11 morning run found 0 fresh inserts
-- and never posted despite 20 accounts being out of tolerance.
CREATE TABLE IF NOT EXISTS drift_alert_sends (
    run_date_local DATE PRIMARY KEY,
    sent_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS drift_alert_sends;
