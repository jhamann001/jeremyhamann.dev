-- Always-On Advice — asset-mapping person link, Phase 2 slice P2.5
-- (account-grain person attribution: mirror.acat_asset_map_account_link).
--
-- P2.0–P2.3 built the FOLDER link (mirror.acat_asset_map_link): one durable
-- source_folder_id → one client. That is too coarse for person attribution — a
-- mapping "household" folder is a document bundle that routinely mixes owners
-- (his IRA, her IRA, a joint taxable, a family trust) and the downstream
-- app.transfer join is ACCOUNT-grain. P2.5 adds a per-account link that resolves
-- each account's account_holder → the owning PERSON(s), multi-owner native,
-- BENEATH the folder link (it hangs off source_folder_id). The folder link is
-- unchanged and remains the coarse parent anchor. See
-- docs/planning/asset-mapping/phase2-person-link-design.md §8 (§8.3 key, §8.4
-- store, §8.5 pipeline, §8.6 review + RLS).
--
-- Hand-authored raw SQL, following the mirror idiom EXACTLY as
-- prisma/migrations/20260719000000_asset_map_link and
-- 20260720000000_asset_map_link_ops_write (ADR-9: NO Prisma model for `mirror` —
-- this table is NOT in the Prisma `schemas` list). Additive-only (ADR-5): one new
-- table, its indexes, grants, and FORCE RLS + policies — nothing altered/dropped.
-- NEVER DELETE for any role (ADR-7: staleness, not deletes) — a superseded/unchosen
-- owner is expressed via match_status ('REJECTED'/'UNMATCHED'), never a row delete.
--
-- ORDERING: timestamp 20260722000000 sorts AFTER the P2.3 write migration
-- 20260720000000 (this table's ops-write posture is a documented EXTENSION of the
-- P2.3 hybrid it builds on).
--
-- ============================================================================
-- THE PIVOTAL DECISIONS (design §8.3/§8.4, blueprint §3.1 — flagged in the PR)
-- ============================================================================
--
-- (1) DURABLE, FOLDER-SCOPED ACCOUNT KEY (D-h safe default).
--     The account key is (source_folder_id, custodian, account_number). The raw-
--     vs-masked question for account_number is unresolved until real ingested rows
--     are inspected; folder-scoped is a STRICT SUPERSET — correct whether numbers
--     are globally-unique-raw OR last-4-masked — so it is never wrong to ship. Drop
--     source_folder_id from the key ONLY once raw/global-uniqueness is confirmed
--     (D-h, deferred). source_folder_id also hangs the row beneath the folder link.
--
-- (2) ENTITY NULL-OWNER via UNIQUE ... NULLS NOT DISTINCT (PG16), NOT a PRIMARY KEY
--     and NOT an empty-string sentinel.
--     §8.4's illustrative PRIMARY KEY (source_folder_id, custodian, account_number,
--     cedar_ridge_user_id) cannot be a literal PRIMARY KEY: cedar_ridge_user_id is NULL
--     for an entity (trust/LLC/estate) row and PK columns are NOT NULL. Instead we
--     declare a UNIQUE ... NULLS NOT DISTINCT index over those four columns as the
--     natural key and NO PRIMARY KEY. PG16 treats the multiple NULLs as EQUAL for
--     uniqueness, so a given account holds at most ONE entity (no-person) row — the
--     collision guard a plain-NULL index would lose. ON CONFLICT (source_folder_id,
--     custodian, account_number, cedar_ridge_user_id) infers this index for both the
--     machine and human upserts. Rejected alternative — an empty-string sentinel
--     cedar_ridge_user_id = '' — would pollute the person-key column with a non-null
--     non-real value that every downstream join to mirror.client.cedar_ridge_user_id
--     must special-case; it diverges from §8.4's NULL contract. This is a DELIBERATE,
--     documented divergence from the mirror "always a PK" idiom, forced by the
--     nullable owner. Requires Postgres 16 (NULLS NOT DISTINCT is PG15+).

-- ---------------------------------------------------------------------------
-- 1. mirror.acat_asset_map_account_link — one row per (durable account, person).
--    Ownership is 0..N persons: a JTWROS account → two rows (both spouses); an
--    individual → one; a trust/LLC/estate → one row with is_entity=true,
--    cedar_ridge_user_id=NULL, ownership_role='ENTITY' (attributed to the household
--    but to no person — the correct answer, not a forced mis-link).
--
--    match_status tiers mirror the folder link (design §8.4), verbatim:
--      UNMATCHED    — no owner resolved (or below the low band); the machine default.
--      AUTO_LINKED  — high-confidence machine owner link; ids written, ops-reversible.
--      NEEDS_REVIEW — mid band OR entity OR a holder not in the household; queued.
--      CONFIRMED    — a human bound the owner set (confirmed_by/at set).
--      REJECTED     — a human rejected the owner (soft-remove, never re-queued).
--    ownership_role: P2.5 derives only PRIMARY | JOINT | ENTITY; CUSTODIAN /
--    BENEFICIARY are valid CHECK values for forward-compat (§8.4) but are NOT
--    produced by P2.5's matcher or actions. confidence is the last computed score
--    (numeric(4,3): 0.000–1.000), NULL until scored (never 0).
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.acat_asset_map_account_link (
  source_folder_id  text NOT NULL,      -- FK-in-spirit to the folder link (§4.1); parent pointer + key scope
  custodian         text NOT NULL,      -- } the durable account key (§8.3, folder-scoped D-h safe default)
  account_number    text NOT NULL,      -- }
  cedar_ridge_user_id text,               -- resolved person; NULL for an entity owner (§8.4)
  client_sf_id      text,               -- resolved AOA client; NULL for an entity owner
  ownership_role    text NOT NULL DEFAULT 'PRIMARY'
                    CHECK (ownership_role IN ('PRIMARY','JOINT','ENTITY','CUSTODIAN','BENEFICIARY')),
  is_entity         boolean NOT NULL DEFAULT false,   -- trust/LLC/estate → no person
  match_status      text NOT NULL DEFAULT 'UNMATCHED' -- UNMATCHED|AUTO_LINKED|NEEDS_REVIEW|CONFIRMED|REJECTED
                    CHECK (match_status IN ('UNMATCHED','AUTO_LINKED','NEEDS_REVIEW','CONFIRMED','REJECTED')),
  confidence        numeric(4,3),        -- last computed score 0.000–1.000; NULL until scored (never 0)
  confirmed_by      text,               -- ops email; NULL for machine rows
  confirmed_at      timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

