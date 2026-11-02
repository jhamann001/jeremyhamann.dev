-- ticket: Always-On Advice custodian authority storage. Ships dark.
--
-- Four app-owned tables:
--   * custodian_profile          profile and transfer playbook, one row per custodian
--   * custodian_fee_rule         fee rules; removal is retirement, never deletion
--   * custodian_authority_state  singleton: last accepted and last transfer-copy-confirmed revision
--   * custodian_authority_event  append-only change log, one row per accepted revision
--
-- Identity: TEXT ids with no database default, so an import keeps Tracker ids exactly.
-- Retired Tracker fields (recentClients, requiresManualReview) are not stored.
-- No foreign key to any transfer table: Tracker owns transfers and applies merges itself.
-- Access: ADMIN/OPERATIONS read, ADMIN writes, app_rw has no DELETE anywhere. The owner
-- roles keep full access for maintenance. The snapshot import does not write these
-- tables as the owner: it calls saveCustodianAuthority, then confirmCustodianAuthorityRevision.
-- Every row change is captured by audit.log_row_change().

CREATE TABLE "app"."custodian_profile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "acat_fee_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avg_processing_days" INTEGER NOT NULL DEFAULT 7,
    "contact_email" TEXT,
    "contact_method" TEXT,
    "contact_details" TEXT,
    "review_status" TEXT NOT NULL DEFAULT 'VERIFIED',
    "transfer_type" TEXT,
    "documentation_status" TEXT,
    "dtc_number" TEXT,
    "receiving_account_number" TEXT,
    "signature" TEXT,
    "letter_of_acceptance" TEXT,
    "medallion_required" TEXT,
    "liquidation_method" TEXT,
    "return_method" TEXT,
    "watchouts" TEXT,
    "paperwork_on_file" BOOLEAN,
    "transfers_to_date" INTEGER,
    "merged_into_id" TEXT,
    "retired_at" TIMESTAMPTZ(6),
    "revision" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "custodian_profile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "custodian_profile_name_check" CHECK (char_length(btrim("name")) > 0),
    CONSTRAINT "custodian_profile_review_status_check" CHECK ("review_status" IN ('NEEDS_SETUP', 'VERIFIED')),
    CONSTRAINT "custodian_profile_transfer_type_check" CHECK ("transfer_type" IN ('ACAT_API', 'MANUAL', 'MIXED', 'INTERNAL', 'UNCONFIRMED')),
    CONSTRAINT "custodian_profile_documentation_status_check" CHECK ("documentation_status" IN ('DOCUMENTED', 'PARTIAL', 'NEEDS_CALL')),
    CONSTRAINT "custodian_profile_contact_method_check" CHECK ("contact_method" IN ('EMAIL', 'PHONE', 'PORTAL', 'OTHER')),
    CONSTRAINT "custodian_profile_avg_processing_days_check" CHECK ("avg_processing_days" >= 0),
    CONSTRAINT "custodian_profile_transfers_to_date_check" CHECK ("transfers_to_date" >= 0),
    CONSTRAINT "custodian_profile_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "custodian_profile_merge_check" CHECK (
      "merged_into_id" IS NULL OR ("retired_at" IS NOT NULL AND "merged_into_id" <> "id")
    )
);

CREATE UNIQUE INDEX "custodian_profile_name_key" ON "app"."custodian_profile"("name");

ALTER TABLE "app"."custodian_profile"
  ADD CONSTRAINT "custodian_profile_merged_into_id_fkey"
  FOREIGN KEY ("merged_into_id") REFERENCES "app"."custodian_profile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "app"."custodian_fee_rule" (
    "id" TEXT NOT NULL,
    "custodian_id" TEXT NOT NULL,
    "fee_type" TEXT NOT NULL,
    "account_type" TEXT NOT NULL DEFAULT 'ANY',
    "transfer_type" TEXT NOT NULL DEFAULT 'ANY',
    "direction" TEXT NOT NULL DEFAULT 'ANY',
    "amount" DOUBLE PRECISION,
    "amount_text" TEXT,
    "notes" TEXT,
    "documentation" TEXT,
    "retired_at" TIMESTAMPTZ(6),
    "revision" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "custodian_fee_rule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "custodian_fee_rule_account_type_check" CHECK ("account_type" IN ('ANY', 'IRA', 'BROKERAGE')),
    CONSTRAINT "custodian_fee_rule_transfer_type_check" CHECK ("transfer_type" IN ('ANY', 'FULL', 'PARTIAL')),
    CONSTRAINT "custodian_fee_rule_direction_check" CHECK ("direction" IN ('ANY', 'IN', 'OUT')),
    CONSTRAINT "custodian_fee_rule_revision_check" CHECK ("revision" >= 0)
);

CREATE INDEX "custodian_fee_rule_custodian_id_idx" ON "app"."custodian_fee_rule"("custodian_id");
CREATE INDEX "custodian_fee_rule_custodian_id_account_type_idx" ON "app"."custodian_fee_rule"("custodian_id", "account_type");

ALTER TABLE "app"."custodian_fee_rule"
  ADD CONSTRAINT "custodian_fee_rule_custodian_id_fkey"
  FOREIGN KEY ("custodian_id") REFERENCES "app"."custodian_profile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "app"."custodian_authority_state" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "accepted_revision" BIGINT NOT NULL DEFAULT 0,
    "confirmed_revision" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "custodian_authority_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "custodian_authority_state_singleton_check" CHECK ("id" = 1),
    CONSTRAINT "custodian_authority_state_revision_check" CHECK (
      "confirmed_revision" >= 0 AND "confirmed_revision" <= "accepted_revision"
    )
);

