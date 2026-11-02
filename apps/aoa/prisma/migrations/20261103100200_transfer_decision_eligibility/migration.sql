-- ATW-03 (ticket): holding eligibility on the existing decision child.
-- Additive only; app.transfer_decision keeps its RLS policies and grants (no
-- DELETE). approveFundingPlan fills the columns from the asset-map status.

ALTER TABLE app.transfer_decision
  ADD COLUMN cannot_transfer_in_kind boolean NOT NULL DEFAULT false,
  ADD COLUMN ineligible boolean NOT NULL DEFAULT false,
  ADD COLUMN liquidation_instruction boolean NOT NULL DEFAULT false;
