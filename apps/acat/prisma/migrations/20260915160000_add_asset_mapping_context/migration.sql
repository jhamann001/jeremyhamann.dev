ALTER TABLE "AcatRecord" ADD COLUMN "mappingSyncedAt" TEXT;

ALTER TABLE "Asset"
    ADD COLUMN "mappingTransferStatus" TEXT,
    ADD COLUMN "mappingTransferNotes" TEXT,
    ADD COLUMN "mappingTransferring" BOOLEAN,
    ADD COLUMN "mappingStatementDate" TEXT,
    ADD COLUMN "mappingStatementAgeDays" INTEGER,
    ADD COLUMN "mappingStatementIsStale" BOOLEAN,
    ADD COLUMN "mappingSyncedAt" TEXT;
