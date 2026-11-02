-- The original app-schema default privileges grant app_rw UPDATE/DELETE on
-- every new table. GRANTing a narrower set does not remove those defaults.
-- Explicitly reset all runtime privileges before declaring the proof tables
-- restricted or review events append-only.
REVOKE ALL ON app.acat_link_run, app.acat_link_decision, app.acat_link_review_event
  FROM PUBLIC, app_rw, ingest_rw;

GRANT SELECT,INSERT,UPDATE ON app.acat_link_run,app.acat_link_decision TO app_rw;
GRANT SELECT,INSERT ON app.acat_link_review_event TO app_rw;
GRANT SELECT,INSERT ON app.acat_link_run,app.acat_link_decision TO ingest_rw;
GRANT UPDATE(status,updated_at,summary) ON app.acat_link_run TO ingest_rw;
GRANT UPDATE(outcome,applied_version,application_id,applied_at,updated_at)
  ON app.acat_link_decision TO ingest_rw;
GRANT SELECT ON app.acat_link_review_event TO ingest_rw;
