-- Keep Victory Funds transfer execution on the Apex MF Ops ticket that was
-- opened to generate the LOA. This also records the last-successful omnibus
-- value as historical context, not a value that can be reused without review.
UPDATE "Custodian"
SET "watchouts" = $watchouts$
• Liquidate only: do not request an in-kind transfer. Select Liquidate for every fund and expect proceeds by check.
  • Set timeline expectations up front: this firm is slow to process transfers.
  • Confirm the receiving/house number with Operations before each transfer; it has changed before.
$watchouts$
WHERE LOWER("name") = LOWER('Victory Funds');
