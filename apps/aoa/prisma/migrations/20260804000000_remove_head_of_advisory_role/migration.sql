-- Retire HEAD_OF_ADVISORY as an application role. Okta already maps the
-- corresponding group to OPERATIONS; this migration makes stored identities
-- and the database enum agree with that runtime contract.
--
-- PostgreSQL cannot drop an enum value in place, so the safe sequence is:
-- convert data, remove the dependent default, rebuild the type, restore the
-- default, and only then drop the legacy type. Historical migrations remain
-- immutable.

BEGIN;

UPDATE "app"."User"
SET "role" = 'OPERATIONS'
WHERE "role" = 'HEAD_OF_ADVISORY';

ALTER TABLE "app"."User"
  ALTER COLUMN "role" DROP DEFAULT;

ALTER TYPE "app"."Role"
  RENAME TO "Role_with_head_of_advisory";

CREATE TYPE "app"."Role" AS ENUM (
  'ADMIN',
  'OPERATIONS',
  'ADVISOR',
  'CLIENT_SERVICE',
  'VIEWER'
);

ALTER TABLE "app"."User"
  ALTER COLUMN "role" TYPE "app"."Role"
  USING ("role"::text::"app"."Role");

ALTER TABLE "app"."User"
  ALTER COLUMN "role" SET DEFAULT 'VIEWER'::"app"."Role";

DROP TYPE "app"."Role_with_head_of_advisory";

COMMIT;
