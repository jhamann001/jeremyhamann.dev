-- Always-On Advice — asset-mapping ingest, Phase 1 (mirror.acat_asset_map_*).
--
-- The app PULLS the household-keyed asset-mapping tree (household → accounts[]
-- → positions[]) from the statement-pipeline's OIDC-gated bulk endpoint
-- (GET /api/v1/households) on a ~30-min business-hours cron
-- (app/api/cron/asset-map) and mirrors it into these three tables. See
-- docs/planning/asset-mapping/phase1-ingest-design.md for the full design.
--
-- Phase 1 is UNLINKED: rows are keyed on the mapping app's own UUIDs and carry
-- EMPTY, nullable Phase-2 person-link columns (client_sf_id, cedar_ridge_user_id)
-- on the household table. Person resolution is explicitly OUT OF SCOPE here
-- (Phase 2) — which is also why there is NO own-book RLS policy yet (see §3).
--
-- Hand-authored, following the mirror idiom EXACTLY as
-- prisma/migrations/20260714000000_mirror_client_account_aum/migration.sql and
-- …_20260703180639_mirror_account_ingest (ADR-9: NO Prisma models for `mirror`,
-- these tables are NOT in the Prisma `schemas` list). Additive-only (ADR-5):
-- three new tables, their indexes, grants, and FORCE RLS + policies — nothing
-- altered/dropped. NEVER DELETE for any role (ADR-7: staleness, not deletes) —
-- supersession is carried via the source's `superseded_by`, never a delete.

-- ---------------------------------------------------------------------------
-- 1. mirror.acat_asset_map_household — one row per mapping-app household UUID.
--    `id` is the ONLY stable key (client_name is free-text, often two people,
--    NOT a CRM key). `superseded_by` carries the source's supersession pointer
--    verbatim; "live" = `superseded_by IS NULL`. The count/rollup tallies
--    (acat/liquidate/unsupported/review/transfer + docs) are stored as one
--    `status_tallies` jsonb bag rather than brittle per-count columns — the
--    mirror reflects the source; promote a sub-field to a column later if a
--    consumer needs to filter on it (additive, ADR-5). client_sf_id /
--    cedar_ridge_user_id are the Phase-2 person-link columns — NULL in Phase 1.
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.acat_asset_map_household (
  id                text PRIMARY KEY,
  client_name       text,
  run_number        integer,
  processed_at      timestamptz,
  source_created_at timestamptz,
  superseded_by     text,
  source_folder_id  text,
  total_value       numeric(14,2),
  total_accounts    integer,
  total_positions   integer,
  status_tallies    jsonb,
  client_sf_id      text,       -- Phase-2 person link — NULL in Phase 1
  cedar_ridge_user_id text,       -- Phase-2 person link — NULL in Phase 1
  synced_at         timestamptz NOT NULL DEFAULT now()
);
-- (superseded_by) sweeps live-vs-superseded; the partial index makes the
-- "live set" query (superseded_by IS NULL) cheap. (client_sf_id) /
-- (cedar_ridge_user_id) are dormant until Phase 2 but cheap to add now.
CREATE INDEX acat_asset_map_household_superseded_idx ON mirror.acat_asset_map_household (superseded_by);
CREATE INDEX acat_asset_map_household_live_idx       ON mirror.acat_asset_map_household (id) WHERE superseded_by IS NULL;
CREATE INDEX acat_asset_map_household_client_idx     ON mirror.acat_asset_map_household (client_sf_id);
CREATE INDEX acat_asset_map_household_cedar_ridge_idx  ON mirror.acat_asset_map_household (cedar_ridge_user_id);

