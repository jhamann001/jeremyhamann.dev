BEGIN;

-- Support the Explorer's newest-first page and page-bounded open-exception
-- grouping. These indexes contain only registry IDs, timestamps, and
-- controlled states; no client names, email addresses, or source keys are
-- copied into an index. Existing source-backed RLS policies remain unchanged.
CREATE INDEX crm_identity_updated_at_id_idx
  ON app.crm_identity (updated_at DESC, id);

CREATE INDEX crm_identity_exception_open_source_mapping_idx
  ON app.crm_identity_exception (source_mapping_id)
  WHERE exception_state = 'OPEN';

COMMIT;
