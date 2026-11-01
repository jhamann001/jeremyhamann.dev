-- Add structured contacts without changing existing email addresses.
CREATE TYPE "CustodianContactMethod" AS ENUM ('EMAIL', 'PHONE', 'PORTAL', 'OTHER');

ALTER TABLE "Custodian"
ADD COLUMN "contactMethod" "CustodianContactMethod",
ADD COLUMN "contactDetails" TEXT;
