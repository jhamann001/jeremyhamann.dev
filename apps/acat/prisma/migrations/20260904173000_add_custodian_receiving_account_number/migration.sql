-- Store the last-known receiving/omnibus account separately from free-text
-- watchouts so transfer forms can use it without parsing operational notes.
ALTER TABLE "Custodian" ADD COLUMN "receivingAccountNumber" TEXT;

UPDATE "Custodian"
SET
  "receivingAccountNumber" = 'DEMOOMNI01',
  "watchouts" = REPLACE(
    "watchouts",
    'The last successful receiving/house number was DEMOOMNI01',
    'The receiving/house number stored in the Custodian Library is the last successful value'
  )
WHERE LOWER("name") = LOWER('Victory Funds');
