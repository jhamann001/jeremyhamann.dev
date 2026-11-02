-- Add DRS without rewriting existing transfer or funding-plan approval rows.
-- UI ordering is controlled by FUNDING_TYPES, independently of enum sort order.
-- Rollback after DRS is saved must retain application read support and this enum
-- value; disable new selections instead. See the DRS session note for details.
ALTER TYPE "app"."FundingType" ADD VALUE 'DRS';
