-- Additive, disabled-by-default reconciliation support. No link backfill.
-- Existing unlinked transfers may have been deliberately unlinked before a
-- durable hold existed. Keep that historical population held until reviewed;
-- newly created rows use false after this migration.
ALTER TABLE app.transfer
  ADD COLUMN acat_link_version integer NOT NULL DEFAULT 0,
  ADD COLUMN acat_auto_link_hold boolean NOT NULL DEFAULT true,
  ADD COLUMN acat_link_provenance text,
  ADD COLUMN acat_link_decision_id text;
ALTER TABLE app.transfer ALTER COLUMN acat_auto_link_hold SET DEFAULT false;
ALTER TABLE app.transfer ADD CONSTRAINT acat_link_version_nonnegative CHECK (acat_link_version >= 0);

-- Do not clear or pick a winner for an existing UUID collision. A collision
-- aborts this migration transaction and requires an explicit reviewed remedy.
DO $$ BEGIN
  IF EXISTS (
    SELECT lower(btrim(acat_transfer_id)) FROM app.transfer
    WHERE btrim(acat_transfer_id) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    GROUP BY lower(btrim(acat_transfer_id)) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ACAT canonical UUID collision requires reviewed resolution';
  END IF;
END $$;
CREATE UNIQUE INDEX transfer_acat_canonical_uuid_key ON app.transfer (lower(btrim(acat_transfer_id)))
  WHERE btrim(acat_transfer_id) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

CREATE TABLE app.acat_link_run (
  id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('PREPARE','APPLY','VERIFY','UNDO','AUTOMATIC')),
  status text NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED','APPLYING','COMPLETED','PARTIAL','BLOCKED')),
  contract_version integer NOT NULL CHECK (contract_version > 0),
  rule_version text NOT NULL,
  installation_id text NOT NULL,
  source_scope text NOT NULL,
  source_boundary jsonb NOT NULL,
  source_digest text NOT NULL,
  source_count integer NOT NULL CHECK (source_count BETWEEN 0 AND 5000),
  source_complete boolean NOT NULL,
  target_boundary timestamptz(6) NOT NULL,
  target_digest text NOT NULL,
  target_count integer NOT NULL CHECK (target_count BETWEEN 0 AND 5000),
  manifest_digest text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_by text,
  created_role text NOT NULL CHECK (created_role IN ('ADMIN','OPERATIONS','INGEST')),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  summary jsonb NOT NULL,
  CHECK (octet_length(source_boundary::text) <= 65536 AND octet_length(summary::text) <= 65536)
);
CREATE INDEX acat_link_run_created_at_idx ON app.acat_link_run(created_at);

CREATE TABLE app.acat_link_decision (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES app.acat_link_run(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  decision_key text NOT NULL,
  record_id text,
  transfer_id text,
  reason text NOT NULL,
  action text NOT NULL CHECK (action IN ('preserve','propose','review','exclude','no_counterpart')),
  rule_version text NOT NULL,
  evidence_digest text NOT NULL,
  expected_target_version integer CHECK (expected_target_version >= 0),
  target_evidence_digest text,
  source_candidate_set_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 65536),
  disposition text NOT NULL DEFAULT 'PENDING' CHECK (disposition IN ('PENDING','ACCEPT','REJECT','HOLD','RESUME')),
  review_version integer NOT NULL DEFAULT 0 CHECK (review_version >= 0),
  reviewed_by text,
  reviewed_at timestamptz(6),
  review_reason text CHECK (length(review_reason) <= 2000),
  outcome text NOT NULL DEFAULT 'PENDING' CHECK (outcome IN ('PENDING','APPLIED','NOOP','CONFLICT','BLOCKED','UNDONE')),
  applied_version integer CHECK (applied_version >= 0),
  application_id text UNIQUE,
  applied_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT acat_link_decision_run_id_decision_key_key UNIQUE (run_id,decision_key),
  CHECK (record_id IS NOT NULL OR transfer_id IS NOT NULL)
);
CREATE INDEX acat_link_decision_transfer_id_record_id_idx ON app.acat_link_decision(transfer_id,record_id);
CREATE INDEX acat_link_decision_outcome_disposition_idx ON app.acat_link_decision(outcome,disposition);

CREATE TABLE app.acat_link_review_event (
  id text PRIMARY KEY,
  decision_id text NOT NULL REFERENCES app.acat_link_decision(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('ACCEPT','REJECT','HOLD','RESUME','PENDING')),
  reason text CHECK (length(reason) <= 2000),
  actor_email text NOT NULL CHECK (length(btrim(actor_email)) > 0),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT acat_link_review_event_decision_id_revision_key UNIQUE(decision_id,revision)
);

