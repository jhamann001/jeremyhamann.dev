BEGIN;

-- Operational metadata only: no provider payloads, tokens, client rows or raw errors.
CREATE TABLE app.data_job_snapshot (
  environment text NOT NULL CHECK (environment IN ('dev','prod')),
  job_id text NOT NULL CHECK (job_id ~ '^[a-zA-Z0-9_-]{1,120}$'),
  observed_at timestamptz NOT NULL,
  expected_due_at timestamptz,
  observation jsonb NOT NULL CHECK (jsonb_typeof(observation) = 'object' AND octet_length(observation::text) < 12000),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) < 24000),
  PRIMARY KEY (environment, job_id)
);
CREATE TABLE app.data_job_run (
  environment text NOT NULL CHECK (environment IN ('dev','prod')),
  job_id text NOT NULL,
  run_id text NOT NULL CHECK (length(run_id) BETWEEN 1 AND 240),
  event_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  terminal boolean NOT NULL,
  run jsonb NOT NULL CHECK (jsonb_typeof(run) = 'object' AND octet_length(run::text) < 6000),
  PRIMARY KEY (environment, job_id, run_id)
);
CREATE INDEX data_job_run_history ON app.data_job_run(environment, job_id, event_at DESC, run_id DESC);
CREATE INDEX data_job_run_retention ON app.data_job_run(event_at);
CREATE TABLE app.data_job_incident (
  id uuid PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('dev','prod')),
  job_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('failure','overdue','stalled','monitoring_unavailable')),
  evidence_run_id text,
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz,
  delivery text NOT NULL DEFAULT 'DISABLED' CHECK (delivery = 'DISABLED')
);
CREATE UNIQUE INDEX data_job_incident_open ON app.data_job_incident(environment,job_id,kind) WHERE resolved_at IS NULL AND evidence_run_id IS NULL;
CREATE UNIQUE INDEX data_job_incident_evidence ON app.data_job_incident(environment,job_id,kind,evidence_run_id) WHERE evidence_run_id IS NOT NULL;
CREATE INDEX data_job_incident_retention ON app.data_job_incident(resolved_at) WHERE resolved_at IS NOT NULL;
CREATE TABLE app.data_job_collector (
  environment text PRIMARY KEY CHECK (environment IN ('dev','prod')),
  lease_token uuid,
  lease_until timestamptz,
  last_completed_at timestamptz
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['data_job_snapshot','data_job_run','data_job_incident','data_job_collector'] LOOP
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, app_rw, ingest_rw, identity_reconciler', table_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON app.%I TO app_rw', table_name);
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY monitor_ops_read ON app.%I FOR SELECT TO app_rw USING (current_setting(''app.user_role'',true) IN (''ADMIN'',''OPERATIONS'') AND nullif(current_setting(''app.user_email'',true),'''') IS NOT NULL)', table_name);
    EXECUTE format('CREATE POLICY monitor_worker_write ON app.%I FOR ALL TO app_rw USING (current_setting(''app.user_role'',true) = ''OPERATIONS'' AND current_setting(''app.user_email'',true) = ''data-job-collector@system'') WITH CHECK (current_setting(''app.user_role'',true) = ''OPERATIONS'' AND current_setting(''app.user_email'',true) = ''data-job-collector@system'')', table_name);
    EXECUTE format('CREATE POLICY monitor_owner ON app.%I TO %I USING (true) WITH CHECK (true)', table_name, current_user);
  END LOOP;
END $$;

-- No backfill, integration activation, credentials or outbound notification enqueue.
COMMIT;