-- ---------------------------------------------------------------------------
-- 2. mirror.acat_asset_map_account — one row per account UUID, FK to household.
--    ON DELETE CASCADE exists ONLY for a hypothetical true source hard-delete
--    (which normal supersession never does — it re-points superseded_by). The
--    nested `custodian_intel` object ({ dtcc_number, contact, matched_name,
--    acat_timeline }) and `validation_issues` (string[]) are stored whole as
--    jsonb.
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.acat_asset_map_account (
  id                     text PRIMARY KEY,
  household_id           text NOT NULL REFERENCES mirror.acat_asset_map_household(id) ON DELETE CASCADE,
  custodian              text,
  account_type           text,
  account_type_raw       text,
  account_type_other     text,
  account_type_override  text,
  account_number         text,
  account_holder         text,
  statement_date         date,
  cash_balance           numeric(14,2),
  total_value            numeric(14,2),
  is_rollover            boolean,
  is_inherited           boolean,
  inherited_notes        text,
  apex_restriction       text,
  cost_basis_status      text,
  validation_status      text,
  validation_issues      jsonb,
  statement_age_days     integer,
  is_stale               boolean,
  is_deleted             boolean,
  custodian_intel        jsonb,
  synced_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX acat_asset_map_account_household_idx ON mirror.acat_asset_map_account (household_id);

-- ---------------------------------------------------------------------------
-- 3. mirror.acat_asset_map_position — one row per position UUID, FK to account.
--    `effective_status` is the resolved override-or-machine routing value (the
--    field consumers read). `notion_check` and `lots` are stored whole as jsonb
--    (`lots` is present only when the cost-basis granularity supports it, NULL
--    otherwise).
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.acat_asset_map_position (
  id                          text PRIMARY KEY,
  account_id                  text NOT NULL REFERENCES mirror.acat_asset_map_account(id) ON DELETE CASCADE,
  symbol                      text,
  description                 text,
  quantity                    numeric(20,6),
  market_value                numeric(14,2),
  asset_type                  text,
  transfer_eligible           text,
  classification_source       text,
  transfer_notes              text,
  effective_notes             text,
  notion_check                jsonb,
  cost_basis                  numeric(14,2),
  cost_basis_granularity      text,
  lots                        jsonb,
  original_transfer_eligible  text,
  override_status             text,
  override_notes              text,
  overridden_by               text,
  overridden_at               timestamptz,
  transferring                boolean,
  transferring_by             text,
  transferring_at             timestamptz,
  effective_status            text,
  synced_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX acat_asset_map_position_account_idx ON mirror.acat_asset_map_position (account_id);
CREATE INDEX acat_asset_map_position_effective_idx ON mirror.acat_asset_map_position (effective_status);

-- ---------------------------------------------------------------------------
-- 4. Grants — stated explicitly like the client_account_aum migration even
--    where default privileges already cover them. ingest_rw WRITES, app_rw
--    READS; NEVER DELETE for anyone in mirror (ADR-7). USAGE ON SCHEMA mirror
--    is already held by both roles from the Phase B migration; re-stating is
--    harmless and keeps this file self-describing.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA mirror TO ingest_rw;
GRANT USAGE ON SCHEMA mirror TO app_rw;
GRANT SELECT, INSERT, UPDATE ON mirror.acat_asset_map_household TO ingest_rw;
GRANT SELECT, INSERT, UPDATE ON mirror.acat_asset_map_account   TO ingest_rw;
GRANT SELECT, INSERT, UPDATE ON mirror.acat_asset_map_position  TO ingest_rw;
GRANT SELECT ON mirror.acat_asset_map_household TO app_rw;
GRANT SELECT ON mirror.acat_asset_map_account   TO app_rw;
GRANT SELECT ON mirror.acat_asset_map_position  TO app_rw;

-- ---------------------------------------------------------------------------
-- 5. Row-Level Security — the mirror_roles_grants_rls idiom. ENABLE + FORCE on
--    all three tables. Two policy classes per table:
--
--    (a) Ingest writes the whole firm — unconditional, GUC-less:
--        FOR ALL TO ingest_rw USING (true) WITH CHECK (true). Matches every
--        existing *_ingest_all policy and is why withIngestScope sets no GUCs.
--    (b) Ops/Admin/HoA read all (firm view): a missing GUC → NULL → fails
--        closed, so advisors/client-service with no matching policy see 0 rows.
--
--    PHASE-1 IS OPS/ADMIN-ONLY BY DESIGN — there is deliberately NO *_own_book
--    policy. Every existing own-book policy rides a person/household key
--    (household.lead_advisor_email, client_account_aum via household_sf_id).
--    These tables have NEITHER — the only person-ish field is free-text
--    client_name, which is not a join key. There is nothing to scope an
--    advisor's book by until Phase 2 person-linking populates client_sf_id /
--    cedar_ridge_user_id. When Phase 2 lands those columns, an own-book policy
--    that rides them (the client_account_aum_own_book idiom) is an additive
--    follow-on migration.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.acat_asset_map_household ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_household FORCE  ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_account   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_account   FORCE  ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_position  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_position  FORCE  ROW LEVEL SECURITY;

-- Ingestion writes the whole firm (the B/D-migration idiom).
CREATE POLICY acat_asset_map_household_ingest_all ON mirror.acat_asset_map_household
  FOR ALL TO ingest_rw USING (true) WITH CHECK (true);
CREATE POLICY acat_asset_map_account_ingest_all ON mirror.acat_asset_map_account
  FOR ALL TO ingest_rw USING (true) WITH CHECK (true);
CREATE POLICY acat_asset_map_position_ingest_all ON mirror.acat_asset_map_position
  FOR ALL TO ingest_rw USING (true) WITH CHECK (true);

-- Ops/Admin/HoA read all (firm view). No own-book policy in Phase 1 (see above).
CREATE POLICY acat_asset_map_household_ops_all ON mirror.acat_asset_map_household
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );
CREATE POLICY acat_asset_map_account_ops_all ON mirror.acat_asset_map_account
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );
CREATE POLICY acat_asset_map_position_ops_all ON mirror.acat_asset_map_position
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );
