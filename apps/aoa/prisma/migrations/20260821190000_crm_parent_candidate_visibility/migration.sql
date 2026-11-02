BEGIN;

-- Salesforce can expose the same record as either its case-sensitive 15-character
-- identifier or its derived 18-character identifier. The registry intentionally
-- canonicalizes those aliases to the first 15 characters, so app visibility must
-- use the same comparison for the two approved parent namespaces. All other
-- namespaces retain their existing exact-key checks.
CREATE INDEX IF NOT EXISTS household_sf_id_canonical_idx
  ON mirror.household (left(sf_id, 15));

CREATE INDEX IF NOT EXISTS client_sf_id_canonical_idx
  ON mirror.client (left(sf_id, 15));

ALTER POLICY crm_source_mapping_app_read
  ON app.crm_source_mapping
  USING (
    (
      source_system = 'CRM' AND source_namespace = 'household'
      AND EXISTS (
        SELECT 1 FROM mirror.household h
         WHERE left(h.sf_id, 15) = left(source_key, 15)
      )
    ) OR (
      source_system = 'CRM' AND source_namespace = 'contact'
      AND EXISTS (
        SELECT 1 FROM mirror.client c
         WHERE left(c.sf_id, 15) = left(source_key, 15)
      )
    ) OR (
      source_system = 'CRM' AND source_namespace = 'email'
      AND EXISTS (SELECT 1 FROM mirror.email e WHERE e.sf_id = source_key)
    ) OR (
      source_system = 'CRM' AND source_namespace = 'activity'
      AND EXISTS (SELECT 1 FROM mirror.activity a WHERE a.sf_id = source_key)
    ) OR (
      source_system = 'CALENDAR' AND source_namespace = 'appointment'
      AND EXISTS (
        SELECT 1 FROM mirror.appointment a WHERE a.external_key = source_key
      )
    ) OR (
      source_system = 'AOA' AND source_namespace = 'deal'
      AND EXISTS (SELECT 1 FROM app.deal d WHERE d.id = source_key)
    ) OR (
      source_system = 'CRM' AND source_namespace = 'opportunity'
      AND EXISTS (SELECT 1 FROM app.deal d WHERE d.sf_deal_id = source_key)
    ) OR (
      source_system = 'AOA' AND source_namespace = 'transfer'
      AND EXISTS (SELECT 1 FROM app.transfer t WHERE t.id = source_key)
    )
  );

COMMIT;