-- Natural key: folder-scoped account × person. NULLS NOT DISTINCT (PG16) makes the
-- single entity (NULL-person) row unique per account, and is the ON CONFLICT
-- inference target for BOTH writers (the machine reconcile pass + the human confirm).
CREATE UNIQUE INDEX acat_asset_map_account_link_key
  ON mirror.acat_asset_map_account_link
  (source_folder_id, custodian, account_number, cedar_ridge_user_id)
  NULLS NOT DISTINCT;

-- Read paths (design §8.4): by folder (review expand), by person (downstream join),
-- by status (queue sweep).
CREATE INDEX acat_asset_map_account_link_folder_idx    ON mirror.acat_asset_map_account_link (source_folder_id);
CREATE INDEX acat_asset_map_account_link_cedar_ridge_idx ON mirror.acat_asset_map_account_link (cedar_ridge_user_id);
CREATE INDEX acat_asset_map_account_link_status_idx    ON mirror.acat_asset_map_account_link (match_status);

-- ---------------------------------------------------------------------------
-- 2. Grants — mirror USAGE + the P2.5 extension of the P2.3 hybrid.
--
--    DOCUMENTED ARCHITECTURE DECISION (flagged for owner review in the PR body):
--    P2.3's folder-link human write is UPDATE-only because it only ever mutates an
--    ALREADY-QUEUED row (20260720000000). P2.5's account write is MULTI-OWNER: a
--    reviewer can confirm an owner the matcher did NOT pre-queue (a joint owner the
--    fuzzy pass missed, or a free-searched member), so the human path must INSERT
--    owner rows as well as UPDATE them. Hence app_rw gets INSERT + UPDATE here —
--    the natural extension of the P2.3 hybrid, not a new pattern. Still NO DELETE
--    for anyone (ADR-7): an unchosen queued owner is soft-rejected via match_status,
--    never deleted.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA mirror TO ingest_rw;
GRANT USAGE ON SCHEMA mirror TO app_rw;

-- Machine writer (reconcile pass, withIngestScope): full write, mirror idiom.
GRANT SELECT, INSERT, UPDATE ON mirror.acat_asset_map_account_link TO ingest_rw;

-- Human writer (ops confirm, withUserScope): READ + INSERT + UPDATE. NO DELETE (ADR-7).
GRANT SELECT ON mirror.acat_asset_map_account_link TO app_rw;
GRANT INSERT, UPDATE ON mirror.acat_asset_map_account_link TO app_rw;

-- ---------------------------------------------------------------------------
-- 3. Row-Level Security — the P2.0/P2.3 idiom, extended to INSERT. ENABLE + FORCE,
--    four policies. A missing GUC → NULL → fails closed (advisor / client-service /
--    VIEWER match no policy → 0 rows). NO FOR DELETE policy for anyone (ADR-7).
--    No own-book policy (design §6 — book membership is being decided; P2.4 territory).
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.acat_asset_map_account_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.acat_asset_map_account_link FORCE  ROW LEVEL SECURITY;

-- (a) Ingest writes the whole firm — unconditional, GUC-less (matches every *_ingest_all).
CREATE POLICY acat_asset_map_account_link_ingest_all ON mirror.acat_asset_map_account_link
  FOR ALL TO ingest_rw USING (true) WITH CHECK (true);

-- (b) Ops/Admin/HoA read all (firm view). No own-book policy (design §6).
CREATE POLICY acat_asset_map_account_link_ops_all ON mirror.acat_asset_map_account_link
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
  );

-- (c) Ops UPDATE (same GUC predicate as P2.3's acat_asset_map_link_ops_update).
CREATE POLICY acat_asset_map_account_link_ops_update ON mirror.acat_asset_map_account_link
  FOR UPDATE TO app_rw
  USING      (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY'))
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY'));

-- (d) Ops INSERT (the P2.5 extension — a reviewer materializes a chosen owner row
--     the matcher didn't queue).
CREATE POLICY acat_asset_map_account_link_ops_insert ON mirror.acat_asset_map_account_link
  FOR INSERT TO app_rw
  WITH CHECK (current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY'));
