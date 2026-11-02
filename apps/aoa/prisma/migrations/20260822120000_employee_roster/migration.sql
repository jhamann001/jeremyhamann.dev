-- Admin-managed Rippling employee roster snapshots. The uploaded workbook is
-- parsed in memory and never stored. Roster PII and matching decisions are
-- ADMIN/OPERATIONS-only; app.employee_client_status is the minimal, book-
-- scoped projection used by household/client badges.

BEGIN;

CREATE TYPE "app"."EmployeeRosterUploadStatus" AS ENUM ('DRAFT', 'APPLIED', 'SUPERSEDED');
CREATE TYPE "app"."EmployeeEmploymentState" AS ENUM ('ACTIVE', 'FORMER');
CREATE TYPE "app"."EmployeeContactMappingState" AS ENUM ('CONFIRMED', 'REJECTED', 'INVALIDATED');

CREATE TABLE "app"."employee_roster_upload" (
  "id" TEXT NOT NULL,
  "file_sha256" CHAR(64) NOT NULL,
  "effective_date" DATE NOT NULL,
  "parser_version" VARCHAR(32) NOT NULL,
  "status" "app"."EmployeeRosterUploadStatus" NOT NULL DEFAULT 'DRAFT',
  "row_count" INTEGER NOT NULL,
  "employee_count" INTEGER NOT NULL,
  "dependent_row_count" INTEGER NOT NULL,
  "active_count" INTEGER NOT NULL,
  "former_count" INTEGER NOT NULL,
  "validation_error_count" INTEGER NOT NULL DEFAULT 0,
  "uploaded_by" VARCHAR(320) NOT NULL,
  "applied_by" VARCHAR(320),
  "applied_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "employee_roster_upload_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_roster_upload_identity_key"
    UNIQUE ("file_sha256", "effective_date", "parser_version"),
  CONSTRAINT "employee_roster_upload_hash_check" CHECK ("file_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "employee_roster_upload_counts_check" CHECK (
    "row_count" >= 0 AND "employee_count" >= 0 AND "dependent_row_count" >= 0
    AND "active_count" >= 0 AND "former_count" >= 0
    AND "validation_error_count" >= 0
    AND "active_count" + "former_count" = "employee_count"
  )
);

CREATE INDEX "employee_roster_upload_status_created_idx"
  ON "app"."employee_roster_upload"("status", "created_at" DESC);
CREATE UNIQUE INDEX "employee_roster_upload_one_applied"
  ON "app"."employee_roster_upload"((1)) WHERE "status" = 'APPLIED';

CREATE TABLE "app"."employee_roster_entry" (
  "id" TEXT NOT NULL,
  "upload_id" TEXT NOT NULL,
  "employee_id" VARCHAR(128) NOT NULL,
  "display_name" VARCHAR(240) NOT NULL,
  "source_status" VARCHAR(64) NOT NULL,
  "employment_state" "app"."EmployeeEmploymentState" NOT NULL,
  "start_date" DATE,
  "last_day" DATE,
  "legal_entity" VARCHAR(240),
  "dependent_row_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "employee_roster_entry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_roster_entry_upload_id_employee_id_key" UNIQUE ("upload_id", "employee_id"),
  CONSTRAINT "employee_roster_entry_upload_fkey" FOREIGN KEY ("upload_id")
    REFERENCES "app"."employee_roster_upload"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "employee_roster_entry_employee_id_check" CHECK (length(btrim("employee_id")) BETWEEN 1 AND 128),
  CONSTRAINT "employee_roster_entry_name_check" CHECK (length(btrim("display_name")) BETWEEN 1 AND 240),
  CONSTRAINT "employee_roster_entry_dependents_check" CHECK ("dependent_row_count" >= 0)
);

CREATE INDEX "employee_roster_entry_employee_idx"
  ON "app"."employee_roster_entry"("employee_id");
CREATE INDEX "employee_roster_entry_upload_state_idx"
  ON "app"."employee_roster_entry"("upload_id", "employment_state");

CREATE TABLE "app"."employee_contact_mapping" (
  "id" TEXT NOT NULL,
  "employee_id" VARCHAR(128) NOT NULL,
  "contact_identity_id" TEXT NOT NULL,
  "client_sf_id" VARCHAR(64) NOT NULL,
  "state" "app"."EmployeeContactMappingState" NOT NULL,
  "evidence" VARCHAR(32) NOT NULL,
  "reviewed_by" VARCHAR(320) NOT NULL,
  "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "employee_contact_mapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_contact_mapping_employee_contact_key" UNIQUE ("employee_id", "contact_identity_id"),
  CONSTRAINT "employee_contact_mapping_identity_fkey" FOREIGN KEY ("contact_identity_id")
    REFERENCES "app"."crm_identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "employee_contact_mapping_evidence_check" CHECK ("evidence" IN ('EXACT_NAME', 'MANUAL_SEARCH'))
);

CREATE INDEX "employee_contact_mapping_employee_state_idx"
  ON "app"."employee_contact_mapping"("employee_id", "state");
CREATE INDEX "employee_contact_mapping_client_state_idx"
  ON "app"."employee_contact_mapping"("client_sf_id", "state");
CREATE UNIQUE INDEX "employee_contact_mapping_one_confirmed_employee"
  ON "app"."employee_contact_mapping"("employee_id") WHERE "state" = 'CONFIRMED';
CREATE UNIQUE INDEX "employee_contact_mapping_one_confirmed_client"
  ON "app"."employee_contact_mapping"("client_sf_id") WHERE "state" = 'CONFIRMED';

CREATE OR REPLACE FUNCTION "app"."validate_employee_contact_mapping"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, mirror
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM app.crm_identity i
      JOIN app.crm_source_mapping m ON m.identity_id = i.id
      JOIN mirror.client c ON left(c.sf_id, 15) = left(NEW.client_sf_id, 15)
     WHERE i.id = NEW.contact_identity_id
       AND i.identity_type = 'CONTACT'
       AND i.lifecycle_state = 'ACTIVE'
       AND m.mapping_state = 'ACTIVE'
       AND m.source_system = 'CRM'
       AND m.source_namespace = 'contact'
       AND left(m.source_key, 15) = left(NEW.client_sf_id, 15)
  ) THEN
    RAISE EXCEPTION 'Employee mapping requires an active CRM contact'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER employee_contact_mapping_validate
  BEFORE INSERT OR UPDATE OF contact_identity_id, client_sf_id
  ON "app"."employee_contact_mapping"
  FOR EACH ROW EXECUTE FUNCTION "app"."validate_employee_contact_mapping"();

CREATE TABLE "app"."employee_client_status" (
  "client_sf_id" VARCHAR(64) NOT NULL,
  "employment_state" "app"."EmployeeEmploymentState" NOT NULL,
  "effective_date" DATE NOT NULL,
  "source_upload_id" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "employee_client_status_pkey" PRIMARY KEY ("client_sf_id"),
  CONSTRAINT "employee_client_status_upload_fkey" FOREIGN KEY ("source_upload_id")
    REFERENCES "app"."employee_roster_upload"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "employee_client_status_state_idx"
  ON "app"."employee_client_status"("employment_state");

-- Badge visibility is evaluated against current CRM state on every read, not
-- only when the derived cache is rebuilt. This narrowly scoped definer helper
-- exposes one boolean and never returns employee or CRM mapping details.
CREATE FUNCTION "app"."employee_badge_is_current"(subject_client_sf_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app, mirror
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM app.employee_contact_mapping m
      JOIN app.crm_identity i
        ON i.id = m.contact_identity_id
       AND i.identity_type = 'CONTACT' AND i.lifecycle_state = 'ACTIVE'
      JOIN app.crm_source_mapping sm
        ON sm.identity_id = i.id
       AND sm.source_system = 'CRM' AND sm.source_namespace = 'contact'
       AND sm.mapping_state = 'ACTIVE'
       AND left(sm.source_key, 15) = left(m.client_sf_id, 15)
      JOIN mirror.client c ON left(c.sf_id, 15) = left(m.client_sf_id, 15)
     WHERE m.state = 'CONFIRMED'
       AND left(m.client_sf_id, 15) = left(subject_client_sf_id, 15)
       AND (
         current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
         OR (
           current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
           AND c.lead_advisor_email = current_setting('app.user_email', true)
         )
       )
  )
$$;
REVOKE ALL ON FUNCTION "app"."employee_badge_is_current"(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app"."employee_badge_is_current"(text) TO app_rw;

-- The parser/action layer never issues DELETE against snapshots or match
-- decisions. The derived badge projection may be rebuilt as part of an apply or
-- match replacement, so DELETE remains available there to Admin/Ops only.
REVOKE ALL ON "app"."employee_roster_upload" FROM PUBLIC, app_rw;
REVOKE ALL ON "app"."employee_roster_entry" FROM PUBLIC, app_rw;
REVOKE ALL ON "app"."employee_contact_mapping" FROM PUBLIC, app_rw;
REVOKE ALL ON "app"."employee_client_status" FROM PUBLIC, app_rw;
GRANT SELECT, INSERT ON "app"."employee_roster_upload" TO app_rw;
GRANT UPDATE ("status", "applied_by", "applied_at", "updated_at")
  ON "app"."employee_roster_upload" TO app_rw;
GRANT SELECT, INSERT ON "app"."employee_roster_entry" TO app_rw;
GRANT SELECT, INSERT ON "app"."employee_contact_mapping" TO app_rw;
GRANT UPDATE ("client_sf_id", "state", "evidence", "reviewed_by", "reviewed_at", "updated_at")
  ON "app"."employee_contact_mapping" TO app_rw;
GRANT SELECT, INSERT, DELETE ON "app"."employee_client_status" TO app_rw;

ALTER TABLE "app"."employee_roster_upload" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."employee_roster_upload" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."employee_roster_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."employee_roster_entry" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."employee_contact_mapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."employee_contact_mapping" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."employee_client_status" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."employee_client_status" FORCE ROW LEVEL SECURITY;

CREATE POLICY employee_roster_upload_ops_read ON "app"."employee_roster_upload"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY employee_roster_upload_ops_insert ON "app"."employee_roster_upload"
  FOR INSERT TO app_rw
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY employee_roster_upload_ops_update ON "app"."employee_roster_upload"
  FOR UPDATE TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'))
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));

