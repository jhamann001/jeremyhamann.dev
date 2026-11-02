-- ticket: the statement-pipeline tables move into AoA's database, in their own schema.
-- Shape mirrors statement-pipeline main a81efff: db.py _TABLES_SQL plus the
-- _MIGRATION_SQL columns, _VIEWS_SQL, and client_linking/schema.py SCHEMA_SQL.
-- Every table stays empty here. The cutover copy brings every row, including
-- client_link_schema's version row, and refuses to run into a non-empty table.
-- statement_pipeline_rw is a Terraform-managed login on Cloud SQL (google_sql_user);
-- the guard fails closed there and creates the role only on local/CI Postgres.
BEGIN;

-- guard:begin
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'statement_pipeline_rw') THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser') THEN
      RAISE EXCEPTION 'statement_pipeline_rw must be provisioned by Terraform before the statement_pipeline schema migration';
    END IF;
    CREATE ROLE statement_pipeline_rw LOGIN;
  END IF;
END $$;
-- guard:end

CREATE SCHEMA statement_pipeline;

CREATE TABLE statement_pipeline.households (
    id               UUID PRIMARY KEY,
    client_name      TEXT NOT NULL,
    processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_folder_id TEXT,
    total_value      NUMERIC(15,2),
    docs_total       INTEGER DEFAULT 0,
    docs_extracted   INTEGER DEFAULT 0,
    doc_results      JSONB DEFAULT '[]'::jsonb,
    superseded_by    UUID,
    run_number       INTEGER DEFAULT 1,
    reviewed_at      TIMESTAMPTZ,
    reviewed_by      TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cedar_ridge_user_id TEXT
);

CREATE TABLE statement_pipeline.accounts (
    id                    UUID PRIMARY KEY,
    household_id          UUID NOT NULL REFERENCES statement_pipeline.households(id) ON DELETE CASCADE,
    custodian             TEXT,
    account_type          TEXT,
    account_type_raw      TEXT,
    account_type_other    TEXT,
    account_number        TEXT,
    investor_number       TEXT,
    account_registration  TEXT,
    account_holder        TEXT,
    statement_date        TEXT,
    statement_age_days    INTEGER,
    is_stale              BOOLEAN NOT NULL DEFAULT FALSE,
    cash_balance          NUMERIC(15,2),
    total_value           NUMERIC(15,2),
    cost_basis_status     TEXT,
    is_rollover           BOOLEAN NOT NULL DEFAULT FALSE,
    rollover_note         TEXT,
    is_inherited          BOOLEAN NOT NULL DEFAULT FALSE,
    inherited_note        TEXT,
    apex_restriction      TEXT,
    apex_special_handling TEXT,
    custodian_intel       JSONB,
    validation_status     TEXT DEFAULT 'VALID',
    validation_issues     JSONB DEFAULT '[]'::jsonb,
    deleted_at            TIMESTAMPTZ,
    deleted_by            TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    account_type_overridden_by TEXT,
    account_type_overridden_at TIMESTAMPTZ
);

