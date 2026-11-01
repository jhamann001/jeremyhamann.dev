-- Up Migration

-- Store client name directly on trade_requests (Warehouse is now the source of truth for clients)
ALTER TABLE trade_requests ADD COLUMN IF NOT EXISTS client_name VARCHAR(255);

-- Store account metadata at request creation time (for run-engine later)
ALTER TABLE trade_requests ADD COLUMN IF NOT EXISTS account_metadata JSONB;

-- Widen client_id for Warehouse UUIDs (user-xxxx format, up to 50 chars)
ALTER TABLE trade_requests ALTER COLUMN client_id TYPE VARCHAR(100);

-- Drop FK constraints that reference local clients/accounts tables
ALTER TABLE trade_requests DROP CONSTRAINT IF EXISTS trade_requests_client_id_fkey;

-- Down Migration
-- WARNING: Reverting client_id to VARCHAR(50) will fail if any client_id exceeds 50 chars.
-- The FK to clients is restored but may fail if client_id values don't exist in the clients table.

ALTER TABLE trade_requests DROP COLUMN IF EXISTS account_metadata;
ALTER TABLE trade_requests DROP COLUMN IF EXISTS client_name;

-- Truncate client_ids that exceed 50 chars before narrowing the column
UPDATE trade_requests SET client_id = LEFT(client_id, 50) WHERE LENGTH(client_id) > 50;
ALTER TABLE trade_requests ALTER COLUMN client_id TYPE VARCHAR(50);

-- Restore FK (will fail if client_ids don't exist in clients table — only safe for local-DB deployments)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'clients') THEN
    ALTER TABLE trade_requests ADD CONSTRAINT trade_requests_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES clients(id);
  END IF;
END $$;
