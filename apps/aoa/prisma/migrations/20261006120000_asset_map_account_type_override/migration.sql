-- AoA's copy of the pipeline's account-type override person and
-- time, for the manual account-type badge. Additive and nullable; no grant or
-- policy change (ingest_rw already has UPDATE and FOR ALL on this table, and
-- app_rw's table-level SELECT covers new columns).
ALTER TABLE mirror.acat_asset_map_account
  ADD COLUMN account_type_overridden_by text,
  ADD COLUMN account_type_overridden_at timestamptz;
