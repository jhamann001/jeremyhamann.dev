-- Client Portrait — human confirmation of the authoritative approved Trade
-- Request for one Apex account. This stores provenance only; instruction facts
-- remain in the Trade Request service and are read live.

CREATE TABLE "app"."trade_profile_selection" (
    "id" TEXT NOT NULL,
    "client_sf_id" TEXT NOT NULL,
    "custodian_account_id" TEXT NOT NULL,
    "selected_request_id" TEXT NOT NULL,
    "selected_request_decided_at" TIMESTAMPTZ(6) NOT NULL,
    "reviewed_request_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "selection_note" TEXT NOT NULL DEFAULT '',
    "selected_by" TEXT,
    "selected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trade_profile_selection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trade_profile_selection_account_length"
      CHECK (char_length("custodian_account_id") BETWEEN 1 AND 128),
    CONSTRAINT "trade_profile_selection_request_length"
      CHECK (char_length("selected_request_id") BETWEEN 1 AND 128),
    CONSTRAINT "trade_profile_selection_reviewed_request_limit"
      CHECK (cardinality("reviewed_request_ids") <= 1000),
    CONSTRAINT "trade_profile_selection_note_length"
      CHECK (char_length("selection_note") <= 500)
);

CREATE UNIQUE INDEX "trade_profile_selection_client_account_key"
  ON "app"."trade_profile_selection"("client_sf_id", "custodian_account_id");
CREATE INDEX "trade_profile_selection_client_sf_id_idx"
  ON "app"."trade_profile_selection"("client_sf_id");
CREATE INDEX "trade_profile_selection_selected_request_id_idx"
  ON "app"."trade_profile_selection"("selected_request_id");

GRANT SELECT, INSERT, UPDATE ON "app"."trade_profile_selection" TO app_rw;
REVOKE DELETE ON "app"."trade_profile_selection" FROM app_rw;

ALTER TABLE "app"."trade_profile_selection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."trade_profile_selection" FORCE ROW LEVEL SECURITY;

CREATE POLICY trade_profile_selection_read_visible_client
  ON "app"."trade_profile_selection"
  FOR SELECT TO app_rw
  USING (
    EXISTS (
      SELECT 1 FROM mirror.client c
      WHERE c.sf_id = trade_profile_selection.client_sf_id
    )
  );

CREATE POLICY trade_profile_selection_insert_visible_client
  ON "app"."trade_profile_selection"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE')
    AND EXISTS (
      SELECT 1 FROM mirror.client c
      WHERE c.sf_id = trade_profile_selection.client_sf_id
    )
  );

CREATE POLICY trade_profile_selection_update_visible_client
  ON "app"."trade_profile_selection"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE')
    AND EXISTS (
      SELECT 1 FROM mirror.client c
      WHERE c.sf_id = trade_profile_selection.client_sf_id
    )
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE')
    AND EXISTS (
      SELECT 1 FROM mirror.client c
      WHERE c.sf_id = trade_profile_selection.client_sf_id
    )
  );

DO $$
DECLARE
  owner_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ')
    INTO owner_roles
    FROM pg_roles
   WHERE rolname IN ('aoa', 'aoa_admin');
  IF owner_roles IS NOT NULL THEN
    EXECUTE format(
      'CREATE POLICY trade_profile_selection_owner_all ON "app"."trade_profile_selection" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;

CREATE TRIGGER trade_profile_selection_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."trade_profile_selection"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();
