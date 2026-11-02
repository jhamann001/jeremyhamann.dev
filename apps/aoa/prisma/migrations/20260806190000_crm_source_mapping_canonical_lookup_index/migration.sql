BEGIN;

-- Reconciliation resolves normalized Salesforce parent references against the
-- durable mapping registry after the first live run has populated it. The
-- existing exact-coordinate unique index cannot serve left(source_key, 15),
-- which otherwise turns each parent check into a repeated mapping-table scan.
-- Keep this key-only and non-unique: 15- and 18-character aliases intentionally
-- coexist and point to the same identity.
CREATE INDEX crm_source_mapping_crm_canonical_key_idx
  ON app.crm_source_mapping (source_namespace, left(source_key, 15))
  WHERE source_system = 'CRM';

COMMIT;
