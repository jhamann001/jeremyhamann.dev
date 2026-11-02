-- ticket: AOA drift check in shadow mode, override change log and the shadow-readiness ledger.
-- The shadow tables copy the live drift result tables' columns, defaults, CHECK constraints and indexes
-- (LIKE never copies foreign keys). No table here references a trade_request catalog table by foreign key:
-- the ticket copy engine refuses to run while one does. Ids are plain columns.
BEGIN;

CREATE TABLE trade_request.shadow_registry_drift_runs (LIKE trade_request.registry_drift_runs INCLUDING ALL);
CREATE TABLE trade_request.shadow_position_drift_accounts (LIKE trade_request.position_drift_accounts INCLUDING ALL);

-- Who saved or cleared a drift override, and the before/after state (the standalone row is deleted on clear).
CREATE TABLE trade_request.drift_override_changes (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_aoa_user_id TEXT NOT NULL,
    actor_name        TEXT NOT NULL,
    account_id        VARCHAR(100) NOT NULL,
    action            TEXT NOT NULL CHECK (action IN ('save', 'clear')),
    before_state      JSONB,
    after_state       JSONB
);
CREATE INDEX drift_override_changes_account_idx ON trade_request.drift_override_changes (account_id, at DESC);

-- One row per readiness comparison: dates and counts only, never row content.
CREATE TABLE trade_request.drift_readiness_runs (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ran_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor   TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('ready', 'not_ready')),
    dates   JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX drift_readiness_runs_ran_at_idx ON trade_request.drift_readiness_runs (ran_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON
    trade_request.shadow_registry_drift_runs, trade_request.shadow_position_drift_accounts
  TO app_rw;
GRANT SELECT, INSERT ON trade_request.drift_override_changes TO app_rw;
GRANT SELECT ON trade_request.drift_readiness_runs TO app_rw;

COMMIT;
