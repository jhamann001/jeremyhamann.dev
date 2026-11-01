-- CreateEnum
CREATE TYPE "CustodianFeeDirection" AS ENUM ('ANY', 'IN', 'OUT');

-- AlterTable
ALTER TABLE "CustodianFee" ADD COLUMN "direction" "CustodianFeeDirection" NOT NULL DEFAULT 'ANY';
