-- Convert `statementAmount` from a String? holding "$X,XXX.XX" labels into
-- an Int? holding the value in cents, and drop the redundant
-- `totalExpectedValue` Float column.
--
-- Historically the records page surfaced an "AUM" column from
-- `totalExpectedValue` (Float, seeded once from migration data, never
-- writable via the UI), and a separate string "Statement Amount" column
-- that operators actually maintained. Audit confirmed every existing row
-- has `statementAmount` matching `totalExpectedValue` exactly, so we can
-- collapse to a single numeric source: `statementAmount` in cents.
--
-- The USING clause strips "$" and "," from the existing text, parses to
-- numeric, scales by 100, rounds, and casts to integer. All 517
-- production rows parse cleanly today; nulls remain null.

ALTER TABLE "AcatRecord"
  ALTER COLUMN "statementAmount" TYPE INTEGER
  USING ROUND(NULLIF(REGEXP_REPLACE("statementAmount", '[\$,\s]', '', 'g'), '')::numeric * 100)::integer;

ALTER TABLE "AcatRecord" DROP COLUMN IF EXISTS "totalExpectedValue";
