-- Additive only: previous application revisions remain compatible.
CREATE TYPE "AcatDocumentKind" AS ENUM ('MAPPING_CSV', 'TRANSFER_FORM');

CREATE TABLE "AcatDocument" (
    "id" TEXT NOT NULL,
    "acatRecordId" TEXT NOT NULL,
    "kind" "AcatDocumentKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "inputCsv" TEXT NOT NULL,
    "positionCount" INTEGER NOT NULL,
    "includedCount" INTEGER NOT NULL,
    "excludedCount" INTEGER NOT NULL,
    "undecidedCount" INTEGER NOT NULL,
    CONSTRAINT "AcatDocument_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AcatDocument_acatRecordId_createdAt_id_idx" ON "AcatDocument"("acatRecordId", "createdAt", "id");
ALTER TABLE "AcatDocument" ADD CONSTRAINT "AcatDocument_acatRecordId_fkey" FOREIGN KEY ("acatRecordId") REFERENCES "AcatRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
