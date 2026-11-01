-- Up Migration

-- One row per (run_date_local, household_name). The runner is invoked
-- nightly by Cloud Scheduler; ON CONFLICT DO NOTHING on the unique key
-- makes manual re-runs and Scheduler retries idempotent within a
-- calendar day (America/New_York). The household identifier is the
-- advisor-friendly household name from active_accounts.numbers (e.g.
-- "Whitaker Family", "Example Household"), resolved by the runner via
-- server/src/config/households.json. Per-household JSON detail
-- (account breakdown, per-symbol deltas) lives in `details` so the
-- schema is stable while the comparison heuristics evolve.
CREATE TABLE IF NOT EXISTS registry_drift_runs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_date_local      DATE NOT NULL,
    run_started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    household_name      TEXT NOT NULL CHECK (length(trim(household_name)) > 0),
    account_count       INTEGER NOT NULL CHECK (account_count >= 0),
    max_delta_pct       NUMERIC(7,4) NOT NULL,
    breach              BOOLEAN NOT NULL,
    coverage_status     TEXT NOT NULL CHECK (coverage_status IN ('full', 'partial', 'engine_only', 'meridian_only', 'unmapped_account')),
    schema_version      INTEGER NOT NULL,
    snapshot_source     TEXT NOT NULL,
    snapshot_as_of      TIMESTAMPTZ,
    details             JSONB NOT NULL,
    UNIQUE (run_date_local, household_name)
);

CREATE INDEX IF NOT EXISTS idx_registry_drift_runs_breach
    ON registry_drift_runs (run_date_local DESC) WHERE breach;

CREATE INDEX IF NOT EXISTS idx_registry_drift_runs_household
    ON registry_drift_runs (household_name, run_date_local DESC);

-- Down Migration

DROP TABLE IF EXISTS registry_drift_runs;