CREATE POLICY employee_roster_entry_ops_read ON "app"."employee_roster_entry"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY employee_roster_entry_ops_insert ON "app"."employee_roster_entry"
  FOR INSERT TO app_rw
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));

CREATE POLICY employee_contact_mapping_ops_read ON "app"."employee_contact_mapping"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY employee_contact_mapping_ops_insert ON "app"."employee_contact_mapping"
  FOR INSERT TO app_rw
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY employee_contact_mapping_ops_update ON "app"."employee_contact_mapping"
  FOR UPDATE TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'))
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));

CREATE POLICY employee_client_status_ops_read ON "app"."employee_client_status"
  FOR SELECT TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY employee_client_status_ops_insert ON "app"."employee_client_status"
  FOR INSERT TO app_rw
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY employee_client_status_ops_delete ON "app"."employee_client_status"
  FOR DELETE TO app_rw
  USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));

-- This table contains only a client source key plus a two-value status. The
-- EXISTS query is evaluated under mirror.client's own FORCE-RLS book policy, so
-- advisors/client-service can receive a badge only for a client already visible
-- to them. They receive no write policy and no access to roster/match tables.
CREATE POLICY employee_client_status_book_read ON "app"."employee_client_status"
  FOR SELECT TO app_rw
  USING (
    current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
    AND app.employee_badge_is_current(employee_client_status.client_sf_id)
    AND EXISTS (
      SELECT 1 FROM mirror.client c
       WHERE left(c.sf_id, 15) = left(employee_client_status.client_sf_id, 15)
    )
  );

DO $$
DECLARE owner_roles text;
DECLARE table_name text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ') INTO owner_roles
    FROM pg_roles WHERE rolname IN ('aoa', 'aoa_admin');
  IF owner_roles IS NOT NULL THEN
    FOREACH table_name IN ARRAY ARRAY[
      'employee_roster_upload', 'employee_roster_entry',
      'employee_contact_mapping', 'employee_client_status'
    ] LOOP
      EXECUTE format(
        'CREATE POLICY %I ON app.%I FOR SELECT TO %s USING (true)',
        table_name || '_owner_read', table_name, owner_roles
      );
      EXECUTE format(
        'CREATE POLICY %I ON app.%I FOR INSERT TO %s WITH CHECK (true)',
        table_name || '_owner_insert', table_name, owner_roles
      );
      EXECUTE format(
        'CREATE POLICY %I ON app.%I FOR UPDATE TO %s USING (true) WITH CHECK (true)',
        table_name || '_owner_update', table_name, owner_roles
      );
      EXECUTE format(
        'CREATE POLICY %I ON app.%I FOR DELETE TO %s USING (true)',
        table_name || '_owner_delete', table_name, owner_roles
      );
    END LOOP;
  END IF;
END $$;

COMMIT;