CREATE TABLE statement_pipeline.positions (
    id                         UUID PRIMARY KEY,
    account_id                 UUID NOT NULL REFERENCES statement_pipeline.accounts(id) ON DELETE CASCADE,
    symbol                     TEXT,
    description                TEXT,
    quantity                   NUMERIC(15,4),
    market_value               NUMERIC(15,2),
    cost_basis                 NUMERIC(15,2),
    cost_basis_granularity     TEXT,
    lots                       JSONB,
    asset_type                 TEXT,
    classification_source      TEXT,
    transfer_eligible          TEXT,
    transfer_notes             TEXT,
    original_transfer_eligible TEXT,
    notion_check               JSONB,
    override_status            TEXT,
    override_notes             TEXT,
    overridden_by              TEXT,
    overridden_at              TIMESTAMPTZ,
    transferring               TEXT,
    transferring_by            TEXT,
    transferring_at            TIMESTAMPTZ,
    deleted_at                 TIMESTAMPTZ,
    deleted_by                 TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE statement_pipeline.users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT NOT NULL UNIQUE,
    role       TEXT NOT NULL DEFAULT 'advisor' CHECK (role IN ('ops', 'advisor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE statement_pipeline.mcp_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   TEXT NOT NULL UNIQUE,
    user_email   TEXT NOT NULL REFERENCES statement_pipeline.users(email) ON DELETE CASCADE ON UPDATE CASCADE,
    description  TEXT,
    last4        TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_by   TEXT
);

CREATE TABLE statement_pipeline.target_accounts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_folder_id     TEXT NOT NULL,
    owner                TEXT,
    target_account_type  TEXT,
    existing_apex_number TEXT,
    needs_to_be_opened   BOOLEAN NOT NULL DEFAULT TRUE,
    created_by           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE statement_pipeline.source_account_links (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_folder_id      TEXT NOT NULL,
    source_custodian      TEXT,
    source_account_number TEXT,
    target_account_id     UUID NOT NULL REFERENCES statement_pipeline.target_accounts(id) ON DELETE CASCADE,
    created_by            TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE statement_pipeline.active_accounts_roster (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    household          TEXT,
    owner              TEXT,
    owner_norm         TEXT,
    account_type       TEXT,
    type_norm          TEXT,
    account_title_raw  TEXT,
    trading_account_no TEXT,
    apex_number        TEXT,
    total_value        NUMERIC(15,2),
    loaded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE statement_pipeline.client_link_schema (version INTEGER PRIMARY KEY);

CREATE TABLE statement_pipeline.client_link_decisions (
    id UUID PRIMARY KEY, identity JSONB NOT NULL,
    actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE statement_pipeline.client_folder_links (
    source_system TEXT NOT NULL, source_folder_id TEXT NOT NULL,
    decision_id UUID REFERENCES statement_pipeline.client_link_decisions(id),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    reuse_future BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (source_system, source_folder_id)
);

CREATE TABLE statement_pipeline.client_run_links (
    run_id UUID PRIMARY KEY REFERENCES statement_pipeline.households(id) ON DELETE RESTRICT,
    decision_id UUID REFERENCES statement_pipeline.client_link_decisions(id),
    identity_version BIGINT NOT NULL DEFAULT 0 CHECK (identity_version >= 0),
    method TEXT, conflict_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    lookup JSONB NOT NULL DEFAULT '{}'::jsonb,
    latest_attempt UUID
);

CREATE TABLE statement_pipeline.client_directory_cache (
    snapshot_version TEXT PRIMARY KEY, fetched_at TIMESTAMPTZ NOT NULL,
    snapshot JSONB NOT NULL
);

CREATE TABLE statement_pipeline.client_link_batches (
    id UUID PRIMARY KEY, preview JSONB NOT NULL, guards JSONB NOT NULL,
    actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    idempotency_key TEXT UNIQUE, result JSONB
);

CREATE TABLE statement_pipeline.client_link_events (
    id UUID PRIMARY KEY, run_id UUID, scope_key TEXT,
    batch_id UUID REFERENCES statement_pipeline.client_link_batches(id),
    kind TEXT NOT NULL, actor TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
    reason TEXT, before_state JSONB NOT NULL, after_state JSONB NOT NULL
);

CREATE INDEX idx_accounts_household ON statement_pipeline.accounts(household_id);
CREATE INDEX idx_positions_account ON statement_pipeline.positions(account_id);
CREATE INDEX idx_households_source ON statement_pipeline.households(source_folder_id);
CREATE INDEX idx_mcp_tokens_user_email ON statement_pipeline.mcp_tokens(user_email);
CREATE INDEX idx_target_accounts_client ON statement_pipeline.target_accounts(source_folder_id);
CREATE INDEX idx_source_links_client ON statement_pipeline.source_account_links(source_folder_id);
CREATE INDEX idx_source_links_target ON statement_pipeline.source_account_links(target_account_id);
CREATE INDEX idx_roster_match ON statement_pipeline.active_accounts_roster(owner_norm, type_norm);
CREATE INDEX idx_households_cedar_ridge_user ON statement_pipeline.households(cedar_ridge_user_id);
CREATE INDEX idx_client_directory_fetched ON statement_pipeline.client_directory_cache(fetched_at DESC);
CREATE INDEX idx_client_link_events_run ON statement_pipeline.client_link_events(run_id, occurred_at DESC);

CREATE VIEW statement_pipeline.positions_effective AS
SELECT
    p.*,
    COALESCE(p.override_status, p.transfer_eligible) AS effective_status,
    COALESCE(p.override_notes, p.transfer_notes)     AS effective_notes
FROM statement_pipeline.positions p
WHERE p.deleted_at IS NULL;

CREATE VIEW statement_pipeline.household_summary AS
SELECT
    h.id,
    h.client_name,
    h.processed_at,
    h.total_value,
    h.docs_total,
    h.docs_extracted,
    h.run_number,
    h.superseded_by,
    COUNT(DISTINCT a.id) AS total_accounts,
    COUNT(pe.id)         AS total_positions,
    COUNT(CASE WHEN pe.effective_status = 'ACAT'        THEN 1 END) AS acat_count,
    COUNT(CASE WHEN pe.effective_status = 'LIQUIDATE'   THEN 1 END) AS liquidate_count,
    COUNT(CASE WHEN pe.effective_status = 'UNSUPPORTED' THEN 1 END) AS unsupported_count,
    COUNT(CASE WHEN pe.effective_status = 'REVIEW'      THEN 1 END) AS review_count,
    COUNT(CASE WHEN pe.effective_status = 'ACH/WIRE'    THEN 1 END) AS transfer_count
FROM statement_pipeline.households h
LEFT JOIN statement_pipeline.accounts a ON a.household_id = h.id AND a.deleted_at IS NULL
LEFT JOIN statement_pipeline.positions_effective pe ON pe.account_id = a.id
GROUP BY h.id, h.client_name, h.processed_at, h.total_value,
         h.docs_total, h.docs_extracted, h.run_number, h.superseded_by;

CREATE FUNCTION statement_pipeline.client_link_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Client identity decisions and events are immutable';
END; $$;

CREATE TRIGGER client_link_decisions_immutable BEFORE UPDATE OR DELETE ON statement_pipeline.client_link_decisions
FOR EACH ROW EXECUTE FUNCTION statement_pipeline.client_link_immutable();
CREATE TRIGGER client_link_events_immutable BEFORE UPDATE OR DELETE ON statement_pipeline.client_link_events
FOR EACH ROW EXECUTE FUNCTION statement_pipeline.client_link_immutable();

-- statement_pipeline_rw: read/write on the 15 tables, read-only on the 2 views,
-- TRUNCATE only where db.load_active_accounts_roster needs it. Nothing on
-- app, audit or mirror; no default privileges; no other role gains anything.
GRANT USAGE ON SCHEMA statement_pipeline TO statement_pipeline_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    statement_pipeline.households,
    statement_pipeline.accounts,
    statement_pipeline.positions,
    statement_pipeline.users,
    statement_pipeline.mcp_tokens,
    statement_pipeline.target_accounts,
    statement_pipeline.source_account_links,
    statement_pipeline.active_accounts_roster,
    statement_pipeline.client_link_schema,
    statement_pipeline.client_link_decisions,
    statement_pipeline.client_folder_links,
    statement_pipeline.client_run_links,
    statement_pipeline.client_directory_cache,
    statement_pipeline.client_link_batches,
    statement_pipeline.client_link_events
  TO statement_pipeline_rw;
GRANT TRUNCATE ON statement_pipeline.active_accounts_roster TO statement_pipeline_rw;
GRANT SELECT ON statement_pipeline.positions_effective, statement_pipeline.household_summary TO statement_pipeline_rw;

COMMIT;
