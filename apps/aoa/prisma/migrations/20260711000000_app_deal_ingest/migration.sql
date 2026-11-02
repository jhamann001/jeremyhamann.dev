-- Always-On Advice — app.deal ingest write path (TKT deals stage ingest).
--
-- The FIRST time `ingest_rw` writes into the APP-owned schema. Every prior
-- ingest endpoint writes `mirror.*` only; POST /api/ingest/deals keeps deal
-- STAGES current from CRM, and app.deal is app-owned (schema.prisma line
-- ~10 already anticipates "ingest endpoints running as ingest_rw"). This
-- migration hands `ingest_rw` exactly the least privilege that write needs.
--
-- Hand-authored (the mirror_roles_grants_rls / mirror_account_ingest idiom).
-- Additive-only (ADR-5): NO drops, NO renames. The existing `TO app_rw`
-- GUC-predicated app.deal policies (deal_read_all_roles / deal_insert_write_
-- roles / deal_update_write_roles) are UNAFFECTED and never evaluate for
-- ingest_rw; the owner policy (deal_owner_all) is likewise untouched.
--
-- No sequence grant: app.deal's PK is a cuid `String @default(cuid())` (Prisma,
-- schema.prisma) — generated app-side, not from a Postgres sequence. The
-- append-only audit grant ingest_rw needs for the same-tx per-run audit row was
-- already granted in 20260703180639_mirror_account_ingest (§6), so it is NOT
-- re-stated here.

-- ---------------------------------------------------------------------------
-- 1. Schema usage. ingest_rw currently has USAGE on `mirror` only
--    (20260629221205_mirror_roles_grants_rls §"grants"); it needs USAGE on
--    `app` to reach app.deal. USAGE alone exposes nothing — the table grant
--    below is what actually admits the DML.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA app TO ingest_rw;

-- ---------------------------------------------------------------------------
-- 2. Table DML. SELECT: the stage-merge reads the stored stage (+ timeline)
--    before deciding. INSERT/UPDATE: the idempotent upsert on sf_deal_id.
--    NEVER DELETE — deals are hard-undeletable for every non-owner role (the
--    app.deal D1 posture: restage to LOST, never delete).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON "app"."deal" TO ingest_rw;

-- ---------------------------------------------------------------------------
-- 3. RLS admission. FORCE ROW LEVEL SECURITY is on app.deal, so ingest_rw
--    needs a policy of its own — the `*_ingest_all` idiom (account_ingest_all,
--    household_ingest_all, …): FOR ALL TO ingest_rw USING (true) WITH CHECK
--    (true), referencing NO GUC (ingest_rw sets none — withIngestScope is
--    GUC-less by design). The app_rw policies stay role-gated and fail closed
--    on a missing GUC exactly as before.
-- ---------------------------------------------------------------------------
CREATE POLICY deal_ingest_all ON "app"."deal"
  FOR ALL TO ingest_rw
  USING (true)
  WITH CHECK (true);
