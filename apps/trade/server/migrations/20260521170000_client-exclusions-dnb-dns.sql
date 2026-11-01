-- Up Migration

-- v3.4: structured DNB/DNS sides on each standing exclusion. Today every
-- row is implicitly blanket (block both buy and sell). Adding these two
-- booleans lets an advisor say "TSLA: don't add more (overconcentrated)
-- but rebalancing it down is fine" (DNB only) vs "AAPL: don't sell (low
-- cost basis) but more is OK" (DNS only) vs the existing blanket case
-- (both TRUE).
--
-- DEFAULT TRUE on both columns backfills every existing row with the
-- exact blanket semantic in place today — zero behavior change for
-- anything already in prod. PG 11+ ALTER TABLE ADD COLUMN ... NOT NULL
-- DEFAULT <const> is metadata-only on a table this size, so this is
-- effectively instant.
--
-- The CHECK constraint enforces "at least one side must be restricted"
-- at the DB level. A row with both flags FALSE would be a meaningless
-- no-op and a footgun. The server's Zod schema also rejects this, and
-- the modal's Apply button disables on any row with neither box ticked
-- — three layers of defense.

ALTER TABLE client_exclusions
    ADD COLUMN no_buy  BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN no_sell BOOLEAN NOT NULL DEFAULT TRUE,
    ADD CONSTRAINT client_exclusions_at_least_one_side CHECK (no_buy OR no_sell);

-- Down Migration

ALTER TABLE client_exclusions
    DROP CONSTRAINT IF EXISTS client_exclusions_at_least_one_side,
    DROP COLUMN IF EXISTS no_sell,
    DROP COLUMN IF EXISTS no_buy;
