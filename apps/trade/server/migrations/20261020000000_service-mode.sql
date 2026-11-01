-- Up Migration
--
-- The persisted service mode and the two standalone sender switches (ticket), changed only by
-- OPS_PORTAL's cutover controller through PUT /api/machine/service-mode. One row; the default is today's
-- behavior. Every change is appended to service_mode_changes with its time and caller.

CREATE TABLE IF NOT EXISTS service_mode (
    id              BOOLEAN     PRIMARY KEY DEFAULT TRUE CHECK (id),
    mode            TEXT        NOT NULL DEFAULT 'active' CHECK (mode IN ('active', 'frozen', 'mcp-only')),
    digest_sender   TEXT        NOT NULL DEFAULT 'on' CHECK (digest_sender IN ('on', 'off')),
    drift_sender    TEXT        NOT NULL DEFAULT 'on' CHECK (drift_sender IN ('on', 'off')),
    mode_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      TEXT        NOT NULL DEFAULT 'migration'
);

INSERT INTO service_mode (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS service_mode_changes (
    id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    changed_by TEXT        NOT NULL,
    from_state JSONB       NOT NULL,
    to_state   JSONB       NOT NULL,
    reason     TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS service_mode_changes_changed_at_idx ON service_mode_changes (changed_at DESC);

-- The change history is append-only for the runtime role (the default privileges in
-- server/sql/create-app-role.sql grant full DML on new tables).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trade_request_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON service_mode_changes FROM trade_request_app';
    EXECUTE 'REVOKE DELETE ON service_mode FROM trade_request_app';
  END IF;
END
$$;

-- Down Migration

DROP TABLE IF EXISTS service_mode_changes;
DROP TABLE IF EXISTS service_mode;
