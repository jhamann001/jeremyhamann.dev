CREATE TABLE "CustodianFeeScheduleDocument" (
    "id" TEXT NOT NULL,
    "custodianId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "CustodianFeeScheduleDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustodianFeeScheduleDocument_custodianId_createdAt_id_idx"
ON "CustodianFeeScheduleDocument"("custodianId", "createdAt", "id");

CREATE INDEX "CustodianFeeScheduleDocument_custodianId_sha256_idx"
ON "CustodianFeeScheduleDocument"("custodianId", "sha256");

ALTER TABLE "CustodianFeeScheduleDocument"
ADD CONSTRAINT "CustodianFeeScheduleDocument_custodianId_fkey"
FOREIGN KEY ("custodianId") REFERENCES "Custodian"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
