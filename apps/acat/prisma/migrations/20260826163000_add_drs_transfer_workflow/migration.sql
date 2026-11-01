-- DRS is an exclusive transfer workflow alongside ACAT, Manual, and Residual.
ALTER TYPE "TransferWorkflow" ADD VALUE 'DRS';

-- Paperwork describes the request method, not the processing workflow. Preserve
-- that distinction in methodRequested and normalize legacy workflow values.
UPDATE "AcatRecord"
SET "transferWorkflow" = 'MANUAL'
WHERE "transferWorkflow" = 'PAPERWORK';
