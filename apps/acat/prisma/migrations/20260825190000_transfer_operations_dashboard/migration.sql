-- Transfer workflow is intentionally separate from both transfer type
-- (Full / Partial / Residual Credit) and request method (FeeStore, DocuSign, etc.).
CREATE TYPE "TransferWorkflow" AS ENUM (
  'ACAT',
  'MANUAL',
  'PAPERWORK',
  'RESIDUAL',
  'UNCLASSIFIED'
);

CREATE TYPE "DataQualityReviewStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'CLOSED');
CREATE TYPE "DataQualityResolution" AS ENUM (
  'CORRECTED',
  'RESOLVED_MANUALLY',
  'FALSE_POSITIVE',
  'NOT_APPLICABLE',
  'ACKNOWLEDGED_UNRESOLVED',
  'DUPLICATE'
);

ALTER TABLE "AcatRecord"
  ADD COLUMN "transferWorkflow" "TransferWorkflow" NOT NULL DEFAULT 'UNCLASSIFIED',
  ADD COLUMN "residualMonitoringRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "residualFollowUpDate" TEXT;

-- Conservative backfill: only classify rows where the existing data is
-- unambiguous. DocuSign-only rows remain UNCLASSIFIED because request method
-- does not prove whether the operational workflow was manual or paperwork.
UPDATE "AcatRecord"
SET "transferWorkflow" = 'RESIDUAL'
WHERE lower(coalesce("type", '')) = 'residual credit';

UPDATE "AcatRecord"
SET "transferWorkflow" = 'ACAT'
WHERE "transferWorkflow" = 'UNCLASSIFIED'
  AND lower(coalesce("methodRequested", '')) LIKE '%api%';

UPDATE "AcatRecord"
SET "transferWorkflow" = 'MANUAL'
WHERE "transferWorkflow" = 'UNCLASSIFIED'
  AND lower(coalesce("methodRequested", '')) LIKE '%non-acat transfer (manual)%';

CREATE TABLE "DataQualityReview" (
  "id" TEXT NOT NULL,
  "acatRecordId" TEXT NOT NULL,
  "ruleKey" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "status" "DataQualityReviewStatus" NOT NULL DEFAULT 'OPEN',
  "resolution" "DataQualityResolution",
  "note" TEXT,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DataQualityReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DataQualityReview_acatRecordId_fkey"
    FOREIGN KEY ("acatRecordId") REFERENCES "AcatRecord"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DataQualityReview_acatRecordId_ruleKey_fingerprint_key"
  ON "DataQualityReview"("acatRecordId", "ruleKey", "fingerprint");
CREATE INDEX "DataQualityReview_status_idx" ON "DataQualityReview"("status");
CREATE INDEX "DataQualityReview_acatRecordId_idx" ON "DataQualityReview"("acatRecordId");
CREATE INDEX "AcatRecord_transferWorkflow_idx" ON "AcatRecord"("transferWorkflow");
CREATE INDEX "AcatRecord_residualMonitoringRequired_idx" ON "AcatRecord"("residualMonitoringRequired");
