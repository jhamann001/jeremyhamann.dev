-- Up Migration

CREATE TABLE IF NOT EXISTS client_exclusions (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- VARCHAR(100), no FK to clients(id) — Warehouse is the source of truth for
    -- clients in production. The local `clients` table is only seeded for dev
    -- and tests. Mirrors `trade_requests.client_id` shape after the
    -- 20260323000000_warehouse-integration migration.
    client_id         VARCHAR(100) NOT NULL,
    ticker            VARCHAR(20) NOT NULL,
    kind              VARCHAR(20) NOT NULL CHECK (kind IN ('advisor', 'client')),
    reason            TEXT NOT NULL DEFAULT '',
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    -- Denormalized for audit-trail survivability when a user is deleted.
    -- Matches the audit_logs(user_name) pattern from 20260330000000.
    created_by_name   VARCHAR(255) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (client_id, ticker, kind)
);

CREATE INDEX IF NOT EXISTS idx_client_exclusions_client_id
    ON client_exclusions (client_id);

-- Down Migration

DROP INDEX IF EXISTS idx_client_exclusions_client_id;
DROP TABLE IF EXISTS client_exclusions;
