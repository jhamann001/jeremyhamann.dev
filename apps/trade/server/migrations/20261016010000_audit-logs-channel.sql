-- Up Migration
--
-- Records which interface an audit-trail entry was made through:
-- 'standalone' for the Trade Request web app (the default, so every insert
-- that does not name a channel is unchanged) and 'opsPortal' for calls through the
-- delegated /api/ops-portal surface on behalf of an Ops Portal user.

ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'standalone'
    CONSTRAINT audit_logs_channel_check CHECK (channel IN ('standalone', 'opsPortal'));

-- Down Migration

ALTER TABLE audit_logs
    DROP COLUMN IF EXISTS channel;
