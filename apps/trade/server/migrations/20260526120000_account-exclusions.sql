-- Up Migration

-- Account-scoped standing exclusions. Mirrors `client_exclusions` semantics
-- but keys rows to Apex ULIDs (`account_id`) so one client can carry
-- different DNB/DNS rules across accounts without over-restricting the entire
-- household.
CREATE TABLE IF NOT EXISTS account_exclusions (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Apex `custodian_account_id` / ULID (same identifier used by drift).
    account_id        VARCHAR(100) NOT NULL,
    ticker            VARCHAR(20) NOT NULL,
    kind              VARCHAR(20) NOT NULL CHECK (kind IN ('advisor', 'client')),
    reason            TEXT NOT NULL DEFAULT '',
    no_buy            BOOLEAN NOT NULL DEFAULT TRUE,
    no_sell           BOOLEAN NOT NULL DEFAULT TRUE,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by_name   VARCHAR(255) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT account_exclusions_at_least_one_side CHECK (no_buy OR no_sell),
    UNIQUE (account_id, ticker, kind)
);

CREATE INDEX IF NOT EXISTS idx_account_exclusions_account_id
    ON account_exclusions (account_id);

-- Down Migration

DROP INDEX IF EXISTS idx_account_exclusions_account_id;
DROP TABLE IF EXISTS account_exclusions;
