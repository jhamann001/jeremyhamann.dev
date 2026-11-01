ALTER TABLE "AcatRecord"
  ADD COLUMN "feeApexTicket" TEXT,
  ADD COLUMN "feeCreditRequestId" TEXT,
  ADD COLUMN "tradeInstructions" TEXT;

-- Full outgoing ACATs are charged and automatically reimbursed at Apex, but
-- Ops still needs every instance in the accountability queue. Preserve any
-- explicit historical value and fill only missing answers.
UPDATE "AcatRecord"
SET "feeCharged" = 'Yes'
WHERE LOWER(COALESCE("direction", '')) = 'out'
  AND LOWER(COALESCE("type", '')) = 'full'
  AND ("feeCharged" IS NULL OR BTRIM("feeCharged") = '');

-- Existing outgoing transfers should enter residual monitoring without
-- overwriting follow-up decisions already recorded by Ops.
UPDATE "AcatRecord"
SET "residualMonitoringRequired" = true,
    "residualFollowUpDate" = COALESCE(
      NULLIF(BTRIM("residualFollowUpDate"), ''),
      (CURRENT_DATE + INTERVAL '7 days')::date::text
    )
WHERE LOWER(COALESCE("direction", '')) = 'out'
  AND LOWER(COALESCE("type", '')) <> 'residual credit';
