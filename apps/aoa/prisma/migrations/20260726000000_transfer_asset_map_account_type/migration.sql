-- Always-On Advice — asset-map rework S5: carry account_type in the transfer↔asset-map key.
--
-- S3/S4 keyed the link on (asset_map_folder_id, asset_map_custodian,
-- asset_map_account_number). But some mapping accounts have NO account number
-- (the source statement didn't carry one), and a client can hold two such
-- accounts at the SAME custodian distinguished ONLY by registration type — e.g.
-- a Traditional IRA + a Roth IRA at T. Rowe Price, both numberless (Reynold
-- Hayes). With no number the 3-part key is identical for both, so ops can't
-- pick between them and the linked-state can't show which was chosen. Adding
-- account_type to the stored key (and surfacing it in the picker) makes numberless
-- siblings distinguishable. Content-stable key, consistent with the S3 D-h choice
-- (not the non-durable account UUID).
--
-- Additive-only (ADR-5): one NEW nullable column, the 20260714120000_transfer_acat_id
-- idiom. It inherits app.transfer's FORCE-RLS policies + grants (a nullable add
-- needs no re-grant) and is captured by the app.transfer DB-trigger audit. No
-- uniqueness (S4 dropped that); reuse stays allowed.

ALTER TABLE "app"."transfer"
  ADD COLUMN "asset_map_account_type" text;

-- Extend the S4 plain lookup index to cover the type too (the picker's
-- already-linked probe now matches on all four key parts, NULL-safe).
DROP INDEX IF EXISTS "app"."transfer_asset_map_account_idx";
CREATE INDEX "transfer_asset_map_account_idx"
  ON "app"."transfer" ("asset_map_folder_id", "asset_map_custodian", "asset_map_account_number", "asset_map_account_type")
  WHERE "asset_map_folder_id" IS NOT NULL;
