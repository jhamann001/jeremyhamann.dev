-- Operational funding revisions and factual corrections have separate effects.
ALTER TABLE app.transfer
  ADD COLUMN recorded_funding_type "FundingType",
  ADD COLUMN funding_method_revision integer NOT NULL DEFAULT 0 CHECK (funding_method_revision >= 0),
  ADD COLUMN drs_method_change_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN funding_route_change_pending boolean NOT NULL DEFAULT false;

-- Restricted append-only history. No generic row-change trigger: the required
-- reason and task snapshot may contain private context. The writer audits only
-- controlled enums, revisions and counts in the same transaction.
CREATE TABLE app.transfer_funding_method_correction (
  id text PRIMARY KEY,
  transfer_id text NOT NULL REFERENCES app.transfer(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  kind text NOT NULL CHECK (kind IN ('PLAN_REVISION', 'RECORDED_CORRECTION')),
  previous_funding_type "FundingType",
  funding_type "FundingType" NOT NULL,
  stage "TransferStage" NOT NULL,
  base_plan_version integer NOT NULL,
  plan_version integer NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  affected_work_snapshot jsonb NOT NULL,
  changed_by text NOT NULL CHECK (char_length(btrim(changed_by)) > 0),
  changed_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX transfer_funding_method_correction_transfer_id_revision_key
  ON app.transfer_funding_method_correction(transfer_id, revision);
CREATE INDEX transfer_funding_method_correction_transfer_id_idx
  ON app.transfer_funding_method_correction(transfer_id);
GRANT SELECT, INSERT ON app.transfer_funding_method_correction TO app_rw;
REVOKE UPDATE, DELETE ON app.transfer_funding_method_correction FROM app_rw;
ALTER TABLE app.transfer_funding_method_correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.transfer_funding_method_correction FORCE ROW LEVEL SECURITY;
CREATE POLICY transfer_funding_method_correction_read_ops ON app.transfer_funding_method_correction
  FOR SELECT TO app_rw USING (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND EXISTS (SELECT 1 FROM app.transfer t WHERE t.id = transfer_id)
  );
CREATE POLICY transfer_funding_method_correction_insert_ops ON app.transfer_funding_method_correction
  FOR INSERT TO app_rw WITH CHECK (
    current_setting('app.user_role', true) IN ('ADMIN', 'OPERATIONS')
    AND changed_by = current_setting('app.user_email', true)
    AND EXISTS (SELECT 1 FROM app.transfer t WHERE t.id = transfer_id AND t.archived_at IS NULL)
  );
