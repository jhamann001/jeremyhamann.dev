-- ticket write-through: the position mirror had no delete marker, so a
-- position removed in AoA reappeared on the next read. Additive; no grant or
-- policy change (ingest_rw already has UPDATE and FOR ALL on this table).
ALTER TABLE mirror.acat_asset_map_position
  ADD COLUMN is_deleted boolean NOT NULL DEFAULT false;
