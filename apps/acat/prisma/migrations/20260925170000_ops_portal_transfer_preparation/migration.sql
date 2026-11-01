ALTER TABLE "AcatRecord" ADD COLUMN "activeTransferTitleConfirmationId" TEXT;
ALTER TABLE "AcatDocument" ADD COLUMN "preparationSnapshot" JSONB;
ALTER TABLE "AcatDocument" ADD COLUMN "serviceOrigin" TEXT;

CREATE TABLE "TransferTitleConfirmation" (
  "id" TEXT PRIMARY KEY,
  "acatRecordId" TEXT NOT NULL REFERENCES "AcatRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "registration" TEXT NOT NULL,
  "receivingAccountFingerprint" TEXT NOT NULL,
  "sourceAccountType" TEXT,
  "sourceIdentityVersion" INTEGER NOT NULL,
  "sourceRevision" TEXT NOT NULL,
  "confirmedBy" TEXT NOT NULL,
  "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "serviceOrigin" TEXT NOT NULL
);
CREATE INDEX "TransferTitleConfirmation_acatRecordId_confirmedAt_idx" ON "TransferTitleConfirmation"("acatRecordId", "confirmedAt");
ALTER TABLE "AcatRecord" ADD CONSTRAINT "AcatRecord_activeTransferTitleConfirmationId_fkey"
  FOREIGN KEY ("activeTransferTitleConfirmationId") REFERENCES "TransferTitleConfirmation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TransferPreparationOperation" (
  "id" TEXT PRIMARY KEY,
  "acatRecordId" TEXT NOT NULL REFERENCES "AcatRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorEmail" TEXT NOT NULL,
  "operationId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "confirmationId" TEXT,
  "documentId" TEXT,
  "serviceOrigin" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TransferPreparationOperation_result_check" CHECK (
    ("kind" = 'CONFIRM_TITLE' AND "confirmationId" IS NOT NULL AND "documentId" IS NULL) OR
    ("kind" = 'GENERATE' AND "documentId" IS NOT NULL AND "confirmationId" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "TransferPreparationOperation_record_actor_operation_key"
  ON "TransferPreparationOperation"("acatRecordId", "actorEmail", "operationId");

-- Runs AFTER AcatRecord_identity_version (PostgreSQL orders same-event
-- triggers by name), including writes by older binaries and direct SQL.
CREATE FUNCTION "acat_invalidate_transfer_title"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."apexAccountId" IS DISTINCT FROM OLD."apexAccountId"
      OR NEW."accountType" IS DISTINCT FROM OLD."accountType"
      OR NEW."clientName" IS DISTINCT FROM OLD."clientName"
      OR NEW."cedar_ridge_user_id" IS DISTINCT FROM OLD."cedar_ridge_user_id"
      OR NEW."identityVersion" IS DISTINCT FROM OLD."identityVersion"
      OR NEW."verifiedApexAccountTitle" IS DISTINCT FROM OLD."verifiedApexAccountTitle"
      OR NEW."verifiedApexAccountTitleBy" IS DISTINCT FROM OLD."verifiedApexAccountTitleBy"
      OR NEW."verifiedApexAccountTitleAt" IS DISTINCT FROM OLD."verifiedApexAccountTitleAt")
     AND NEW."activeTransferTitleConfirmationId" IS NOT DISTINCT FROM OLD."activeTransferTitleConfirmationId" THEN
    NEW."activeTransferTitleConfirmationId" := NULL;
  END IF;
  -- A new pointer must belong to this transfer and mirror the exact immutable
  -- human confirmation; application fingerprint validation adds account binding.
  IF NEW."activeTransferTitleConfirmationId" IS NOT NULL
     AND NEW."activeTransferTitleConfirmationId" IS DISTINCT FROM OLD."activeTransferTitleConfirmationId"
     AND NOT EXISTS (SELECT 1 FROM "TransferTitleConfirmation" c
       WHERE c."id" = NEW."activeTransferTitleConfirmationId"
         AND c."acatRecordId" = NEW."id"
         AND c."title" = NEW."verifiedApexAccountTitle"
         AND c."confirmedBy" = NEW."verifiedApexAccountTitleBy"
         AND c."confirmedAt" = (NEW."verifiedApexAccountTitleAt"::timestamptz AT TIME ZONE 'UTC')
         AND c."sourceIdentityVersion" = NEW."identityVersion"
         AND c."sourceAccountType" IS NOT DISTINCT FROM NEW."accountType") THEN
    RAISE EXCEPTION 'invalid transfer confirmation binding';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AcatRecord_z_transfer_title_binding"
  BEFORE UPDATE ON "AcatRecord" FOR EACH ROW EXECUTE FUNCTION "acat_invalidate_transfer_title"();

CREATE FUNCTION "transfer_preparation_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'transfer preparation evidence is immutable';
END;
$$;
CREATE TRIGGER "TransferTitleConfirmation_immutable"
  BEFORE UPDATE OR DELETE ON "TransferTitleConfirmation" FOR EACH ROW EXECUTE FUNCTION "transfer_preparation_append_only"();
CREATE TRIGGER "TransferPreparationOperation_immutable"
  BEFORE UPDATE OR DELETE ON "TransferPreparationOperation" FOR EACH ROW EXECUTE FUNCTION "transfer_preparation_append_only"();
