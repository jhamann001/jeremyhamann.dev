CREATE TABLE app.custodian_snapshot_import (
  id text PRIMARY KEY,
  snapshot_sha256 char(64) NOT NULL UNIQUE CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE app.custodian_snapshot_import_item (
  id text PRIMARY KEY,
  import_id text NOT NULL REFERENCES app.custodian_snapshot_import(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('custodian', 'fee_rule', 'fee_schedule_file')),
  original_id text NOT NULL CHECK (char_length(original_id) BETWEEN 1 AND 191),
  byte_count integer NOT NULL CHECK (byte_count >= 0 AND byte_count <= 10485760),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  revision bigint CHECK (revision IS NULL OR revision >= 1),
  authority_id text NOT NULL,
  confirmed boolean NOT NULL DEFAULT false,
  UNIQUE (import_id, kind, original_id),
  CHECK (kind = 'fee_schedule_file' OR revision IS NOT NULL),
  CHECK (kind <> 'fee_schedule_file' OR revision IS NULL)
);

REVOKE ALL ON app.custodian_snapshot_import FROM PUBLIC;
REVOKE ALL ON app.custodian_snapshot_import_item FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON app.custodian_snapshot_import TO app_rw;
GRANT SELECT, INSERT, UPDATE ON app.custodian_snapshot_import_item TO app_rw;

ALTER TABLE app.custodian_snapshot_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.custodian_snapshot_import FORCE ROW LEVEL SECURITY;
ALTER TABLE app.custodian_snapshot_import_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.custodian_snapshot_import_item FORCE ROW LEVEL SECURITY;

CREATE POLICY custodian_snapshot_import_app_rw ON app.custodian_snapshot_import
  FOR ALL TO app_rw
  USING (current_setting('app.user_role', true) = 'ADMIN' AND current_setting('app.user_email', true) <> '')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN' AND current_setting('app.user_email', true) <> '');

CREATE POLICY custodian_snapshot_import_item_app_rw ON app.custodian_snapshot_import_item
  FOR ALL TO app_rw
  USING (current_setting('app.user_role', true) = 'ADMIN' AND current_setting('app.user_email', true) <> '')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN' AND current_setting('app.user_email', true) <> '');

DO $$
DECLARE
  owner_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ')
    INTO owner_roles
    FROM pg_roles
   WHERE rolname IN ('aoa', 'aoa_admin');
  IF owner_roles IS NOT NULL THEN
    EXECUTE format('CREATE POLICY custodian_snapshot_import_owner_all ON app.custodian_snapshot_import FOR ALL TO %s USING (true) WITH CHECK (true)', owner_roles);
    EXECUTE format('CREATE POLICY custodian_snapshot_import_item_owner_all ON app.custodian_snapshot_import_item FOR ALL TO %s USING (true) WITH CHECK (true)', owner_roles);
  END IF;
END $$;

CREATE TRIGGER custodian_snapshot_import_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."custodian_snapshot_import"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();
CREATE TRIGGER custodian_snapshot_import_item_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."custodian_snapshot_import_item"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();
