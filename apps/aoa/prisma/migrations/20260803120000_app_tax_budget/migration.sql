-- Client Portrait — manual per-client tax budgets.
--
-- The former Core Financial card read repository sample fixtures and kept edits
-- only in browser memory. This app-owned table makes the advisor/user-entered
-- realized-gains budget durable while preserving yearly history.
--
-- Data-class and access posture:
--   * app-owned, human-written only; ingestion has no grant.
--   * no FK to mirror.client: the mirror is replaceable ingest state.
--   * visibility is inherited from mirror.client's RLS. A tax-budget row is
--     visible/writable only when that client is visible to the current caller.
--   * ADMIN/OPERATIONS/HEAD_OF_ADVISORY/ADVISOR/CLIENT_SERVICE may write;
--     VIEWER and missing/unknown roles fail closed.
--   * hard delete is unavailable. Historical years remain on file.
--   * every insert/update/delete is captured by audit.log_row_change().

CREATE TABLE "app"."tax_budget" (
    "id" TEXT NOT NULL,
    "client_sf_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "budget" DECIMAL(15,2) NOT NULL,
    "realized" DECIMAL(15,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "set_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tax_budget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tax_budget_year_check" CHECK ("year" BETWEEN 2000 AND 2100),
    CONSTRAINT "tax_budget_budget_nonnegative" CHECK ("budget" >= 0),
    CONSTRAINT "tax_budget_realized_nonnegative" CHECK ("realized" >= 0),
    CONSTRAINT "tax_budget_note_length" CHECK (char_length("note") <= 2000)
);

CREATE UNIQUE INDEX "tax_budget_client_sf_id_year_key"
  ON "app"."tax_budget"("client_sf_id", "year");
CREATE INDEX "tax_budget_client_sf_id_year_idx"
  ON "app"."tax_budget"("client_sf_id", "year" DESC);

GRANT SELECT, INSERT, UPDATE ON "app"."tax_budget" TO app_rw;
REVOKE DELETE ON "app"."tax_budget" FROM app_rw;

ALTER TABLE "app"."tax_budget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."tax_budget" FORCE ROW LEVEL SECURITY;

-- The EXISTS subquery is intentionally evaluated through mirror.client's own
-- FORCE-RLS policies, so Operations/Admin/HoA see the firm and an Advisor or
-- Client-Service user sees only their own book. No duplicated advisor predicate
-- can drift from the canonical client policy.
CREATE POLICY tax_budget_read_visible_client ON "app"."tax_budget"
  FOR SELECT TO app_rw
  USING (
    EXISTS (
      SELECT 1 FROM mirror.client c
      WHERE c.sf_id = tax_budget.client_sf_id
    )
  );

CREATE POLICY tax_budget_insert_visible_client ON "app"."tax_budget"
  FOR INSERT TO app_rw
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
    AND EXISTS (
      SELECT 1 FROM mirror.client c
      WHERE c.sf_id = tax_budget.client_sf_id
    )
  );

CREATE POLICY tax_budget_update_visible_client ON "app"."tax_budget"
  FOR UPDATE TO app_rw
  USING (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
    AND EXISTS (
      SELECT 1 FROM mirror.client c
      WHERE c.sf_id = tax_budget.client_sf_id
    )
  )
  WITH CHECK (
    current_setting('app.user_role', true) IN
      ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY', 'ADVISOR', 'CLIENT_SERVICE')
    AND EXISTS (
      SELECT 1 FROM mirror.client c
      WHERE c.sf_id = tax_budget.client_sf_id
    )
  );

-- No DELETE policy. The runtime role also has no DELETE grant.

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
      'CREATE POLICY tax_budget_owner_all ON "app"."tax_budget" FOR ALL TO %s USING (true) WITH CHECK (true)',
      owner_roles
    );
  END IF;
END $$;

CREATE TRIGGER tax_budget_audit
  AFTER INSERT OR UPDATE OR DELETE ON "app"."tax_budget"
  FOR EACH ROW EXECUTE FUNCTION audit.log_row_change();
