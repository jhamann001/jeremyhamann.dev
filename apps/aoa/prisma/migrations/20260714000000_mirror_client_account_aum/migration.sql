-- Always-On Advice — tkt per-account AUM feed (mirror.client_account_aum).
--
-- The app PULLS start-of-day per-Apex-account market value from a saved
-- Warehouse question (card 6436, "AUM and account info - AOA") on a daily cron
-- (app/api/cron/account-aum) and mirrors one row per Apex account here. The
-- Client Portrait accounts card + the Portrait/Household/Reminders header AUM
-- read it back (lib/data/account-aum.ts), Apex-first ahead of the deals- and
-- mirror.household-derived totals.
--
-- Hand-authored, following the mirror_roles_grants_rls idiom EXACTLY as
-- prisma/migrations/20260703180639_mirror_account_ingest/migration.sql
-- (ADR-9: NO Prisma models for `mirror`). Additive-only (ADR-5): one new table,
-- its indexes, grants, and FORCE RLS + policies — nothing altered/dropped.

-- ---------------------------------------------------------------------------
-- 1. mirror.client_account_aum — one row per Apex account, keyed on the account
--    number. Columns match the Warehouse card 6436 aliases (as_of is the SOD
--    snapshot time; account_aum is dollars). is_managed is coerced to boolean
--    at the ingest seam (the card emits the STRING "true"/"false").
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.client_account_aum (
  apex_account_number text PRIMARY KEY,
  client_sf_id        text,
  household_sf_id     text,
  account_type        text,
  is_managed          boolean,
  account_status      text,
  account_aum         numeric(14,2),
  as_of               timestamptz,
  synced_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX client_account_aum_client_idx    ON mirror.client_account_aum (client_sf_id);
CREATE INDEX client_account_aum_household_idx ON mirror.client_account_aum (household_sf_id);

-- ---------------------------------------------------------------------------
-- 2. Grants — stated explicitly like the account migration even where default
--    privileges already cover them. ingest writes, app reads; NEVER DELETE for
--    anyone in mirror (ADR-7: staleness, not deletes). USAGE ON SCHEMA mirror
--    is already held by both roles from the Phase B migration; re-stating is
--    harmless and keeps this file self-describing.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA mirror TO ingest_rw;
GRANT USAGE ON SCHEMA mirror TO app_rw;
GRANT SELECT, INSERT, UPDATE ON mirror.client_account_aum TO ingest_rw;
GRANT SELECT ON mirror.client_account_aum TO app_rw;

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security — the mirror_roles_grants_rls idiom. Same GUC predicates
--    as the existing household/client/account policies; a missing GUC returns
--    NULL, so every app_rw policy fails closed. No owner (aoa) policy and no
--    DELETE policy for anyone — matches the Phase B/D mirror posture.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.client_account_aum ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.client_account_aum FORCE  ROW LEVEL SECURITY;

-- Ingestion writes the whole firm (the B/D-migration idiom).
CREATE POLICY client_account_aum_ingest_all ON mirror.client_account_aum
  FOR ALL TO ingest_rw USING (true) WITH CHECK (true);

-- Ops/Admin/HoA read all (firm view).
CREATE POLICY client_account_aum_ops_all ON mirror.client_account_aum
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );

-- Advisors/Client Service: accounts whose household is in their book. This
-- table has NO direct advisor column, so — like account_own_book rides through
-- mirror.client — this rides through mirror.household via household_sf_id. The
-- EXISTS reads mirror.household as app_rw, so household's OWN RLS policies
-- (scoped by lead_advisor_email) apply inside the subquery, which is exactly the
-- intended own-book scoping (and fails closed for null-advisor rows, ADR-5).
--
-- WIDTH NORMALIZATION: household_sf_id here is an 18-char Salesforce id, while
-- mirror.household.sf_id may be 15 or 18 char — the same mismatch households.ts
-- normalizes for deals. Compare on the shared 15-char prefix (left(...,15)) so
-- the join matches regardless of stored width; a naive `=` would miss rows.
CREATE POLICY client_account_aum_own_book ON mirror.client_account_aum
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
    AND EXISTS (
      SELECT 1
      FROM mirror.household h
      WHERE left(h.sf_id, 15) = left(client_account_aum.household_sf_id, 15)
    )
  );
