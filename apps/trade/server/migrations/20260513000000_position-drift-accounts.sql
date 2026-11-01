-- Up Migration

-- One row per (run_date_local, account_id). v2 of the drift signal:
-- per-account rather than per-household. The v1 table registry_drift_runs
-- stays in place during cutover and is dropped in a follow-up PR
-- (see docs/plans/2026-q3-drift-v2-accounts.md §9).
CREATE TABLE IF NOT EXISTS position_drift_accounts (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_date_local              DATE NOT NULL,
    run_started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    account_id                  TEXT NOT NULL CHECK (length(trim(account_id)) > 0),
    account_title               TEXT NOT NULL DEFAULT '',
    household_name              TEXT NOT NULL DEFAULT '',
    coverage                    TEXT NOT NULL CHECK (coverage IN (
                                  'both', 'positions_only', 'template_only', 'unmapped'
                                )),
    status                      TEXT NOT NULL CHECK (status IN ('in', 'out', 'uninvested')),
    total_value_usd             NUMERIC(18,2) NOT NULL DEFAULT 0,
    position_cash_pct           NUMERIC(7,4) NOT NULL DEFAULT 0,
    position_fixed_pct          NUMERIC(7,4) NOT NULL DEFAULT 0,
    position_equity_pct         NUMERIC(7,4) NOT NULL DEFAULT 0,
    template_cash_pct           NUMERIC(7,4) NOT NULL DEFAULT 0,
    template_fixed_pct          NUMERIC(7,4) NOT NULL DEFAULT 0,
    template_equity_pct         NUMERIC(7,4) NOT NULL DEFAULT 0,
    max_bucket_delta_pct        NUMERIC(7,4) NOT NULL DEFAULT 0,
    worst_bucket                TEXT CHECK (worst_bucket IS NULL OR worst_bucket IN ('cash', 'fixed', 'equity')),
    symbol_breach_count         INTEGER NOT NULL DEFAULT 0 CHECK (symbol_breach_count >= 0),
    tolerance_pct               NUMERIC(7,4) NOT NULL DEFAULT 5,
    uninvested_cash_threshold_pct NUMERIC(7,4) NOT NULL DEFAULT 99,
    schema_version              INTEGER NOT NULL,
    snapshot_source             TEXT NOT NULL,
    snapshot_as_of              TIMESTAMPTZ,
    details                     JSONB NOT NULL,
    UNIQUE (run_date_local, account_id)
);

CREATE INDEX IF NOT EXISTS idx_pda_run_date_status
    ON position_drift_accounts (run_date_local DESC, status);

CREATE INDEX IF NOT EXISTS idx_pda_household
    ON position_drift_accounts (household_name, run_date_local DESC);

-- Down Migration

DROP TABLE IF EXISTS position_drift_accounts;
