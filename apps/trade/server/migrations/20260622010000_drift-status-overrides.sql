-- Up Migration
--
-- Manual, human-judgment overrides of an account's drift status. A trader can
-- mark an out-of-tolerance account as accepted for a known reason (the drivers
-- from the drift-checker tuning sheet) with a free-text note. Overrides are
-- "sticky": keyed by Apex ULID (`account_id`), they persist across every future
-- nightly run until cleared — asset-location / tax-constrained / cash-by-design
-- are ongoing facts, not per-run decisions. `expires_on` lets a time-bound
-- reason (active transition) auto-expire so it can't hide real drift forever.
--
-- One active override per account → `account_id` is the primary key; setting an
-- override UPSERTs, clearing DELETEs. Audit is carried by set_by / set_by_name /
-- updated_at. The computed drift `status` is never mutated; the override is
-- joined in at read time and applied for display + the actionable count.

CREATE TABLE IF NOT EXISTS drift_status_overrides (
    account_id    VARCHAR(100) PRIMARY KEY,
    reason        TEXT NOT NULL CHECK (reason IN (
                    'asset_location',
                    'tax_constraint',
                    'active_transition',
                    'intentional_cash',
                    'concentrated_position',
                    'template_error',
                    'direct_index_noise',
                    'other'
                  )),
    note          TEXT NOT NULL DEFAULT '',
    -- For time-bound reasons (active transition): the override stops applying
    -- on/after this date so a finished transition can't suppress drift forever.
    -- NULL = no expiry (ongoing structural reason).
    expires_on    DATE,
    set_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    set_by_name   VARCHAR(255) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS drift_status_overrides;
