-- AOA-owned review decisions, independent of the n8n source payload.
CREATE TABLE app.schwab_account_mapping (
  account_id text PRIMARY KEY CHECK (account_id ~ '^schw_[0-9a-f]{32}$'),
  account_number_last4 text NOT NULL CHECK (account_number_last4 ~ '^[0-9]{4}$'),
  client_sf_id text REFERENCES mirror.client(sf_id) ON DELETE RESTRICT,
  household_sf_id text REFERENCES mirror.household(sf_id) ON DELETE RESTRICT,
  account_scope text NOT NULL CHECK (account_scope IN ('CLIENT', 'FIRM_OPERATING')),
  version integer NOT NULL CHECK (version > 0),
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((account_scope = 'CLIENT' AND household_sf_id IS NOT NULL)
    OR (account_scope = 'FIRM_OPERATING' AND client_sf_id IS NULL AND household_sf_id IS NULL))
);

CREATE TABLE app.schwab_account_mapping_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL REFERENCES app.schwab_account_mapping(account_id),
  version integer NOT NULL,
  previous_decision jsonb,
  decision jsonb NOT NULL,
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, version)
);

ALTER TABLE app.schwab_account_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.schwab_account_mapping FORCE ROW LEVEL SECURITY;
ALTER TABLE app.schwab_account_mapping_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.schwab_account_mapping_event FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.schwab_account_mapping, app.schwab_account_mapping_event FROM PUBLIC, app_rw, ingest_rw;
GRANT SELECT, INSERT, UPDATE ON app.schwab_account_mapping TO app_rw;
GRANT SELECT ON app.schwab_account_mapping_event TO app_rw;
GRANT SELECT (account_id, account_number_last4, client_sf_id, household_sf_id, account_scope, version)
  ON app.schwab_account_mapping TO ingest_rw;
CREATE POLICY schwab_mapping_ops ON app.schwab_account_mapping TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'))
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY schwab_mapping_ingest_read ON app.schwab_account_mapping FOR SELECT TO ingest_rw USING (true);
CREATE POLICY schwab_mapping_event_ops_read ON app.schwab_account_mapping_event FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));

-- The trigger owns provenance; caller-supplied actor/time/version is not trusted.
CREATE FUNCTION app.stamp_schwab_account_mapping() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app, mirror AS $$
BEGIN
  IF coalesce(current_setting('app.user_role', true), '') NOT IN ('ADMIN', 'OPERATIONS')
     OR coalesce(current_setting('app.user_email', true), '') = '' THEN
    RAISE EXCEPTION 'Not authorized to review Schwab mappings' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.account_id <> OLD.account_id
     OR NEW.account_number_last4 <> OLD.account_number_last4) THEN
    RAISE EXCEPTION 'Account identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.client_sf_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM mirror.client c WHERE c.sf_id = NEW.client_sf_id
      AND left(c.household_id, 15) = left(NEW.household_sf_id, 15)
  ) THEN
    RAISE EXCEPTION 'Reviewed membership mismatch' USING ERRCODE = '23514';
  END IF;
  NEW.version := CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE OLD.version + 1 END;
  NEW.reviewed_by := current_setting('app.user_email', true);
  NEW.reviewed_at := statement_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.stamp_schwab_account_mapping() FROM PUBLIC;
CREATE TRIGGER stamp_schwab_account_mapping BEFORE INSERT OR UPDATE ON app.schwab_account_mapping
  FOR EACH ROW EXECUTE FUNCTION app.stamp_schwab_account_mapping();

-- No app/ingest write grants on history. Only this append trigger writes it.
CREATE FUNCTION app.audit_schwab_account_mapping() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  INSERT INTO app.schwab_account_mapping_event
    (account_id, version, previous_decision, decision, reviewed_by, reviewed_at)
  VALUES (NEW.account_id, NEW.version,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    to_jsonb(NEW), NEW.reviewed_by, NEW.reviewed_at);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.audit_schwab_account_mapping() FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY schwab_mapping_event_owner_insert ON app.schwab_account_mapping_event FOR INSERT TO %I WITH CHECK (true)', current_user);
END $$;
CREATE TRIGGER audit_schwab_account_mapping AFTER INSERT OR UPDATE ON app.schwab_account_mapping
  FOR EACH ROW EXECUTE FUNCTION app.audit_schwab_account_mapping();

ALTER TABLE mirror.schwab_account_balance
  ADD COLUMN account_scope text NOT NULL DEFAULT 'UNCLASSIFIED'
    CHECK (account_scope IN ('CLIENT', 'FIRM_OPERATING', 'UNCLASSIFIED')),
  ADD COLUMN reviewed_mapping_version integer CHECK (reviewed_mapping_version > 0);
ALTER TABLE mirror.schwab_account_balance DROP CONSTRAINT schwab_account_resolution_method_check;
ALTER TABLE mirror.schwab_account_balance ADD CONSTRAINT schwab_account_resolution_method_check CHECK (
  resolution_method IN ('CRM_ACCOUNT_NUMBER', 'OPERATIONS_REVIEWED',
    'EXACT_CLIENT_NAME', 'EXACT_HOUSEHOLD_NAME', 'AMBIGUOUS_NAME', 'UNMATCHED')
);
ALTER TABLE mirror.schwab_account_balance DROP CONSTRAINT schwab_account_resolution_shape_check;
ALTER TABLE mirror.schwab_account_balance ADD CONSTRAINT schwab_account_resolution_shape_check CHECK (
  (resolution_state = 'CONFIRMED'
    AND (household_sf_id IS NOT NULL OR account_scope = 'FIRM_OPERATING')
    AND candidate_client_sf_id IS NULL AND candidate_household_sf_id IS NULL)
  OR (resolution_state = 'PROPOSED' AND client_sf_id IS NULL AND household_sf_id IS NULL
    AND candidate_household_sf_id IS NOT NULL)
  OR (resolution_state IN ('REVIEW_REQUIRED', 'UNMATCHED')
    AND client_sf_id IS NULL AND household_sf_id IS NULL
    AND candidate_client_sf_id IS NULL AND candidate_household_sf_id IS NULL)
);
ALTER TABLE mirror.schwab_account_balance ADD CONSTRAINT schwab_account_reviewed_scope_check CHECK (
  (account_scope <> 'FIRM_OPERATING' OR (
    client_sf_id IS NULL AND household_sf_id IS NULL AND resolution_method = 'OPERATIONS_REVIEWED'))
  AND ((resolution_method = 'OPERATIONS_REVIEWED') = (reviewed_mapping_version IS NOT NULL))
);
GRANT SELECT (account_scope, reviewed_mapping_version) ON mirror.schwab_account_balance TO app_rw;
