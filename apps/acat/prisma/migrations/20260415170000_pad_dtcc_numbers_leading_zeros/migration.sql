-- Pad dtccNumber to 4 digits with leading zeros to match DTCC participant number format
UPDATE "AcatRecord"
SET "dtccNumber" = LPAD("dtccNumber", 4, '0')
WHERE "dtccNumber" IS NOT NULL
  AND LENGTH("dtccNumber") < 4;
