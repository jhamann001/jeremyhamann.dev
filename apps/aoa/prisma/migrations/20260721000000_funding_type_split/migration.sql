-- Always-On Advice — ticket: split the ACAT funding rail into Full/Partial +
-- add a Manual Transfer rail. Follows the 20260717000000_transfer_deal_sourced
-- unqualified type-name idiom (CREATE TYPE "FundingType" ...).
--
-- RENAME keeps position 1, so existing funding_type='ACAT' rows become
-- 'ACAT_FULL' in place (no data UPDATE, no leftover value to drop). ADD VALUE
-- ... AFTER pins the physical order to match prisma/schema.prisma (avoids a
-- Prisma reorder diff). RENAME VALUE and ADD VALUE are transaction-safe on PG16
-- because the added values are not consumed in this same transaction.
ALTER TYPE "FundingType" RENAME VALUE 'ACAT' TO 'ACAT_FULL';
ALTER TYPE "FundingType" ADD VALUE 'ACAT_PARTIAL' AFTER 'ACAT_FULL';
ALTER TYPE "FundingType" ADD VALUE 'MANUAL' AFTER 'ACH';
