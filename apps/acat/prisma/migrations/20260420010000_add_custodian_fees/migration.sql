-- CreateEnum
CREATE TYPE "CustodianFeeAccountType" AS ENUM ('ANY', 'IRA', 'BROKERAGE');

-- CreateEnum
CREATE TYPE "CustodianFeeTransferType" AS ENUM ('ANY', 'FULL', 'PARTIAL');

-- CreateTable
CREATE TABLE "CustodianFee" (
    "id" TEXT NOT NULL,
    "custodianId" TEXT NOT NULL,
    "feeType" TEXT NOT NULL,
    "accountType" "CustodianFeeAccountType" NOT NULL DEFAULT 'ANY',
    "transferType" "CustodianFeeTransferType" NOT NULL DEFAULT 'ANY',
    "amount" DOUBLE PRECISION,
    "amountText" TEXT,
    "notes" TEXT,
    "documentation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustodianFee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustodianFee_custodianId_idx" ON "CustodianFee"("custodianId");

-- CreateIndex
CREATE INDEX "CustodianFee_custodianId_accountType_idx" ON "CustodianFee"("custodianId", "accountType");

-- AddForeignKey
ALTER TABLE "CustodianFee" ADD CONSTRAINT "CustodianFee_custodianId_fkey" FOREIGN KEY ("custodianId") REFERENCES "Custodian"("id") ON DELETE CASCADE ON UPDATE CASCADE;
