-- Up Migration

ALTER TABLE trade_requests ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_requests_idempotency
  ON trade_requests (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_trade_requests_idempotency;
ALTER TABLE trade_requests DROP COLUMN IF EXISTS idempotency_key;