-- Link revision protects all persisted target facts used by the matcher, even
-- older/manual writers. External mirror/deal facts still require revalidation.
CREATE FUNCTION app.advance_acat_link_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF ROW(NEW.client_sf_id,NEW.household_sf_id,NEW.deal_id,NEW.deal_sf_id,NEW.stage,
         NEW.funding_type,NEW.funding_plan_version,NEW.archived_at,NEW.source,
         NEW.acat_record_id,NEW.acat_transfer_id,NEW.acat_auto_link_hold,
         NEW.acat_link_provenance,NEW.acat_link_decision_id,
         NEW.asset_map_folder_id,NEW.asset_map_custodian,NEW.asset_map_account_number,NEW.asset_map_account_type)
     IS DISTINCT FROM
     ROW(OLD.client_sf_id,OLD.household_sf_id,OLD.deal_id,OLD.deal_sf_id,OLD.stage,
         OLD.funding_type,OLD.funding_plan_version,OLD.archived_at,OLD.source,
         OLD.acat_record_id,OLD.acat_transfer_id,OLD.acat_auto_link_hold,
         OLD.acat_link_provenance,OLD.acat_link_decision_id,
         OLD.asset_map_folder_id,OLD.asset_map_custodian,OLD.asset_map_account_number,OLD.asset_map_account_type) THEN
    NEW.acat_link_version := OLD.acat_link_version + 1;
    -- A legacy clear must suppress automatic reattachment too.
    IF (OLD.acat_record_id IS NOT NULL OR OLD.acat_transfer_id IS NOT NULL)
       AND NEW.acat_record_id IS NULL AND NEW.acat_transfer_id IS NULL THEN
      NEW.acat_auto_link_hold := true;
    END IF;
  ELSE
    NEW.acat_link_version := OLD.acat_link_version;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.advance_acat_link_version() FROM PUBLIC;
CREATE TRIGGER advance_acat_link_version BEFORE UPDATE ON app.transfer
  FOR EACH ROW EXECUTE FUNCTION app.advance_acat_link_version();

-- Updates may advance outcomes/review, never silently replace prepared proof.
CREATE FUNCTION app.protect_acat_link_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF TG_TABLE_NAME = 'acat_link_run' THEN
    IF (to_jsonb(NEW) - ARRAY['status','updated_at','summary'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','updated_at','summary']) THEN
      RAISE EXCEPTION 'Prepared ACAT run evidence is immutable';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['disposition','review_version','reviewed_by','reviewed_at','review_reason',
                            'outcome','applied_version','application_id','applied_at','updated_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['disposition','review_version','reviewed_by','reviewed_at','review_reason',
                            'outcome','applied_version','application_id','applied_at','updated_at']) THEN
      RAISE EXCEPTION 'Prepared ACAT decision evidence is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.protect_acat_link_evidence() FROM PUBLIC;
CREATE TRIGGER protect_acat_link_run BEFORE UPDATE ON app.acat_link_run
  FOR EACH ROW EXECUTE FUNCTION app.protect_acat_link_evidence();
CREATE TRIGGER protect_acat_link_decision BEFORE UPDATE ON app.acat_link_decision
  FOR EACH ROW EXECUTE FUNCTION app.protect_acat_link_evidence();

-- No DELETE permission and no generic row-change snapshots of restricted proof.
GRANT SELECT,INSERT,UPDATE ON app.acat_link_run,app.acat_link_decision TO app_rw;
GRANT SELECT,INSERT ON app.acat_link_review_event TO app_rw;
GRANT SELECT,INSERT ON app.acat_link_run,app.acat_link_decision TO ingest_rw;
GRANT UPDATE(status,updated_at,summary) ON app.acat_link_run TO ingest_rw;
GRANT UPDATE(outcome,applied_version,application_id,applied_at,updated_at) ON app.acat_link_decision TO ingest_rw;
GRANT SELECT ON app.acat_link_review_event TO ingest_rw;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['acat_link_run','acat_link_decision','acat_link_review_event'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY acat_link_ops ON app.%I TO app_rw USING (current_setting(''app.user_role'',true) IN (''ADMIN'',''OPERATIONS'') AND nullif(current_setting(''app.user_email'',true),'''') IS NOT NULL) WITH CHECK (current_setting(''app.user_role'',true) IN (''ADMIN'',''OPERATIONS'') AND nullif(current_setting(''app.user_email'',true),'''') IS NOT NULL)',t);
    EXECUTE format('CREATE POLICY acat_link_ingest_read ON app.%I FOR SELECT TO ingest_rw USING (true)',t);
    EXECUTE format('CREATE POLICY acat_link_owner ON app.%I TO %I USING (true) WITH CHECK (true)',t,current_user);
  END LOOP;
END $$;

CREATE POLICY acat_link_run_ingest_insert ON app.acat_link_run FOR INSERT TO ingest_rw
  WITH CHECK (created_role = 'INGEST' AND created_by IS NULL);
CREATE POLICY acat_link_run_ingest_update ON app.acat_link_run FOR UPDATE TO ingest_rw
  USING (true) WITH CHECK (true);
CREATE POLICY acat_link_decision_ingest_insert ON app.acat_link_decision FOR INSERT TO ingest_rw
  WITH CHECK (disposition = 'PENDING' AND review_version = 0 AND reviewed_by IS NULL
    AND reviewed_at IS NULL AND review_reason IS NULL AND outcome = 'PENDING');
CREATE POLICY acat_link_decision_ingest_update ON app.acat_link_decision FOR UPDATE TO ingest_rw
  USING (true) WITH CHECK (true);

-- Needed for canonical identity revalidation inside the ingest write tx.
GRANT EXECUTE ON FUNCTION app.resolve_crm_canonical_contact_source_key(text) TO ingest_rw;
