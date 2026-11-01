-- AlterTable: change dtccNumber and associatedControlNumber from DOUBLE PRECISION to TEXT
-- to preserve leading zeros in DTCC and control numbers
ALTER TABLE "AcatRecord" ALTER COLUMN "dtccNumber" SET DATA TYPE TEXT USING "dtccNumber"::TEXT;
ALTER TABLE "AcatRecord" ALTER COLUMN "associatedControlNumber" SET DATA TYPE TEXT USING "associatedControlNumber"::TEXT;
