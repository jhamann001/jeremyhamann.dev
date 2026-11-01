-- Up Migration
--
-- Funds (ETFs / mutual funds) don't fit GICS/SIC — a basket isn't one company.
-- We classify them on a different axis: the asset-class CATEGORY (Yahoo's
-- Morningstar `fundProfile.categoryName`, e.g. "Foreign Large Blend",
-- "Intermediate Government"). Individual equities keep `sector`; funds use
-- `category`. `instrument_kind` records what Yahoo says the security is so the
-- drift run can route + display the right axis.
--
-- Populated out-of-band by backfillYahooSectors.ts; the nightly run only READS.

ALTER TABLE security_sector
    ADD COLUMN IF NOT EXISTS category        TEXT,   -- raw Yahoo/Morningstar fund category (NULL for single stocks)
    ADD COLUMN IF NOT EXISTS asset_class      TEXT,  -- our rolled-up bucket (e.g. 'Intl Equity', 'US Bond')
    ADD COLUMN IF NOT EXISTS instrument_kind  TEXT;  -- 'equity' | 'etf' | 'mutualfund' | 'other'

-- Look up classified funds by asset class for the drift rollup.
CREATE INDEX IF NOT EXISTS idx_security_sector_asset_class
    ON security_sector (asset_class)
    WHERE asset_class IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_security_sector_asset_class;
ALTER TABLE security_sector
    DROP COLUMN IF EXISTS category,
    DROP COLUMN IF EXISTS asset_class,
    DROP COLUMN IF EXISTS instrument_kind;
