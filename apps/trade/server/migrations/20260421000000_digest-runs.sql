-- Up Migration

-- Idempotency guard for the daily Slack digest. The scheduled job inserts a row
-- for the local (America/New_York) calendar date on each run; ON CONFLICT DO
-- NOTHING ensures that Cloud Scheduler retries or manual re-triggers the same
-- morning are no-ops. The summary column stores the rendered counts for audit.
CREATE TABLE IF NOT EXISTS digest_runs (
    run_date    DATE PRIMARY KEY,
    posted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    summary     JSONB NOT NULL
);

-- Down Migration

DROP TABLE IF EXISTS digest_runs;
