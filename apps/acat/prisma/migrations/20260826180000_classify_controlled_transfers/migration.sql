-- A genuine Apex control number is strong evidence that an otherwise
-- unclassified, non-residual transfer used the ACAT/API workflow. Require the
-- observed 14-digit format and exclude ambiguous multi-method records so this
-- cleanup never overwrites an explicit workflow or a record needing review.
WITH "classified" AS (
  UPDATE "AcatRecord"
  SET
    "transferWorkflow" = 'ACAT',
    "lastUpdated" = CURRENT_TIMESTAMP
  WHERE "transferWorkflow" = 'UNCLASSIFIED'
    AND LOWER(BTRIM(COALESCE("type", ''))) <> 'residual credit'
    AND BTRIM(COALESCE("controlNumber", '')) ~ '^[0-9]{14}$'
    AND POSITION(',' IN COALESCE("methodRequested", '')) = 0
    AND LOWER(COALESCE("methodRequested", '')) NOT LIKE '%manual%'
  RETURNING "id"
)
INSERT INTO "AuditLog" (
  "id",
  "acatRecordId",
  "action",
  "field",
  "oldValue",
  "newValue",
  "performedBy",
  "timestamp"
)
SELECT
  'bulk-workflow-acat-' || "id",
  "id",
  'bulk-update',
  'transferWorkflow',
  'UNCLASSIFIED',
  'ACAT',
  'system:control-number-cleanup',
  CURRENT_TIMESTAMP
FROM "classified";
