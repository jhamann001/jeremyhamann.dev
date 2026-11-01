-- Up Migration

-- Firm-of-record household tag for trade requests, sourced from
-- Meridian's `active_accounts.json` (`household_id`, `household_name`).
-- Captured at submit time from the resolved selection: when every
-- submitted account ULID belongs to one and the same firm household,
-- the (id, name) pair is persisted; otherwise both columns stay NULL.
-- NULL is the explicit "ad-hoc household" / silent-fallback signal —
-- downstream analytics can use it to identify untagged trades.
--
-- See `docs/plans/2026-q2-trade-request-householding.md` §6 Step 8 and
-- Decision logs #2 and #5.
ALTER TABLE trade_requests
    ADD COLUMN household_id BIGINT NULL,
    ADD COLUMN household_name TEXT NULL;

-- Both columns must be set together or both NULL. The route enforces
-- this at the application layer too, but this catch-all guards against
-- ad-hoc DB writes.
ALTER TABLE trade_requests
    ADD CONSTRAINT trade_requests_household_id_name_paired
        CHECK ((household_id IS NULL) = (household_name IS NULL));

-- Down Migration

ALTER TABLE trade_requests DROP CONSTRAINT IF EXISTS trade_requests_household_id_name_paired;
ALTER TABLE trade_requests DROP COLUMN IF EXISTS household_name;
ALTER TABLE trade_requests DROP COLUMN IF EXISTS household_id;
