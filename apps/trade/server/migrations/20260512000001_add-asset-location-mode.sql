-- Up Migration

-- Asset location mode for the trade request engine.
-- 'priority' (default) preserves the existing PRIORITY_MATRIX behavior where
-- the engine asset-locates across account types for tax-efficient placement.
-- 'mirror' applies the household risk allocation proportionally to each
-- account so every sleeve ends up with the same cash/fixed/equity mix.
ALTER TABLE trade_requests
    ADD COLUMN asset_location_mode TEXT NOT NULL DEFAULT 'priority'
        CHECK (asset_location_mode IN ('priority', 'mirror'));

-- Down Migration

ALTER TABLE trade_requests DROP COLUMN IF EXISTS asset_location_mode;
