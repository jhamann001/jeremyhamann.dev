-- Rename existing accountType values to match the new canonical dropdown
-- list. Ambiguous or unsupported types ("Inherited IRA" without a tax type,
-- "Trust", "Corporate") are nulled so an operator picks the right value on
-- next edit.
UPDATE "AcatRecord" SET "accountType" = 'Brokerage / Individual'
  WHERE "accountType" = 'Individual';

UPDATE "AcatRecord" SET "accountType" = 'Traditional IRA'
  WHERE "accountType" = 'IRA';

UPDATE "AcatRecord" SET "accountType" = 'Joint Account (JTWROS - Rights of Survivorship)'
  WHERE "accountType" = 'Joint';

UPDATE "AcatRecord" SET "accountType" = 'Inherited Traditional IRA (w/ beneficiaries)'
  WHERE "accountType" = 'Inherited Traditional IRA';

UPDATE "AcatRecord" SET "accountType" = NULL
  WHERE "accountType" IN ('Inherited IRA', 'Trust', 'Corporate');

-- Drop the redundant assignedTo column — it always shadowed wealthAdvisor
-- and was never edited independently in the UI.
ALTER TABLE "AcatRecord" DROP COLUMN "assignedTo";