INSERT INTO "app"."custodian_authority_state" ("id") VALUES (1);

CREATE TABLE "app"."custodian_authority_event" (
    "revision" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "custodian_id" TEXT NOT NULL,
    "merged_from_id" TEXT,
    "payload" JSONB NOT NULL,
    "actor_email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "custodian_authority_event_pkey" PRIMARY KEY ("revision"),
    CONSTRAINT "custodian_authority_event_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "custodian_authority_event_kind_check" CHECK ("kind" IN ('CUSTODIAN_SAVE', 'CUSTODIAN_MERGE')),
    CONSTRAINT "custodian_authority_event_merge_check" CHECK (("kind" = 'CUSTODIAN_MERGE') = ("merged_from_id" IS NOT NULL))
);

CREATE INDEX "custodian_authority_event_custodian_id_idx" ON "app"."custodian_authority_event"("custodian_id");

ALTER TABLE "app"."custodian_authority_event"
  ADD CONSTRAINT "custodian_authority_event_custodian_id_fkey"
  FOREIGN KEY ("custodian_id") REFERENCES "app"."custodian_profile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app"."custodian_authority_event"
  ADD CONSTRAINT "custodian_authority_event_merged_from_id_fkey"
  FOREIGN KEY ("merged_from_id") REFERENCES "app"."custodian_profile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON "app"."custodian_profile" TO app_rw;
REVOKE DELETE ON "app"."custodian_profile" FROM app_rw;
GRANT SELECT, INSERT, UPDATE ON "app"."custodian_fee_rule" TO app_rw;
REVOKE DELETE ON "app"."custodian_fee_rule" FROM app_rw;
GRANT SELECT, UPDATE ON "app"."custodian_authority_state" TO app_rw;
REVOKE INSERT, DELETE ON "app"."custodian_authority_state" FROM app_rw;
GRANT SELECT, INSERT ON "app"."custodian_authority_event" TO app_rw;
REVOKE UPDATE, DELETE ON "app"."custodian_authority_event" FROM app_rw;

ALTER TABLE "app"."custodian_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."custodian_profile" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."custodian_fee_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."custodian_fee_rule" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."custodian_authority_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."custodian_authority_state" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."custodian_authority_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."custodian_authority_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY custodian_profile_read ON "app"."custodian_profile"
  FOR SELECT TO app_rw USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY custodian_profile_admin_insert ON "app"."custodian_profile"
  FOR INSERT TO app_rw WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');
CREATE POLICY custodian_profile_admin_update ON "app"."custodian_profile"
  FOR UPDATE TO app_rw
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY custodian_fee_rule_read ON "app"."custodian_fee_rule"
  FOR SELECT TO app_rw USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY custodian_fee_rule_admin_insert ON "app"."custodian_fee_rule"
  FOR INSERT TO app_rw WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');
CREATE POLICY custodian_fee_rule_admin_update ON "app"."custodian_fee_rule"
  FOR UPDATE TO app_rw
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY custodian_authority_state_read ON "app"."custodian_authority_state"
  FOR SELECT TO app_rw USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY custodian_authority_state_admin_update ON "app"."custodian_authority_state"
  FOR UPDATE TO app_rw
  USING (current_setting('app.user_role', true) = 'ADMIN')
  WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

CREATE POLICY custodian_authority_event_read ON "app"."custodian_authority_event"
  FOR SELECT TO app_rw USING (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS'));
CREATE POLICY custodian_authority_event_admin_insert ON "app"."custodian_authority_event"
  FOR INSERT TO app_rw WITH CHECK (current_setting('app.user_role', true) = 'ADMIN');

-- No DELETE policy on any table; app_rw also has no DELETE grant.

DO $$
DECLARE
  owner_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ')
    INTO owner_roles
    FROM pg_roles
   WHERE rolname IN ('aoa', 'aoa_admin');
  IF owner_roles IS NOT NULL THEN
    EXECUTE format('CREATE POLICY custodian_profile_owner_all ON "app"."custodian_profile" FOR ALL TO %s USING (true) WITH CHECK (true)', owner_roles);
    EXECUTE format('CREATE POLICY custodian_fee_rule_owner_all ON "app"."custodian_fee_rule" FOR ALL TO %s USING (true) WITH CHECK (true)', owner_roles);
    EXECUTE format('CREATE POLICY custodian_authority_state_owner_all ON "app"."custodian_authority_state" FOR ALL TO %s USING (true) WITH CHECK (true)', owner_roles);
    EXECUTE format('CREATE POLICY custodian_authority_event_owner_all ON "app"."custodian_authority_event" FOR ALL TO %s USING (true) WITH CHECK (true)', owner_roles);
  END IF;
END $$;

CREATE TRIGGER custodian_profile_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."custodian_profile"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();
CREATE TRIGGER custodian_fee_rule_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."custodian_fee_rule"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();
CREATE TRIGGER custodian_authority_state_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."custodian_authority_state"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();
CREATE TRIGGER custodian_authority_event_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."custodian_authority_event"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();
