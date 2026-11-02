-- Keep the production Salesforce identifier boundary while allowing the
-- deliberately namespaced, fixed development fixtures that are revalidated
-- against mirror.client inside the scoped request transaction.

BEGIN;

ALTER TABLE "app"."operations_fee_request"
  DROP CONSTRAINT "operations_fee_request_client_check",
  ADD CONSTRAINT "operations_fee_request_client_check" CHECK (
    "client_sf_id" ~ '^[[:alnum:]]{15,18}$'
    OR "client_sf_id" ~ '^DEV-[A-Z0-9]+(-[A-Z0-9]+)*$'
  );

COMMIT;
