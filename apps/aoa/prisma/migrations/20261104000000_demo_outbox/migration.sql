-- Public demo: the Outbox. In the demo, the messages the app would send (Slack posts, the closeout checklist
-- webhook, Operations alerts) are written here instead and shown on /outbox. Its own schema, so nothing in app.*
-- changes and no app.* guardrail applies. The app login may add and read rows, never change or remove them; the
-- nightly reset restores an empty table. Outside the demo nothing writes to it.

CREATE SCHEMA demo;

CREATE TABLE demo.outbox_message (
  id          bigserial PRIMARY KEY,
  channel     text NOT NULL CHECK (char_length(channel) BETWEEN 1 AND 40),
  destination text NOT NULL CHECK (char_length(destination) BETWEEN 1 AND 120),
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  detail      text NOT NULL CHECK (char_length(detail) <= 500),
  body        text NOT NULL CHECK (char_length(body) <= 8000),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_message_created_at_idx ON demo.outbox_message (created_at DESC, id DESC);

REVOKE ALL ON SCHEMA demo FROM PUBLIC;
GRANT USAGE ON SCHEMA demo TO app_rw;
GRANT SELECT, INSERT ON demo.outbox_message TO app_rw;
GRANT USAGE ON SEQUENCE demo.outbox_message_id_seq TO app_rw;
