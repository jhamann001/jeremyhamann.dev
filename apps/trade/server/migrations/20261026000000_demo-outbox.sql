-- Up Migration
--
-- The demo's outbox: every Slack message and email the app would have sent. In the demo, Slack and
-- email point at stand-ins that write here instead of delivering, and the Outbox screen reads it back.

CREATE TABLE IF NOT EXISTS outbox_messages (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    transport   TEXT        NOT NULL CHECK (transport IN ('slack', 'email')),
    destination TEXT        NOT NULL CHECK (length(trim(destination)) > 0),
    subject     TEXT,
    body        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS outbox_messages_created_at_idx ON outbox_messages (created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS outbox_messages;
