-- Always-On Advice — asset-mapping person link, Phase 2 slice P2.0
-- (mirror.acat_asset_map_link).
--
-- Phase 1 mirrored the statement-pipeline household tree UNLINKED into
-- mirror.acat_asset_map_* (20260718000000). This slice adds the DURABLE link
-- STORE that binds a mapping household to a real AOA client/household record.
-- See docs/planning/asset-mapping/phase2-person-link-design.md (P2.0, §4.1).
--
-- THE KEY DECISION (design §1 / §4.1, D-a): the link is keyed on
-- `source_folder_id` (the Google Drive folder id — a column on
-- mirror.acat_asset_map_household, 20260718000000/migration.sql:40), NOT the
-- per-version household `id`. Re-scans are append-only / new-UUID-per-version,
-- so the per-version UUID changes on every document drop; the ONLY identity
-- stable across all versions of a household is `source_folder_id`. Keying the
-- link on the folder id makes one human confirmation SURVIVE every future
-- version — a link written on the UUID row would be stranded when the next scan
-- mints a fresh household row and the new version would read back NULL.
--
-- NO MATCHING LOGIC HERE (design §7, P2.0). This is the store + RLS only. The
-- resolved-link columns (client_sf_id, cedar_ridge_user_id, household_sf_id) and
-- the confirmation columns stay NULL until the later slices populate them:
-- normalization/candidate-generation (P2.1), reconcile/scoring (P2.2), and the
-- ops review UI + confirm write-back (P2.3).
--
-- Hand-authored, following the mirror idiom EXACTLY as
-- prisma/migrations/20260718000000_asset_map_mirror/migration.sql and
-- …_20260714000000_mirror_client_account_aum (ADR-9: NO Prisma model for
-- `mirror` — this table is NOT in the Prisma `schemas` list). Additive-only
-- (ADR-5): one new table, its index, grants, and FORCE RLS + policies — nothing
-- altered/dropped. NEVER DELETE for any role (ADR-7: staleness, not deletes) —
-- a superseded/withdrawn link is expressed via match_status ('REJECTED'), never
-- a row delete, so one folder's link history is never destroyed.

-- ---------------------------------------------------------------------------
-- 1. mirror.acat_asset_map_link — one row per DURABLE mapping household
--    (`source_folder_id`). This is the SOURCE OF TRUTH for the person link; the
--    Phase-1 client_sf_id / cedar_ridge_user_id columns on the household UUID row
--    are kept only for a later read-convenience carry-forward (design §4.1),
--    NOT the record.
--
--    match_status tiers (design §4.1 / §4.2), verbatim:
--      UNMATCHED     — no candidate (or below the low band); queue with no
--                      suggestion. The DEFAULT for a freshly-seen folder.
--      AUTO_LINKED   — high-confidence machine link; ids written, still audited
--                      and reversible by ops.
--      NEEDS_REVIEW  — mid band; candidates scored, ids left NULL, queued for a
--                      human.
--      CONFIRMED     — a human bound the link (confirmed_by / confirmed_at set).
--      REJECTED      — a human rejected all candidates; no link, not re-queued.
--    A human decision (CONFIRMED / REJECTED) is NEVER downgraded by a later
--    machine pass — re-scoring only refreshes `confidence` for display (design
--    §4.2). Enforcing that rule is the reconcile step's job (P2.2), not a DB
--    constraint here.
--
--    The resolved-link + confirmation columns are all nullable: a row exists
--    (queued) long before anyone/anything resolves it. `confidence` is the last
--    computed score (numeric(4,3): 0.000–1.000), NULL until scored.
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.acat_asset_map_link (
  source_folder_id  text PRIMARY KEY,             -- durable across all re-scans (design §4.1)
  client_sf_id      text,                          -- resolved AOA client — NULL until matched
  cedar_ridge_user_id text,                          -- resolved person key   — NULL until matched
  household_sf_id   text,                          -- resolved AOA household — drives own-book RLS later
  match_status      text NOT NULL DEFAULT 'UNMATCHED',
  confidence        numeric(4,3),                  -- last computed score 0.000–1.000; NULL until scored
  confirmed_by      text,                          -- ops user email; NULL for machine auto-links
  confirmed_at      timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now()
);
-- The review queue (P2.3) sweeps by match_status (NEEDS_REVIEW / UNMATCHED /
-- AUTO_LINKED filters), so index it now — cheap and dormant until then.
CREATE INDEX acat_asset_map_link_status_idx ON mirror.acat_asset_map_link (match_status);

-- ---------------------------------------------------------------------------
-- 2. Grants — stated explicitly like the Phase-1 asset_map_mirror /
--    client_account_aum migrations even though the schema-wide
--    ALTER DEFAULT PRIVILEGES from 20260629221205_mirror_roles_grants_rls
--    already covers new mirror tables (app_rw SELECT; ingest_rw
--    SELECT/INSERT/UPDATE). Re-stating keeps this file self-describing.
--    ingest_rw WRITES, app_rw READS; NEVER DELETE for anyone in mirror (ADR-7).
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA mirror TO ingest_rw;
GRANT USAGE ON SCHEMA mirror TO app_rw;
GRANT SELECT, INSERT, UPDATE ON mirror.acat_asset_map_link TO ingest_rw;
GRANT SELECT ON mirror.acat_asset_map_link TO app_rw;

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security — the asset_map_mirror idiom. ENABLE + FORCE, two
--    policy classes:
--
--    (a) Ingest writes the whole firm — unconditional, GUC-less:
--        FOR ALL TO ingest_rw USING (true) WITH CHECK (true). Both writers of
--        this table run under ingest_rw (design §4.1): the reconcile pass
--        (P2.2) and the ops confirm/reject write-back delegated to the ingest
--        seam (P2.3). Matches every existing *_ingest_all policy — why
--        withIngestScope sets no GUCs.
--    (b) Ops/Admin/HoA read all (firm view): a missing GUC → NULL → fails
--        closed, so advisors/client-service (no matching policy) see 0 rows.
--
--    NO *_own_book POLICY (design §6). An advisor has no book on an UNCONFIRMED
--    row — book membership is exactly the thing being decided in the review
--    queue — and the queue exposes free-text names / possibly-raw account
--    numbers firm-wide before any attribution exists, so it is ADMIN/OPERATIONS/
--    HEAD_OF_ADVISORY-only. Own-book scoping on the linked acat_asset_map_*
--    tables (riding this link → mirror.household) is a separate additive
--    follow-on once links exist (P2.4), not on this link table itself.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.acat_asset_map_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_link FORCE  ROW LEVEL SECURITY;

-- Ingestion writes the whole firm (the B/D-migration idiom).
CREATE POLICY acat_asset_map_link_ingest_all ON mirror.acat_asset_map_link
  FOR ALL TO ingest_rw USING (true) WITH CHECK (true);

-- Ops/Admin/HoA read all (firm view). No own-book policy (see above).
CREATE POLICY acat_asset_map_link_ops_all ON mirror.acat_asset_map_link
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );
