-- Up Migration
--
-- Per-day counts of asset location engine use by caller class (ticket). Read by
-- GET /api/machine/engine-use. counting_started and plan_generation_off_since are
-- written by the service at start-up, not here, so a day only counts once code that
-- records every call was serving it.

CREATE TABLE IF NOT EXISTS engine_use_daily (
    day          DATE        NOT NULL,
    caller_class TEXT        NOT NULL CHECK (caller_class IN ('mcp', 'service')),
    outcome      TEXT        NOT NULL CHECK (outcome IN ('ran', 'refused')),
    count        INTEGER     NOT NULL DEFAULT 0 CHECK (count >= 0),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day, caller_class, outcome)
);

CREATE TABLE IF NOT EXISTS engine_use_meta (
    id                        BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    counting_started          DATE NOT NULL,
    plan_generation_off_since DATE
);

-- Down Migration

DROP TABLE IF EXISTS engine_use_meta;
DROP TABLE IF EXISTS engine_use_daily;
