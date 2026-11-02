-- Always-On Advice — active Plaid-linked account summary mirror
-- (mirror.linked_external_account_summary). Hand-authored; ADR-9: no Prisma
-- model for mirror. Additive-only (ADR-5). Column aliases must match the
-- saved Warehouse card 6898 (AOA Plaid Linked Account Summary Ingest), pulled by
-- app/api/cron/linked-external-account-summary. Card 6898 never selects Plaid
-- access tokens, ISIN, CUSIP or cost basis, and none are stored here.
--
-- link_status is the warehouse literal 'ACTIVE' for rows present in the latest
-- snapshot; rows absent from a later snapshot are marked 'inactive' (ADR-7:
-- staleness, not deletes).

CREATE TABLE mirror.linked_external_account_summary (
  external_account_id        text PRIMARY KEY,
  client_sf_id               text,
  household_sf_id            text,
  institution_name           text,
  account_subtype            text,
  mask                       text,
  cash_amount                numeric(14,2),
  securities_amount          numeric(14,2),
  holdings_total             numeric(14,2),
  institution_balance        numeric(14,2),
  as_of                      timestamptz,
  link_status                text NOT NULL,
  lineage_key                text,
  prior_external_account_id  text,
  synced_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX linked_ext_summary_client_idx
  ON mirror.linked_external_account_summary (client_sf_id);
CREATE INDEX linked_ext_summary_household_idx
  ON mirror.linked_external_account_summary (household_sf_id);
CREATE INDEX linked_ext_summary_lineage_idx
  ON mirror.linked_external_account_summary (lineage_key);

GRANT USAGE ON SCHEMA mirror TO ingest_rw;
GRANT USAGE ON SCHEMA mirror TO app_rw;
GRANT SELECT, INSERT, UPDATE ON mirror.linked_external_account_summary TO ingest_rw;
GRANT SELECT ON mirror.linked_external_account_summary TO app_rw;

ALTER TABLE mirror.linked_external_account_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.linked_external_account_summary FORCE ROW LEVEL SECURITY;

CREATE POLICY linked_ext_summary_ingest_all ON mirror.linked_external_account_summary
  FOR ALL TO ingest_rw USING (true) WITH CHECK (true);

-- Firm view: ADMIN / OPERATIONS only. HEAD_OF_ADVISORY is retired;
-- normalizeAppRole maps it to OPERATIONS before the GUC is set.
CREATE POLICY linked_ext_summary_ops_all ON mirror.linked_external_account_summary
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
  );

-- Own-book: identical left(...,15) household join as client_account_aum_own_book.
-- The EXISTS reads mirror.household as app_rw, so household_own_book scopes it
-- to the caller's lead_advisor_email and fails closed for unknown households.
CREATE POLICY linked_ext_summary_own_book ON mirror.linked_external_account_summary
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
    AND EXISTS (
      SELECT 1
      FROM mirror.household h
      WHERE left(h.sf_id, 15) = left(linked_external_account_summary.household_sf_id, 15)
    )
  );
-- No DELETE policy (ADR-7).
