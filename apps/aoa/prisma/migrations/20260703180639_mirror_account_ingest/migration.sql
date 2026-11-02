-- Always-On Advice — Phase D slice 1 (D-1, ticket): mirror.account +
-- mirror.account_holder, contract-gap columns on mirror.client, the two ADR-5
-- constraint relaxations, ingest_rw/app_rw grants, the ingest_rw append-only
-- audit grant, and FORCE RLS + policies on both new tables.
--
-- This migration is hand-authored (Prisma scaffolded the empty folder) — the
-- `mirror_roles_grants_rls` idiom: NO Prisma models for `mirror` (ADR-9).
-- Additive-only (ADR-5) with exactly two called-out constraint relaxations
-- (three NOT-NULL relaxation statements — see the relaxations block below).
-- Source of truth: docs/planning/phase-d/tdd.md §3.

-- ---------------------------------------------------------------------------
-- 1. mirror.account — custodial accounts (TDD §3 DDL).
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.account (
  custodian_account_id text PRIMARY KEY,
  custodian            text NOT NULL CHECK (custodian IN ('APEX', 'DRIVEWEALTH')),
  account_type         text,
  status               text NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at            date,
  closed_at            date,
  synced_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_status_idx ON mirror.account (status);

-- ---------------------------------------------------------------------------
-- 2. mirror.account_holder — one row per (account, holder); joint accounts
--    have two (ADR-4).
--    cedar_ridge_user_id has NO FK to mirror.client: the linkage key is
--    client.cedar_ridge_user_id (not its PK), source systems can briefly
--    disagree, and mirror tolerates orphans by design (mirror reflects source).
-- ---------------------------------------------------------------------------
CREATE TABLE mirror.account_holder (
  custodian_account_id text NOT NULL REFERENCES mirror.account (custodian_account_id),
  cedar_ridge_user_id    text NOT NULL,
  synced_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (custodian_account_id, cedar_ridge_user_id)
);
CREATE INDEX account_holder_user_idx ON mirror.account_holder (cedar_ridge_user_id);

-- ---------------------------------------------------------------------------
-- 3. Contract-gap columns on mirror.client (TDD §3 delta table):
--    cedar_ridge_user_id is the account-holder join key; stage carries the
--    source stage verbatim.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.client ADD COLUMN cedar_ridge_user_id text;
CREATE INDEX client_cedar_ridge_user_idx ON mirror.client (cedar_ridge_user_id);
ALTER TABLE mirror.client ADD COLUMN stage text;

-- ---------------------------------------------------------------------------
-- 4. The two ADR-5 relaxations — three statements, the ONLY non-purely-additive
--    lines in this file. The ingest contract carries nullable household_sf_id
--    and lead_advisor_email; a null lead_advisor_email row is visible to
--    Ops/Admin/HoA only (RLS fails closed — ADR-5). Nothing else is altered;
--    nothing is dropped or renamed; existing FKs/indexes untouched.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.client ALTER COLUMN household_id DROP NOT NULL;
ALTER TABLE mirror.client ALTER COLUMN lead_advisor_email DROP NOT NULL;
ALTER TABLE mirror.household ALTER COLUMN lead_advisor_email DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Grants — stated explicitly like the B migration even where default
--    privileges already cover them. ingest writes, app reads; NEVER DELETE
--    for anyone in mirror (ADR-7: staleness, not deletes).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON mirror.account, mirror.account_holder TO ingest_rw;
GRANT SELECT ON mirror.account, mirror.account_holder TO app_rw;

-- ---------------------------------------------------------------------------
-- 6. ingest_rw append-only audit grant (ADR-8): the per-run audit row commits
--    in the SAME ingest_rw transaction, so ingest_rw needs the append-only
--    audit posture app_rw has — INSERT+SELECT, never UPDATE/DELETE. This is
--    the ONLY grant ingest_rw gets outside mirror.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA audit TO ingest_rw;
GRANT SELECT, INSERT ON audit."AuditLog" TO ingest_rw;
GRANT USAGE, SELECT ON SEQUENCE audit."AuditLog_id_seq" TO ingest_rw;

-- ---------------------------------------------------------------------------
-- 7. Row-Level Security — the mirror_roles_grants_rls idiom. GUC predicates
--    identical to the existing household/client policies:
--    current_setting('app.user_role', true) / current_setting('app.user_email',
--    true); a missing GUC returns NULL, so every policy fails closed.
--    NOTE: no owner (aoa) policy and no DELETE policy for anyone — this
--    matches the Phase B mirror posture (the seed writes mirror.* as
--    ingest_rw, unlike the app.transfer owner-policy idiom which exists for
--    owner-run seeds).
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.account        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.account        FORCE  ROW LEVEL SECURITY;
ALTER TABLE mirror.account_holder ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.account_holder FORCE  ROW LEVEL SECURITY;

-- Ingestion writes the whole firm (the B-migration idiom).
CREATE POLICY account_ingest_all        ON mirror.account        FOR ALL TO ingest_rw USING (true) WITH CHECK (true);
CREATE POLICY account_holder_ingest_all ON mirror.account_holder FOR ALL TO ingest_rw USING (true) WITH CHECK (true);

-- Ops/Admin/HoA read all (firm view).
CREATE POLICY account_ops_all ON mirror.account FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
);
CREATE POLICY account_holder_ops_all ON mirror.account_holder FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS', 'HEAD_OF_ADVISORY')
);

-- Advisors/Client Service: accounts held by a client in their book. The EXISTS
-- rides through mirror.client, whose own RLS policies apply inside the subquery
-- — which is exactly the intended scoping (and fails closed while ingested rows
-- have null lead_advisor_email, ADR-5).
CREATE POLICY account_own_book ON mirror.account FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
  AND EXISTS (
    SELECT 1
    FROM mirror.account_holder ah
    JOIN mirror.client c ON c.cedar_ridge_user_id = ah.cedar_ridge_user_id
    WHERE ah.custodian_account_id = account.custodian_account_id
  )
);

-- account_holder needs its own SELECT policies (the TDD §3 prereq note made
-- real): account_own_book's EXISTS touches mirror.account_holder as app_rw,
-- so without holder-table policies the subquery reads zero holder rows and
-- returns nothing. Same role predicate; the client join scopes holder rows to
-- the advisor's own book.
CREATE POLICY account_holder_own_book ON mirror.account_holder FOR SELECT TO app_rw USING (
  current_setting('app.user_role', true) IN ('ADVISOR', 'CLIENT_SERVICE')
  AND EXISTS (
    SELECT 1
    FROM mirror.client c
    WHERE c.cedar_ridge_user_id = account_holder.cedar_ridge_user_id
  )
);
