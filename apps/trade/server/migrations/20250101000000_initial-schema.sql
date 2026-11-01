-- Up Migration

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    google_id       VARCHAR(255) UNIQUE,
    email           VARCHAR(255) UNIQUE NOT NULL,
    name            VARCHAR(255) NOT NULL,
    picture         TEXT,
    role            VARCHAR(50) CHECK (role IN ('advisor', 'trader')) NOT NULL DEFAULT 'advisor',
    slack_user_id   VARCHAR(50),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_login      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session (
    sid     VARCHAR NOT NULL COLLATE "default",
    sess    JSON NOT NULL,
    expire  TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);

CREATE TABLE IF NOT EXISTS clients (
    id              VARCHAR(50) PRIMARY KEY,
    name            VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       VARCHAR(50) NOT NULL REFERENCES clients(id),
    account_number  VARCHAR(100) UNIQUE NOT NULL,
    account_type    VARCHAR(50) CHECK (account_type IN ('Taxable', 'Traditional IRA', 'Roth IRA')) NOT NULL,
    balance         DECIMAL(15, 2) NOT NULL DEFAULT 0,
    cash_holding    DECIMAL(15, 2) NOT NULL DEFAULT 0,
    fixed_holding   DECIMAL(15, 2) NOT NULL DEFAULT 0,
    equity_holding  DECIMAL(15, 2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trade_requests (
    id                    VARCHAR(50) PRIMARY KEY,
    client_id             VARCHAR(50) NOT NULL REFERENCES clients(id),
    advisor_id            UUID REFERENCES users(id),
    trade_type            VARCHAR(100) NOT NULL
        CHECK (trade_type IN ('Initial Funding', 'Rebalance', 'Cash Deposit', 'Raise Cash', 'Liquidate')),
    trade_amount          VARCHAR(100),
    deposit_account       VARCHAR(100),
    rebalance_all         BOOLEAN NOT NULL DEFAULT false,
    status                VARCHAR(100) NOT NULL DEFAULT 'Pending Review'
        CHECK (status IN ('Pending Review', 'Needs Info', 'Pending Current Asset Liquidation', 'Approved', 'Rejected', 'Completed')),
    total_value           DECIMAL(15, 2),
    selected_accounts     TEXT[] NOT NULL DEFAULT '{}',
    priority              VARCHAR(20)
        CHECK (priority IN ('Urgent', 'Standard', 'Low')),
    advisor_notes         TEXT,
    residence             VARCHAR(50),
    liquidation_approval  BOOLEAN,
    advisor_exclusions    TEXT,
    client_exclusions     TEXT,
    esg_filters           JSONB,
    risk_profile          INTEGER,
    base_allocation       JSONB,
    equity_strategies     JSONB,
    raise_cash_reason     TEXT,
    liquidity_deadline    DATE,
    liquidate_option      VARCHAR(50),
    liquidate_positions   TEXT,
    execution_plan        JSONB,
    created_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id      VARCHAR(50) NOT NULL REFERENCES trade_requests(id) ON DELETE CASCADE,
    user_name       VARCHAR(255) NOT NULL,
    action          VARCHAR(255) NOT NULL,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounts_client      ON accounts(client_id);
CREATE INDEX IF NOT EXISTS idx_requests_client      ON trade_requests(client_id);
CREATE INDEX IF NOT EXISTS idx_requests_advisor     ON trade_requests(advisor_id);
CREATE INDEX IF NOT EXISTS idx_requests_status      ON trade_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_created     ON trade_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_request        ON audit_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_created        ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_id      ON users(google_id);

-- Down Migration

DROP INDEX IF EXISTS idx_users_google_id;
DROP INDEX IF EXISTS idx_users_email;
DROP INDEX IF EXISTS idx_audit_created;
DROP INDEX IF EXISTS idx_audit_request;
DROP INDEX IF EXISTS idx_requests_created;
DROP INDEX IF EXISTS idx_requests_status;
DROP INDEX IF EXISTS idx_requests_advisor;
DROP INDEX IF EXISTS idx_requests_client;
DROP INDEX IF EXISTS idx_accounts_client;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS trade_requests;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS clients;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS users;
