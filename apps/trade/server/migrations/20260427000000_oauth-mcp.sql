-- Up Migration

-- OAuth 2.1 storage for the read-only MCP server.
-- The MCP server is both Resource Server and Authorization Server (Google
-- doesn't support Dynamic Client Registration which the MCP spec requires).
-- Tokens are opaque random 256-bit values stored hashed (SHA-256) so they
-- cannot be reused if the DB is compromised. Each token row records the
-- audience to enforce RFC 8707 resource-indicator binding on every /mcp call.

-- Registered MCP clients (Claude Desktop, Claude Code, MCP Inspector, etc.).
-- Created via the RFC 7591 Dynamic Client Registration endpoint.
CREATE TABLE IF NOT EXISTS oauth_clients (
    id                  TEXT PRIMARY KEY,
    client_secret_hash  BYTEA,
    redirect_uris       TEXT[] NOT NULL,
    client_name         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by_ip       INET
);

-- Pending authorization requests held while the user is in the Google OAuth
-- flow. Keyed by signed `state` parameter. Short TTL (10 min). Deleted on
-- consume.
CREATE TABLE IF NOT EXISTS mcp_pending_auth (
    state           TEXT PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    redirect_uri    TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,
    resource        TEXT NOT NULL,
    scope           TEXT NOT NULL,
    mcp_state       TEXT,
    expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_pending_auth_expires_at_idx ON mcp_pending_auth (expires_at);

-- Authorization codes minted at the end of the Google flow. Single-use,
-- 30-second TTL, atomic consume via UPDATE ... WHERE consumed_at IS NULL.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    code_hash       BYTEA PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri    TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,
    resource        TEXT NOT NULL,
    scope           TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ
);

-- Bearer tokens presented on /mcp requests. Audience-bound (RFC 8707).
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    token_hash      BYTEA PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    audience        TEXT NOT NULL,
    scope           TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_user_id_idx ON oauth_access_tokens (user_id);

-- Refresh tokens. Rotated on every use. `family_id` groups all refresh tokens
-- descended from one authorization; if a refresh token is presented after it
-- has been rotated (`rotated_to IS NOT NULL`), the entire family is revoked
-- to defend against token theft.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token_hash      BYTEA PRIMARY KEY,
    family_id       UUID NOT NULL,
    client_id       TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    audience        TEXT NOT NULL,
    scope           TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    rotated_to      BYTEA,
    revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_family_id_idx ON oauth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_user_id_idx ON oauth_refresh_tokens (user_id);

-- Down Migration

DROP TABLE IF EXISTS oauth_refresh_tokens;
DROP TABLE IF EXISTS oauth_access_tokens;
DROP TABLE IF EXISTS oauth_authorization_codes;
DROP TABLE IF EXISTS mcp_pending_auth;
DROP TABLE IF EXISTS oauth_clients;
