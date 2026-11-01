-- Drop cost-basis tracking from AcatRecord. Cost basis is now tracked
-- in a separate system; the in-app `CostBasisTab`, dashboard tile,
-- records column, and advisor field were all removed. This migration
-- removes the underlying columns + enum so Prisma generates clean
-- types and queries don't carry dead schema.

ALTER TABLE "AcatRecord" DROP COLUMN IF EXISTS "costBasisStatus";
ALTER TABLE "AcatRecord" DROP COLUMN IF EXISTS "costBasisChecked";
ALTER TABLE "AcatRecord" DROP COLUMN IF EXISTS "cbNotesTickets";

DROP TYPE IF EXISTS "CostBasisStatus";
