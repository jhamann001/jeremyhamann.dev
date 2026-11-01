-- ticket: Drop the redundant `completedDate` column and add
-- `reconCompletedAt` to track when an ACAT's reconciliation crosses
-- the 90% auto-complete threshold.
--
-- Rationale:
--   - completedDate doubled with apexCompletionDate; ops never used both.
--     The only legitimate source for "when did this ACAT settle" is the
--     date Apex confirms, which lives in apexCompletionDate. The old
--     completedDate column was also incorrectly being written by the
--     CostBasisTab "Date Received" field (a separate concept entirely).
--   - reconCompletedAt is set automatically when assets/apexSource patch
--     bring the recon rate to >= 90% with both GCP positions and an
--     Apex CSV present.

ALTER TABLE "AcatRecord" DROP COLUMN IF EXISTS "completedDate";
ALTER TABLE "AcatRecord" ADD COLUMN "reconCompletedAt" TEXT;
