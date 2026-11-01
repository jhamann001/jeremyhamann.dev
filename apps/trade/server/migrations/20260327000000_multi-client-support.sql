-- Up Migration

ALTER TABLE trade_requests ADD COLUMN IF NOT EXISTS client_ids JSONB;
ALTER TABLE trade_requests ADD COLUMN IF NOT EXISTS client_names JSONB;

-- Backfill: wrap existing single client_id/client_name into arrays
UPDATE trade_requests
SET client_ids = jsonb_build_array(client_id),
    client_names = jsonb_build_array(COALESCE(client_name, ''))
WHERE client_ids IS NULL;

-- Down Migration

ALTER TABLE trade_requests DROP COLUMN IF EXISTS client_ids;
ALTER TABLE trade_requests DROP COLUMN IF EXISTS client_names;
