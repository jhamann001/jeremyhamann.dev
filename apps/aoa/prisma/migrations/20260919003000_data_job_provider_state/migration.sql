BEGIN;

-- Private metadata-only adapter checkpoint. Never returned by reader APIs.
-- Inherits the existing snapshot table's forced RLS and collector-only writes.
ALTER TABLE app.data_job_snapshot ADD COLUMN provider_state jsonb
  CHECK (provider_state IS NULL OR (jsonb_typeof(provider_state) = 'object' AND octet_length(provider_state::text) < 24000));

COMMIT;
