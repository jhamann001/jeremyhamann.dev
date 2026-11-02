-- Always-On Advice — assign an asset map to a transfer (the asset-map rework S3).
--
-- A transfer can be linked to ONE asset-mapping account (the durable, folder-
-- scoped key the mapping tables use: source_folder_id + custodian +
-- account_number — see mirror.acat_asset_map_account_link, mig 20260722000000).
-- The link lets ops attach the pre-transfer asset map that funds a given
-- transfer, surfaced on the funding-picture card.
--
-- Additive-only (ADR-5), the 20260714120000_transfer_acat_id / 20260717000000
-- _transfer_deal_sourced idiom: three NEW nullable columns. Nothing dropped,
-- renamed, or made NOT NULL. The new columns inherit app.transfer's FORCE-RLS
-- app_rw role-gated policies + table grant (a nullable add needs no per-column
-- re-grant — the transfer_acat_id migration proved this), and writes are
-- captured automatically by the app.transfer DB-trigger audit (audit.row_change,
-- 20260713000000). NO ingest_rw grant: the link is a HUMAN (ops) write only,
-- through withUserScope — no machine/sync writer.

-- ---------------------------------------------------------------------------
-- 1. The three link columns — the durable asset-map account key. All nullable
--    (an unlinked transfer carries NULLs, the common state).
-- ---------------------------------------------------------------------------
ALTER TABLE "app"."transfer"
  ADD COLUMN "asset_map_folder_id"      text,
  ADD COLUMN "asset_map_custodian"      text,
  ADD COLUMN "asset_map_account_number" text;

-- ---------------------------------------------------------------------------
-- 2. Cardinality: ONE transfer ↔ ONE asset-map account (owner decision). A
--    PARTIAL UNIQUE index over the three-part key, WHERE the folder id is set,
--    so an account already linked to a transfer can't be linked to a second one
--    (it drops out of the picker), while the many unlinked transfers (all-NULL)
--    stay unconstrained. Mirrors the transfer_deal_id_key / acat_transfer_id
--    partial-unique idiom exactly — Prisma's DSL cannot express a partial
--    @@unique, so schema.prisma intentionally declares NO @@unique here and
--    `prisma migrate dev` will report this index as drift; the repo deploys via
--    `prisma migrate deploy`, which does not diff — do NOT "fix" the drift by
--    dropping it.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "transfer_asset_map_account_key"
  ON "app"."transfer" ("asset_map_folder_id", "asset_map_custodian", "asset_map_account_number")
  WHERE "asset_map_folder_id" IS NOT NULL;
