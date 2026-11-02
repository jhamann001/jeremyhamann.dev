-- Always-On Advice — Appointments Feed feed (Command Center → Meetings card).
-- Source: the #appointments-feed Slack channel, where a Pipedream bot posts a
-- rolling "Upcoming Appointments" digest. An n8n workflow reads the latest digest
-- on a schedule and POSTs it to /api/ingest/appointments, which parses it and
-- FULL-REPLACES the current upcoming set for its source (the digest is a snapshot,
-- not a delta — see the ingest route).
--
-- Hand-authored (the mirror_roles_grants_rls idiom: NO Prisma models for the
-- mirror schema — ADR-9). Additive-only: one new table + indexes + grants + RLS.
-- Upsert/replace only — NO DELETE grant for app_rw (ingest_rw does the replace).
--
-- VISIBILITY: unlike the other mirror tables (own-book for advisors), appointments
-- are read by ALL app roles firm-wide, matching the Command Center Meetings card,
-- which is a firm overview shown to every authenticated role. The digest carries
-- only an advisor NAME (no email), so there is no reliable book key to scope on.
-- (Revisit alongside the by-role access review if firm-wide meeting visibility is
-- too broad.)

-- ---------------------------------------------------------------------------
-- 1. mirror.appointment — one row per upcoming appointment in the latest digest.
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.appointment (
  external_key   text PRIMARY KEY,          -- deterministic: source|client|starts_at (idempotent within a digest)
  source         text NOT NULL,             -- e.g. 'slack-appointments-feed' (the replace scope)
  client_name    text,                      -- from the digest
  client_sf_id   text,                      -- best-effort name match to mirror.client (nullable; often null)
  advisor_name   text,                      -- from the digest
  meeting_type   text,                      -- e.g. 'Private Wealth Consultation'
  starts_at      timestamptz NOT NULL,      -- appointment instant (ET wall-clock → UTC at ingest)
  date_text      text,                      -- raw MM/DD/YYYY from the digest (provenance)
  time_text      text,                      -- raw 'HH:MM AM/PM' from the digest (provenance)
  slack_ts       text,                      -- source Slack message ts (provenance)
  synced_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_source_starts_idx ON mirror.appointment (source, starts_at);
CREATE INDEX appointment_starts_idx ON mirror.appointment (starts_at);

-- ---------------------------------------------------------------------------
-- 2. Grants — ingest writes (incl. DELETE, because the feed REPLACES the set on
--    each run: a dropped appointment must disappear); app reads only.
--    This is the one mirror table where ingest_rw gets DELETE, by design
--    (snapshot-replace, not the append-only staleness posture of the others).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.appointment TO ingest_rw;
GRANT SELECT ON mirror.appointment TO app_rw;

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security. GUC predicate current_setting('app.user_role', true);
--    a missing GUC returns NULL, so the app_rw policy fails closed.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.appointment ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.appointment FORCE  ROW LEVEL SECURITY;

-- Ingestion reads/writes the whole firm (the B-migration idiom).
CREATE POLICY appointment_ingest_all ON mirror.appointment FOR ALL TO ingest_rw USING (true) WITH CHECK (true);

-- All authenticated app roles read (firm-wide) — the Command Center is a firm
-- overview. VIEWER included (matches the card's current all-roles posture).
CREATE POLICY appointment_read_all_roles ON mirror.appointment FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN
    ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER')
);
