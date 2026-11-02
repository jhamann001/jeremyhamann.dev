-- AlterTable
ALTER TABLE "deal" ADD COLUMN     "archived_reason" TEXT,
ADD COLUMN     "employer" TEXT,
ADD COLUMN     "lost_from" TEXT,
ADD COLUMN     "rolling_into" TEXT,
ADD COLUMN     "stage_history" JSONB NOT NULL DEFAULT '[]';
