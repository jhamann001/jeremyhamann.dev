-- Create new enum type with all 16 statuses
CREATE TYPE "AcatStatus_new" AS ENUM (
  'WaitingForApex',
  'PendingAccountOpening',
  'WaitingOnClient',
  'AcatReceived',
  'ToCome',
  'Submitted',
  'PendingReview',
  'PendingContraResponse',
  'Accepted',
  'PendingSettlement',
  'PendingBookkeeping',
  'Completed',
  'Rejected',
  'Purged',
  'Canceled',
  'Deferred'
);

-- Drop old default before changing the column type
ALTER TABLE "AcatRecord"
  ALTER COLUMN "status" DROP DEFAULT;

-- Swap the column to use the new enum
ALTER TABLE "AcatRecord"
  ALTER COLUMN "status" TYPE "AcatStatus_new" USING ("status"::text::"AcatStatus_new");

-- Set new default
ALTER TABLE "AcatRecord"
  ALTER COLUMN "status" SET DEFAULT 'AcatReceived'::"AcatStatus_new";

-- Drop old enum and rename new one
DROP TYPE "AcatStatus";
ALTER TYPE "AcatStatus_new" RENAME TO "AcatStatus";
