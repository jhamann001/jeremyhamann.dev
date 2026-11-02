-- AlterTable
ALTER TABLE "deal" ADD COLUMN     "archived_at" TIMESTAMPTZ(6),
ADD COLUMN     "archived_by" TEXT;
