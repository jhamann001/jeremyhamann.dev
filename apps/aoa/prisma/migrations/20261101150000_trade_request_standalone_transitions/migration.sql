-- ticket: the levers the cutover controller turns on the standalone Trade Request service (mode and sender
-- switches). They live apart from trade_request.serving_state_transitions because the copy engine reads every row
-- of that table as a change of AOA's serving state: a standalone freeze logged there would refuse the cutover's own
-- change copy. Written only by lib/trade-requests/serving-state-admin.ts over the owner connection.
BEGIN;

CREATE TABLE trade_request.standalone_transitions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor      TEXT NOT NULL,
    from_state JSONB NOT NULL,
    to_state   JSONB NOT NULL,
    reason     TEXT NOT NULL
);
CREATE INDEX standalone_transitions_at_idx ON trade_request.standalone_transitions (at DESC);

GRANT SELECT ON trade_request.standalone_transitions TO app_rw;

COMMIT;
