-- Always-On Advice — ticket AUM parity.
--
-- Two additive-in-spirit schema changes so the per-account AUM feed can tie to
-- Apex's report to the penny AND carry the firm's 4 corporate accounts (which
-- have NO Apex account number):
--   1. mirror.household gains a `household_kind` flag (NOT NULL DEFAULT 'CLIENT').
--   2. mirror.client_account_aum is RE-KEYED from apex_account_number (7-char,
--      NULL for the corporate accounts) to custodian_account_id (a ULID that is
--      ALWAYS present in the new source, Warehouse card 6601). apex_account_number
--      stays as a nullable, indexed column so the number-based readers
--      (apexAccountByNumber → the Performance-page RLS gate) keep working
--      unchanged for client accounts, which still carry their number.
--
-- Hand-authored (the mirror_roles_grants_rls idiom — ADR-9: NO Prisma models for
-- `mirror`). Grants are unchanged: a table-level GRANT covers the new column, and
-- ingest already holds SELECT/INSERT/UPDATE on the table. RLS is unchanged: the
-- new key does not change any policy predicate (visibility still rides
-- household_sf_id → mirror.household). The firm household itself is APP-side
-- (synthetic, lib/data/firm-household.ts), so nothing is inserted here for it.

-- ---------------------------------------------------------------------------
-- 1. mirror.household.household_kind — CLIENT for every real (CRM-fed)
--    household; the synthetic "Cedar Ridge Wealth" firm household reports FIRM
--    from the app layer. Additive-only (ADR-5): one new NOT NULL column with a
--    safe default so the backfill is instantaneous and the ingest upsert needs
--    no change (the column defaults on every existing and future feed row).
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.household
  ADD COLUMN household_kind text NOT NULL DEFAULT 'CLIENT';

-- ---------------------------------------------------------------------------
-- 2. Re-key mirror.client_account_aum: apex_account_number → custodian_account_id.
--
--    The old key (apex_account_number) is NULL for the 4 corporate accounts, so
--    it can no longer be the primary key. custodian_account_id (ULID) is always
--    present in card 6601 and is the natural per-account key.
--
--    This table is a DAILY FULL-SNAPSHOT mirror: the cron re-pulls EVERY account
--    each run and upserts it, so the table is fully reconstructible from the next
--    pull. The old feed (card 6436) carried no ULID, so existing rows have no
--    custodian_account_id to preserve — we TRUNCATE (a one-time schema-transition
--    reset, NOT an ingest-path delete) and let the next card-6601 pull repopulate
--    with the ULID key. A no-op on an empty table.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.client_account_aum
  ADD COLUMN custodian_account_id text;

TRUNCATE mirror.client_account_aum;

-- Drop the old PK; the implicit NOT NULL on apex_account_number does NOT drop
-- with the constraint, so relax it explicitly (corporate accounts have none).
ALTER TABLE mirror.client_account_aum
  DROP CONSTRAINT client_account_aum_pkey;
ALTER TABLE mirror.client_account_aum
  ALTER COLUMN apex_account_number DROP NOT NULL;

-- The ULID is the new key: NOT NULL + PRIMARY KEY.
ALTER TABLE mirror.client_account_aum
  ALTER COLUMN custodian_account_id SET NOT NULL;
ALTER TABLE mirror.client_account_aum
  ADD CONSTRAINT client_account_aum_pkey PRIMARY KEY (custodian_account_id);

-- apex_account_number was the PK (implicitly indexed); it now needs its own
-- index because apexAccountByNumber (the Performance-report per-account RLS
-- gate) looks rows up by it. Client accounts always carry a number; corporate
-- accounts store NULL (never matched by a number lookup — the intended behavior).
CREATE INDEX client_account_aum_apex_idx
  ON mirror.client_account_aum (apex_account_number);
