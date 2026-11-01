-- Up Migration
--
-- Cached security → sector master for the drift sector-analysis layer. Keyed by
-- NORMALIZED ticker (e.g. Apex "BRKB" → "BRK.B"). Populated out-of-band by
-- `server/scripts/backfillSecuritySectors.ts` (throttled, resumable) — the
-- nightly drift run only READS this table, never calls the classification API.
--
-- `resolved` distinguishes "classified" from "attempted but no sector found" so
-- the backfill is resumable (skip resolved; retry unresolved up to a cap).

CREATE TABLE IF NOT EXISTS security_sector (
    ticker            TEXT PRIMARY KEY,                 -- normalized ticker (join key)
    source_symbol     TEXT,                             -- original Apex symbol (e.g. BRKB)
    name              TEXT,
    sic_code          TEXT,
    sic_description   TEXT,
    sector            TEXT,                             -- GICS-style sector, or NULL when unresolved
    source            TEXT NOT NULL,                    -- 'massive' | 'meridian' | 'warehouse' | 'manual'
    resolved          BOOLEAN NOT NULL DEFAULT false,   -- true once a sector is assigned
    attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_attempt_at   TIMESTAMPTZ,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Find still-unresolved tickers quickly when resuming a backfill.
CREATE INDEX IF NOT EXISTS idx_security_sector_unresolved
    ON security_sector (resolved, attempts);

-- Down Migration

DROP TABLE IF EXISTS security_sector;
