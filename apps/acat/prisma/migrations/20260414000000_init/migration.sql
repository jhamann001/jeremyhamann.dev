-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AcatStatus" AS ENUM ('Matched', 'Mismatch', 'Unmapped', 'Pending');

-- CreateEnum
CREATE TYPE "CostBasisStatus" AS ENUM ('Awaiting', 'Received', 'Issue');

-- CreateEnum
CREATE TYPE "MapStatus" AS ENUM ('Mapped', 'Unmapped', 'Pending');

-- CreateTable
CREATE TABLE "AcatRecord" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "clientName" TEXT NOT NULL,
    "controlNumber" TEXT,
    "acatTransferId" TEXT,
    "direction" TEXT,
    "type" TEXT,
    "accountType" TEXT,
    "status" "AcatStatus" NOT NULL DEFAULT 'Pending',
    "wealthAdvisor" TEXT,
    "apexAccountId" TEXT NOT NULL,
    "statementAccountNumber" TEXT,
    "transferringContra" TEXT,
    "dtccNumber" DOUBLE PRECISION,
    "statementAmount" TEXT,
    "methodRequested" TEXT,
    "crwEe" TEXT,
    "originalClientRequestDate" TEXT,
    "opsSubmissionDateToApex" TEXT,
    "apexCompletionDate" TEXT,
    "feeCharged" TEXT,
    "feeAmount" TEXT,
    "feeMemo" TEXT,
    "feeRequestSubmitted" TEXT,
    "feeRequestCompleted" TEXT,
    "costBasisChecked" TEXT,
    "cbNotesTickets" TEXT,
    "crmTicket" TEXT,
    "apexTicket" TEXT,
    "additionalResources" TEXT,
    "notes" TEXT,
    "associatedControlNumber" DOUBLE PRECISION,
    "rejectionReason" TEXT,
    "crmDealId" TEXT NOT NULL DEFAULT '',
    "custodianId" TEXT NOT NULL DEFAULT '',
    "custodianName" TEXT NOT NULL DEFAULT '',
    "acatDate" TEXT NOT NULL,
    "completedDate" TEXT,
    "slackAlerted" BOOLEAN NOT NULL DEFAULT false,
    "mappingSource" TEXT NOT NULL DEFAULT 'GCP Project API',
    "apexSource" TEXT NOT NULL DEFAULT 'Pending Upload',
    "costBasisStatus" "CostBasisStatus" NOT NULL DEFAULT 'Awaiting',
    "assignedTo" TEXT,
    "totalExpectedValue" DOUBLE PRECISION,
    "lastUpdated" TEXT NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "AcatRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "acatRecordId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "cusip" TEXT,
    "expectedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mapStatus" "MapStatus" NOT NULL DEFAULT 'Pending',
    "issue" TEXT,
    "amount" DOUBLE PRECISION,
    "assetClass" TEXT,
    "settlingLocation" TEXT,
    "settlingLocationReason" TEXT,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Custodian" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "acatFeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "requiresManualReview" BOOLEAN NOT NULL DEFAULT false,
    "avgProcessingDays" INTEGER NOT NULL DEFAULT 7,
    "contactEmail" TEXT,

    CONSTRAINT "Custodian_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "acatRecordId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "oldValue" TEXT,
    "newValue" TEXT,
    "performedBy" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AcatRecord_status_idx" ON "AcatRecord"("status");

-- CreateIndex
CREATE INDEX "AcatRecord_clientName_idx" ON "AcatRecord"("clientName");

-- CreateIndex
CREATE INDEX "AcatRecord_controlNumber_idx" ON "AcatRecord"("controlNumber");

-- CreateIndex
CREATE INDEX "AcatRecord_deletedAt_idx" ON "AcatRecord"("deletedAt");

-- CreateIndex
CREATE INDEX "Asset_acatRecordId_idx" ON "Asset"("acatRecordId");

-- CreateIndex
CREATE INDEX "Asset_cusip_idx" ON "Asset"("cusip");

-- CreateIndex
CREATE UNIQUE INDEX "Custodian_name_key" ON "Custodian"("name");

-- CreateIndex
CREATE INDEX "AuditLog_acatRecordId_idx" ON "AuditLog"("acatRecordId");

-- CreateIndex
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");

-- AddForeignKey
ALTER TABLE "AcatRecord" ADD CONSTRAINT "AcatRecord_custodianId_fkey" FOREIGN KEY ("custodianId") REFERENCES "Custodian"("id") ON DELETE SET DEFAULT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_acatRecordId_fkey" FOREIGN KEY ("acatRecordId") REFERENCES "AcatRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_acatRecordId_fkey" FOREIGN KEY ("acatRecordId") REFERENCES "AcatRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
