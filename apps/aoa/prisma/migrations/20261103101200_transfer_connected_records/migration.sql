-- ticket: connect transfers to existing AOA records. The delivering firm is a
-- custodian profile, and a fee reimbursement names the Operations fee request
-- it settles. Both columns are nullable, forward-only and inherit the existing
-- FORCE RLS policies of app.transfer and app.transfer_fee_reimbursement (no
-- DELETE grant on either). Rows recorded before this migration keep NULL.

ALTER TABLE "app"."transfer"
  ADD COLUMN "delivering_custodian_id" text;

ALTER TABLE "app"."transfer"
  ADD CONSTRAINT "transfer_delivering_custodian_id_fkey"
    FOREIGN KEY ("delivering_custodian_id") REFERENCES "app"."custodian_profile"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "transfer_delivering_custodian_id_idx"
  ON "app"."transfer"("delivering_custodian_id");

ALTER TABLE "app"."transfer_fee_reimbursement"
  ADD COLUMN "operations_fee_request_id" text;

ALTER TABLE "app"."transfer_fee_reimbursement"
  ADD CONSTRAINT "transfer_fee_reimbursement_operations_fee_request_id_fkey"
    FOREIGN KEY ("operations_fee_request_id") REFERENCES "app"."operations_fee_request"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "transfer_fee_reimbursement_operations_fee_request_id_idx"
  ON "app"."transfer_fee_reimbursement"("operations_fee_request_id");
