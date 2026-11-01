-- CreateEnum
CREATE TYPE "CustodianTransferType" AS ENUM ('ACAT_API', 'MANUAL', 'MIXED', 'INTERNAL', 'UNCONFIRMED');

-- CreateEnum
CREATE TYPE "DocumentationStatus" AS ENUM ('DOCUMENTED', 'PARTIAL', 'NEEDS_CALL');

-- AlterTable
ALTER TABLE "Custodian" ADD COLUMN     "transferType" "CustodianTransferType",
ADD COLUMN     "documentationStatus" "DocumentationStatus",
ADD COLUMN     "dtcNumber" TEXT,
ADD COLUMN     "signature" TEXT,
ADD COLUMN     "letterOfAcceptance" TEXT,
ADD COLUMN     "medallionRequired" TEXT,
ADD COLUMN     "liquidationMethod" TEXT,
ADD COLUMN     "returnMethod" TEXT,
ADD COLUMN     "watchouts" TEXT,
ADD COLUMN     "paperworkOnFile" BOOLEAN,
ADD COLUMN     "transfersToDate" INTEGER,
ADD COLUMN     "recentClients" TEXT;
