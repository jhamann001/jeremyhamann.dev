-- Diagnostic-only Salesforce parent tombstone and merge evidence.
--
-- This table is deliberately separate from mirror.crm_parent_source so a
-- deleted or merged key can never become authoritative identity evidence.
-- It stores keys and reason state only: no names, emails, stages, or content.

BEGIN;

CREATE TABLE mirror.crm_parent_orphan_evidence (
  parent_type text NOT NULL,
  source_key text NOT NULL,
  normalized_key text GENERATED ALWAYS AS (left(source_key, 15)) STORED,
  evidence_type text NOT NULL,
  replacement_key text,
  replacement_normalized_key text GENERATED ALWAYS AS (
    CASE WHEN replacement_key IS NULL THEN NULL ELSE left(replacement_key, 15) END
  ) STORED,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_type, normalized_key),
  CONSTRAINT crm_parent_orphan_evidence_type_check
    CHECK (parent_type IN ('HOUSEHOLD', 'CONTACT')),
  CONSTRAINT crm_parent_orphan_evidence_state_check
    CHECK (evidence_type IN ('DELETED', 'MERGED')),
  CONSTRAINT crm_parent_orphan_evidence_key_check
    CHECK (
      (parent_type = 'HOUSEHOLD'
       AND source_key ~ '^001[[:alnum:]]{12}([[:alnum:]]{3})?$'
       AND (replacement_key IS NULL
            OR replacement_key ~ '^001[[:alnum:]]{12}([[:alnum:]]{3})?$'))
      OR
      (parent_type = 'CONTACT'
       AND source_key ~ '^003[[:alnum:]]{12}([[:alnum:]]{3})?$'
       AND (replacement_key IS NULL
            OR replacement_key ~ '^003[[:alnum:]]{12}([[:alnum:]]{3})?$'))
    ),
  CONSTRAINT crm_parent_orphan_evidence_replacement_check
    CHECK (
      (evidence_type = 'DELETED' AND replacement_key IS NULL)
      OR
      (evidence_type = 'MERGED'
       AND replacement_key IS NOT NULL
       AND left(source_key, 15) <> left(replacement_key, 15))
    )
);

CREATE INDEX crm_parent_orphan_evidence_replacement_idx
  ON mirror.crm_parent_orphan_evidence
    (parent_type, replacement_normalized_key)
  WHERE replacement_normalized_key IS NOT NULL;

REVOKE ALL ON mirror.crm_parent_orphan_evidence
  FROM PUBLIC, app_rw, ingest_rw, identity_reconciler;
GRANT SELECT ON mirror.crm_parent_orphan_evidence TO ingest_rw;
GRANT INSERT (
  parent_type, source_key, evidence_type, replacement_key, observed_at
) ON mirror.crm_parent_orphan_evidence TO ingest_rw;
GRANT UPDATE (
  source_key, evidence_type, replacement_key, observed_at
) ON mirror.crm_parent_orphan_evidence TO ingest_rw;
GRANT SELECT (
  parent_type, normalized_key, evidence_type,
  replacement_normalized_key, observed_at
) ON mirror.crm_parent_orphan_evidence TO identity_reconciler;

ALTER TABLE mirror.crm_parent_orphan_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.crm_parent_orphan_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY crm_parent_orphan_evidence_ingest_read
  ON mirror.crm_parent_orphan_evidence FOR SELECT TO ingest_rw USING (true);
CREATE POLICY crm_parent_orphan_evidence_ingest_insert
  ON mirror.crm_parent_orphan_evidence FOR INSERT TO ingest_rw WITH CHECK (true);
CREATE POLICY crm_parent_orphan_evidence_ingest_update
  ON mirror.crm_parent_orphan_evidence FOR UPDATE TO ingest_rw
  USING (true) WITH CHECK (true);
CREATE POLICY crm_parent_orphan_evidence_reconciler_read
  ON mirror.crm_parent_orphan_evidence FOR SELECT TO identity_reconciler
  USING (true);

COMMIT;
