-- Scope changes have no new title confirmation or generated document. Keep
-- both existing result shapes and permit only the new result-free operation.
ALTER TABLE "TransferPreparationOperation"
  DROP CONSTRAINT "TransferPreparationOperation_result_check",
  ADD CONSTRAINT "TransferPreparationOperation_result_check" CHECK (
    ("kind" = 'CONFIRM_TITLE' AND "confirmationId" IS NOT NULL AND "documentId" IS NULL) OR
    ("kind" = 'GENERATE' AND "documentId" IS NOT NULL AND "confirmationId" IS NOT NULL) OR
    ("kind" = 'UPDATE_SCOPE' AND "confirmationId" IS NULL AND "documentId" IS NULL)
  );
