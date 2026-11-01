-- CreateEnum
CREATE TYPE "CustodianReviewStatus" AS ENUM ('NEEDS_SETUP', 'VERIFIED');

-- AlterTable
ALTER TABLE "Custodian" ADD COLUMN "reviewStatus" "CustodianReviewStatus" NOT NULL DEFAULT 'VERIFIED';
