-- Always-On Advice — asset-map rework S4: make the transfer↔asset-map link REUSABLE.
--
-- S3 (mig 20260724000000) enforced ONE transfer ↔ ONE asset-map account via a
-- partial UNIQUE index. Real cases break that: a single source registration
-- (e.g. one T. Rowe Price account) is routinely split into multiple receiving
-- registrations — a Traditional IRA transfer AND a Roth IRA transfer — so one
-- mapping account must be linkable to MORE THAN ONE transfer. This drops the
-- uniqueness constraint (owner decision, 2026-07-19) and replaces it with a plain
-- (non-unique) composite index so the "which transfers link this account" lookup
-- the picker now does stays fast.
--
-- Additive/relaxing only: no column added/dropped, no data touched. The picker
-- read (lib/data/transfer-asset-map.ts) now SURFACES already-linked accounts with
-- an "also linked to …" annotation instead of hiding them; the link action no
-- longer relies on the unique index as a backstop (reuse is intended, not an error).

-- Drop the one-transfer-per-account uniqueness (idempotent).
DROP INDEX IF EXISTS "app"."transfer_asset_map_account_key";

-- Keep a plain index on the durable key so per-account link lookups (count +
-- linking-transfer names) don't scan app.transfer.
CREATE INDEX IF NOT EXISTS "transfer_asset_map_account_idx"
  ON "app"."transfer" ("asset_map_folder_id", "asset_map_custodian", "asset_map_account_number")
  WHERE "asset_map_folder_id" IS NOT NULL;
