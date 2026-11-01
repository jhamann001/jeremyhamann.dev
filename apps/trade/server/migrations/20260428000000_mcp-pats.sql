-- Up Migration

-- Personal Access Tokens for the MCP server. Generated from the SPA's
-- "Connected Apps → API tokens" UI and pasted into clients (e.g. Claude
-- Desktop) that don't speak the OAuth 2.1 / DCR flow.
--
-- Cleartext tokens have the format `tr_pat_<base64url(32 random bytes)>` and
-- are only ever returned in the response body of POST /api/me/mcp-tokens —
-- never logged, never returned by GET /api/me/mcp-tokens. Stored as a
-- SHA-256 hash, same as the OAuth access tokens.
CREATE TABLE IF NOT EXISTS mcp_pats (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    BYTEA UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    audience      TEXT NOT NULL,
    last_used_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_pats_user_id_idx ON mcp_pats (user_id);

-- Down Migration

DROP TABLE IF EXISTS mcp_pats;
