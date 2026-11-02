BEGIN;

-- Reconciliation compares Salesforce parent aliases by their canonical first
-- 15 characters. The ordinary source-coordinate unique index cannot serve that
-- expression, which previously forced repeated scans of all household/contact
-- mappings for every parent-bearing source row.
--
-- Keep the index limited to the two approved CRM parent namespaces. The
-- lifecycle column supports the active-parent lookup while the same index also
-- serves the conflict and width-alias checks that intentionally inspect every
-- mapping state.
CREATE INDEX crm_source_mapping_crm_parent_canonical_idx
  ON app.crm_source_mapping (
    source_namespace,
    left(source_key, 15),
    mapping_state
  )
  INCLUDE (identity_id)
  WHERE source_system = 'CRM'
    AND source_namespace IN ('household', 'contact');

COMMIT;
