-- ticket: roster change log and access-reconciliation ledger for the Trade Request backend move.
-- member_user_id has no foreign key: tables outside the ticket catalog never reference catalog tables.
BEGIN;

CREATE TABLE trade_request.roster_changes (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_aoa_user_id TEXT NOT NULL,
    action            TEXT NOT NULL CHECK (action IN ('add', 'remove', 'slack')),
    member_user_id    UUID NOT NULL,
    before_state      JSONB NOT NULL,
    after_state       JSONB NOT NULL
);
CREATE INDEX roster_changes_at_idx ON trade_request.roster_changes (at DESC);

CREATE TABLE trade_request.reconciliation_runs (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verdict TEXT NOT NULL CHECK (verdict IN ('passed', 'failed')),
    counts  JSONB NOT NULL
);
CREATE INDEX reconciliation_runs_at_idx ON trade_request.reconciliation_runs (at DESC);

GRANT SELECT, INSERT ON trade_request.roster_changes TO app_rw;
GRANT SELECT ON trade_request.reconciliation_runs TO app_rw;

COMMIT;
