"""
Statement Pipeline — Postgres Database Layer
========================================
Schema management, write operations (pipeline output), and read operations
(API queries) for the ACAT analysis results stored in Cloud SQL Postgres.

Tables:
  households  — one row per client folder processed
  accounts    — one row per brokerage account extracted
  positions   — one row per asset/position within an account
  outbox      — the demo's captured Slack posts and Drive saves (demo mode)

Views:
  positions_effective  — applies ops overrides via COALESCE
  household_summary    — aggregate counts per household
"""

import os
import re
import json
import logging
import threading
from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras
import psycopg2.pool
from account_resolution import AccountSelectionRequired, account_choices, resolve_account

ET = ZoneInfo("America/New_York")
log = logging.getLogger("statement-pipeline")

# ---------------------------------------------------------------------------
# Connection pool
# ---------------------------------------------------------------------------

_pool: Optional[psycopg2.pool.ThreadedConnectionPool] = None
# psycopg2's pool raises at once when every connection is out; this makes callers wait for one instead.
_pool_slots: Optional[threading.BoundedSemaphore] = None
POOL_WAIT_SECONDS = 15


class PoolBusy(RuntimeError):
    """Every pooled connection stayed in use for POOL_WAIT_SECONDS."""


def _get_iam_token() -> str:
    """Fetch a short-lived OAuth2 access token for Cloud SQL IAM auth."""
    import google.auth
    from google.auth.transport.requests import Request

    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    credentials, _ = google.auth.default(scopes=scopes)
    credentials.refresh(Request())
    return credentials.token


_SSLMODES = ("disable", "allow", "prefer", "require", "verify-ca", "verify-full")
_SCHEMA_IDENT = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def _conn_kwargs(prefix: str = "DB_") -> dict:
    """Build psycopg2 connection keyword arguments from environment.

    ``prefix`` selects the variable family: the service reads ``DB_*``.
    With no ``DB_HOST``, a ``DATABASE_URL`` connection string is used whole
    (the demo's hosted database is given that way).
    """
    def env(name: str, default: str = "") -> str:
        return os.getenv(prefix + name, default)

    url = os.getenv("DATABASE_URL", "").strip() if prefix == "DB_" else ""
    if url and not env("HOST"):
        return {"dsn": url}

    host = env("HOST", "127.0.0.1")
    port = env("PORT", "5432")
    dbname = env("NAME", "acat")
    user = env("USER", "statement_pipeline")
    iam_auth = env("IAM_AUTH").lower() in ("true", "1", "yes")

    if iam_auth:
        password = _get_iam_token()
        log.info("Using Cloud SQL IAM authentication for user %s", user)
    else:
        password = env("PASSWORD")

    if host.startswith("/"):
        kwargs = dict(dbname=dbname, user=user, password=password, host=host)
    else:
        kwargs = dict(host=host, port=port, dbname=dbname, user=user, password=password)

    sslmode = env("SSLMODE")
    if sslmode:
        if sslmode not in _SSLMODES:
            raise ValueError(f"{prefix}SSLMODE must be one of {', '.join(_SSLMODES)}")
        kwargs["sslmode"] = sslmode
    search_path = env("SEARCH_PATH")
    if search_path:
        if not _SCHEMA_IDENT.match(search_path):
            raise ValueError(f"{prefix}SEARCH_PATH must be one lowercase schema identifier")
        kwargs["options"] = f"-c search_path={search_path}"
    return kwargs


def schema_owner_external() -> bool:
    """True when another system owns the DDL (``DB_SCHEMA_OWNER=external``)."""
    return os.getenv("DB_SCHEMA_OWNER", "") == "external"


def init_pool(minconn: int = 2, maxconn: int = 10) -> None:
    """Initialize the thread-safe connection pool. Call once at app startup."""
    global _pool
    if _pool is not None:
        return
    global _pool_slots
    kwargs = _conn_kwargs()
    _pool = psycopg2.pool.ThreadedConnectionPool(minconn, maxconn, **kwargs)
    _pool_slots = threading.BoundedSemaphore(maxconn)
    log.info("Postgres connection pool initialized (min=%d, max=%d)", minconn, maxconn)


def get_connection():
    """
    Return a psycopg2 connection.

    Uses the pool if initialized (server mode), otherwise creates a
    standalone connection (pipeline / CLI mode).
    """
    if _pool is not None:
        if not _pool_slots.acquire(timeout=POOL_WAIT_SECONDS):
            raise PoolBusy("Every database connection is in use")
        try:
            return _live_pooled_connection()
        except BaseException:
            _pool_slots.release()
            raise
    return psycopg2.connect(**_conn_kwargs())


def _live_pooled_connection():
    """A pooled connection that still answers. A serverless database closes idle connections when it suspends,
    which the pool can't see until a query fails, so each checkout is pinged and a dead one replaced once."""
    conn = _pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
        conn.rollback()
        return conn
    except psycopg2.Error:
        _pool.putconn(conn, close=True)
        return _pool.getconn()


def put_connection(conn) -> None:
    """Return a connection to the pool, or close it if no pool is active.

    Always rolls back first so the next caller never inherits a dirty
    transaction (e.g. after an unhandled exception mid-query).
    """
    if _pool is not None:
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            _pool.putconn(conn)
        finally:
            _pool_slots.release()
    else:
        conn.close()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS households (
    id              UUID PRIMARY KEY,
    client_name     TEXT NOT NULL,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_folder_id TEXT,
    total_value     NUMERIC(15,2),
    docs_total      INTEGER DEFAULT 0,
    docs_extracted  INTEGER DEFAULT 0,
    doc_results     JSONB DEFAULT '[]'::jsonb,
    superseded_by   UUID,
    run_number      INTEGER DEFAULT 1,
    reviewed_at     TIMESTAMPTZ,
    reviewed_by     TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounts (
    id                  UUID PRIMARY KEY,
    household_id        UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    custodian           TEXT,
    account_type        TEXT,
    account_type_raw    TEXT,
    account_type_other  TEXT,
    account_number      TEXT,
    investor_number     TEXT,
    account_registration TEXT,
    account_holder      TEXT,
    statement_date      TEXT,
    statement_age_days  INTEGER,
    is_stale            BOOLEAN NOT NULL DEFAULT FALSE,
    cash_balance        NUMERIC(15,2),
    total_value         NUMERIC(15,2),
    cost_basis_status   TEXT,
    is_rollover         BOOLEAN NOT NULL DEFAULT FALSE,
    rollover_note       TEXT,
    is_inherited        BOOLEAN NOT NULL DEFAULT FALSE,
    inherited_note      TEXT,
    apex_restriction    TEXT,
    apex_special_handling TEXT,
    custodian_intel     JSONB,
    validation_status   TEXT DEFAULT 'VALID',
    validation_issues   JSONB DEFAULT '[]'::jsonb,
    deleted_at          TIMESTAMPTZ,
    deleted_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS positions (
    id                      UUID PRIMARY KEY,
    account_id              UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    symbol                  TEXT,
    description             TEXT,
    quantity                NUMERIC(15,4),
    market_value            NUMERIC(15,2),
    cost_basis              NUMERIC(15,2),
    cost_basis_granularity  TEXT,
    lots                    JSONB,
    asset_type              TEXT,
    classification_source   TEXT,
    transfer_eligible       TEXT,
    transfer_notes          TEXT,
    original_transfer_eligible TEXT,
    notion_check            JSONB,
    override_status         TEXT,
    override_notes          TEXT,
    overridden_by           TEXT,
    overridden_at           TIMESTAMPTZ,
    transferring            TEXT,
    transferring_by         TEXT,
    transferring_at         TIMESTAMPTZ,
    deleted_at              TIMESTAMPTZ,
    deleted_by              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT NOT NULL UNIQUE,
    role       TEXT NOT NULL DEFAULT 'advisor' CHECK (role IN ('ops', 'advisor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The demo's Outbox: Slack posts and Drive saves captured instead of sent (demo mode only).
CREATE TABLE IF NOT EXISTS outbox (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind       TEXT NOT NULL CHECK (kind IN ('slack', 'drive')),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON outbox (created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   TEXT NOT NULL UNIQUE,
    user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE ON UPDATE CASCADE,
    description  TEXT,
    last4        TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_by   TEXT
);

CREATE TABLE IF NOT EXISTS target_accounts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_folder_id    TEXT NOT NULL,
    owner               TEXT,
    target_account_type TEXT,
    existing_apex_number TEXT,
    needs_to_be_opened  BOOLEAN NOT NULL DEFAULT TRUE,
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_account_links (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_folder_id      TEXT NOT NULL,
    source_custodian      TEXT,
    source_account_number TEXT,
    target_account_id     UUID NOT NULL REFERENCES target_accounts(id) ON DELETE CASCADE,
    created_by            TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS active_accounts_roster (
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

CREATE INDEX IF NOT EXISTS idx_accounts_household ON accounts(household_id);
CREATE INDEX IF NOT EXISTS idx_positions_account ON positions(account_id);
CREATE INDEX IF NOT EXISTS idx_households_source ON households(source_folder_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user_email ON mcp_tokens(user_email);
CREATE INDEX IF NOT EXISTS idx_target_accounts_client ON target_accounts(source_folder_id);
CREATE INDEX IF NOT EXISTS idx_source_links_client ON source_account_links(source_folder_id);
CREATE INDEX IF NOT EXISTS idx_source_links_target ON source_account_links(target_account_id);
CREATE INDEX IF NOT EXISTS idx_roster_match ON active_accounts_roster(owner_norm, type_norm);
"""

_MIGRATION_SQL = """
ALTER TABLE households ADD COLUMN IF NOT EXISTS docs_total INTEGER DEFAULT 0;
ALTER TABLE households ADD COLUMN IF NOT EXISTS docs_extracted INTEGER DEFAULT 0;
ALTER TABLE households ADD COLUMN IF NOT EXISTS doc_results JSONB DEFAULT '[]'::jsonb;
ALTER TABLE households ADD COLUMN IF NOT EXISTS superseded_by UUID;
ALTER TABLE households ADD COLUMN IF NOT EXISTS run_number INTEGER DEFAULT 1;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS validation_status TEXT DEFAULT 'VALID';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS investor_number TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_registration TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS validation_issues JSONB DEFAULT '[]'::jsonb;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS original_transfer_eligible TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_inherited BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS inherited_note TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_type_overridden_by TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_type_overridden_at TIMESTAMPTZ;
ALTER TABLE households ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE households ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE households ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cost_basis_status TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_type_other TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS cost_basis NUMERIC(15,2);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS cost_basis_granularity TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS lots JSONB;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS statement_age_days INTEGER;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_stale BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS transferring TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS transferring_by TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS transferring_at TIMESTAMPTZ;
ALTER TABLE active_accounts_roster ADD COLUMN IF NOT EXISTS trading_account_no TEXT;
ALTER TABLE active_accounts_roster ADD COLUMN IF NOT EXISTS apex_number TEXT;

UPDATE positions SET transfer_eligible = 'UNSUPPORTED' WHERE transfer_eligible = 'BLOCKED';
UPDATE positions SET override_status = 'UNSUPPORTED' WHERE override_status = 'BLOCKED';
UPDATE positions SET original_transfer_eligible = 'UNSUPPORTED' WHERE original_transfer_eligible = 'BLOCKED';
"""

_VIEWS_SQL = """
DROP VIEW IF EXISTS household_summary CASCADE;
DROP VIEW IF EXISTS positions_effective CASCADE;

CREATE OR REPLACE VIEW positions_effective AS
SELECT
    p.*,
    COALESCE(p.override_status, p.transfer_eligible) AS effective_status,
    COALESCE(p.override_notes, p.transfer_notes)     AS effective_notes
FROM positions p
WHERE p.deleted_at IS NULL;

CREATE OR REPLACE VIEW household_summary AS
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
    COUNT(CASE WHEN pe.effective_status = 'ACAT'      THEN 1 END) AS acat_count,
    COUNT(CASE WHEN pe.effective_status = 'LIQUIDATE'  THEN 1 END) AS liquidate_count,
    COUNT(CASE WHEN pe.effective_status = 'UNSUPPORTED' THEN 1 END) AS unsupported_count,
    COUNT(CASE WHEN pe.effective_status = 'REVIEW'     THEN 1 END) AS review_count,
    COUNT(CASE WHEN pe.effective_status = 'ACH/WIRE'   THEN 1 END) AS transfer_count
FROM households h
LEFT JOIN accounts a ON a.household_id = h.id AND a.deleted_at IS NULL
LEFT JOIN positions_effective pe ON pe.account_id = a.id
GROUP BY h.id, h.client_name, h.processed_at, h.total_value,
         h.docs_total, h.docs_extracted, h.run_number, h.superseded_by;
"""


def ensure_schema(conn) -> None:
    """Create tables, indexes, and views if they don't exist.
    Runs migrations (ALTER TABLE) before views so new columns are
    available when views reference them.

    If the connected user lacks DDL ownership (common with Cloud SQL IAM
    auth where tables were originally created by the postgres superuser),
    each step is attempted independently and failures are logged as
    warnings rather than crashing the scan.

    With ``DB_SCHEMA_OWNER=external`` no DDL runs: the schema is verified
    read-only and a missing table, view or column raises.
    """
    if schema_owner_external():
        assert_external_schema(conn)
        return
    steps = [
        ("tables/indexes", _TABLES_SQL),
        ("migrations", _MIGRATION_SQL),
        ("views", _VIEWS_SQL),
    ]
    all_ok = True
    for label, sql in steps:
        try:
            with conn.cursor() as cur:
                cur.execute(sql)
            conn.commit()
        except psycopg2.errors.InsufficientPrivilege:
            conn.rollback()
            log.warning(
                "Schema step '%s' skipped — insufficient privilege "
                "(tables likely already exist with a different owner)", label,
            )
            all_ok = False
        except Exception:
            conn.rollback()
            raise
    log.info("Postgres schema %s", "verified" if all_ok else "verified (some DDL skipped — see warnings)")


EXTERNAL_RELATIONS = {
    "households": {"id", "client_name", "source_folder_id", "superseded_by", "reviewed_at", "updated_at"},
    "accounts": {"id", "household_id", "account_number", "account_type_overridden_by", "deleted_at"},
    "positions": {"id", "account_id", "transferring_at", "deleted_at"},
    "users": {"id", "email", "role"},
    "mcp_tokens": {"id", "token_hash", "user_email", "expires_at", "revoked_at"},
    "target_accounts": {"id", "source_folder_id", "needs_to_be_opened"},
    "source_account_links": {"id", "target_account_id"},
    "active_accounts_roster": {"id", "owner_norm", "type_norm", "trading_account_no", "apex_number"},
    "positions_effective": {"id", "effective_status", "effective_notes"},
    "household_summary": {"id", "total_positions", "transfer_count"},
}


def assert_external_schema(conn) -> None:
    """Read-only check that the externally owned schema has what this service uses."""
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT current_schema()")
            schema = cur.fetchone()[0]
            expected = os.getenv("DB_SEARCH_PATH", "")
            if not schema or (expected and schema != expected):
                raise RuntimeError(f"external schema not ready: current_schema is {schema!r}, expected {expected!r}")
            cur.execute(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = current_schema() AND table_name = ANY(%s)",
                (list(EXTERNAL_RELATIONS),),
            )
            found: dict = {}
            for table, column in cur.fetchall():
                found.setdefault(table, set()).add(column)
        missing = sorted(
            f"{table}.{column}"
            for table, columns in EXTERNAL_RELATIONS.items()
            for column in columns - found.get(table, set())
        )
        if missing:
            raise RuntimeError("external schema not ready: missing " + ", ".join(missing))
    finally:
        conn.rollback()
    log.info("Postgres schema verified (external owner, schema %s)", schema)


# ---------------------------------------------------------------------------
# Write operations (pipeline -> DB)
# ---------------------------------------------------------------------------

def write_household(conn, consolidated: dict, source_folder_id: str = None) -> str:
    """
    Insert a full household (accounts + positions) in one transaction.
    Returns the household UUID.
    """
    household_id = str(uuid4())
    now = datetime.now(ET)

    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO households
               (id, client_name, processed_at, source_folder_id, total_value,
                docs_total, docs_extracted, doc_results, run_number)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                household_id,
                consolidated.get("client_name", "Unknown"),
                now,
                source_folder_id,
                _clean_numeric(consolidated.get("total_value")),
                consolidated.get("docs_total", 0),
                consolidated.get("docs_extracted", 0),
                json.dumps(consolidated.get("doc_results", [])),
                consolidated.get("run_number", 1),
            ),
        )

        for acct in consolidated.get("accounts", []):
            account_id = str(uuid4())

            cur.execute(
                """INSERT INTO accounts
                   (id, household_id, custodian, account_type, account_type_raw,
                    account_type_other,
                    account_number, investor_number, account_registration, account_holder, statement_date,
                    statement_age_days, is_stale,
                    cash_balance, total_value, cost_basis_status, is_rollover, rollover_note,
                    is_inherited, inherited_note,
                    apex_restriction, apex_special_handling, custodian_intel,
                    validation_status, validation_issues)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    account_id,
                    household_id,
                    acct.get("custodian"),
                    acct.get("account_type"),
                    acct.get("account_type_raw"),
                    acct.get("account_type_other"),
                    acct.get("account_number"),
                    acct.get("investor_number"),
                    acct.get("account_registration"),
                    acct.get("account_holder"),
                    acct.get("statement_date"),
                    acct.get("statement_age_days"),
                    acct.get("is_stale", False),
                    _clean_numeric(acct.get("cash_balance")),
                    _clean_numeric(acct.get("total_value")),
                    acct.get("cost_basis_status"),
                    acct.get("is_rollover", False),
                    acct.get("rollover_note"),
                    acct.get("is_inherited", False),
                    acct.get("inherited_note"),
                    acct.get("apex_restriction"),
                    acct.get("apex_special_handling"),
                    json.dumps(acct.get("custodian_intel")) if acct.get("custodian_intel") else None,
                    acct.get("validation_status", "VALID"),
                    json.dumps(acct.get("validation_issues", [])),
                ),
            )

            for pos in acct.get("assets", []):
                position_id = str(uuid4())
                cur.execute(
                    """INSERT INTO positions
                       (id, account_id, symbol, description, quantity,
                        market_value, cost_basis, cost_basis_granularity, lots,
                        asset_type, classification_source,
                        transfer_eligible, transfer_notes, original_transfer_eligible,
                        notion_check)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        position_id,
                        account_id,
                        pos.get("symbol"),
                        pos.get("description"),
                        _clean_numeric(pos.get("quantity")),
                        _clean_numeric(pos.get("market_value")),
                        _clean_numeric(pos.get("cost_basis")),
                        pos.get("cost_basis_granularity"),
                        json.dumps(pos.get("lots")) if pos.get("lots") else None,
                        pos.get("type"),
                        pos.get("classification_source"),
                        pos.get("transfer_eligible"),
                        pos.get("transfer_notes"),
                        pos.get("original_transfer_eligible"),
                        json.dumps(pos.get("notion_check")) if pos.get("notion_check") else None,
                    ),
                )

    conn.commit()
    log.info("  Wrote household %s to Postgres (%s)", consolidated.get("client_name"), household_id)
    return household_id


# ---------------------------------------------------------------------------
# Read operations (API -> DB)
# ---------------------------------------------------------------------------

def bulk_query_bounds(page, per_page, max_per_page: int) -> tuple[int, int, int]:
    """Pure: normalize a (page, per_page) request and derive the SQL LIMIT and
    OFFSET. page floors at 1; per_page is clamped to [1, max_per_page].
    Returns (page, per_page, offset). Extracted for unit testing."""
    page = max(int(page or 1), 1)
    per_page = max(1, min(int(per_page or 1), int(max_per_page)))
    offset = (page - 1) * per_page
    return page, per_page, offset


def assemble_household_tree(
    households: list[dict],
    accounts: list[dict],
    positions: list[dict],
) -> list[dict]:
    """Pure: group already-serialized rows into the
    household -> accounts[] -> {..., assets: positions[]} tree.

    positions are attached to accounts by account_id; accounts to households by
    household_id. Household/account ordering follows the input list order (the
    caller sorts via SQL). Does not mask, mutate freshness, or hit the DB, so it
    is unit-testable in isolation. Returns new dicts (inputs are not mutated)."""
    positions_by_account: dict[str, list] = {}
    for p in positions:
        positions_by_account.setdefault(str(p["account_id"]), []).append(p)

    accounts_by_household: dict[str, list] = {}
    for a in accounts:
        acct = dict(a)
        acct["assets"] = positions_by_account.get(str(acct["id"]), [])
        accounts_by_household.setdefault(str(acct["household_id"]), []).append(acct)

    tree = []
    for h in households:
        hh = dict(h)
        hh["accounts"] = accounts_by_household.get(str(hh["id"]), [])
        tree.append(hh)
    return tree


def count_households(conn, include_superseded: bool = False) -> int:
    """Total number of households matching the bulk-read filter (live only by
    default), for pagination metadata."""
    # Two fully-static query strings (no interpolation) selected by the bool —
    # the filter is query structure, not a bindable value, and keeping both
    # literals static keeps this un-flaggable by SAST (no dynamic SQL).
    with conn.cursor() as cur:
        if include_superseded:
            cur.execute("SELECT COUNT(*) FROM households")
        else:
            cur.execute(
                "SELECT COUNT(*) FROM households WHERE superseded_by IS NULL"
            )
        return int(cur.fetchone()[0])


def get_households_bulk(
    conn,
    limit: int,
    offset: int,
    include_superseded: bool = False,
) -> list[dict]:
    """Bulk read for service-to-service ingest: a page of households with their
    full account+position tree, UNMASKED, in the same
    household -> accounts[] -> {..., assets: positions[]} shape as
    get_household_detail (but without masking, and batched).

    Rollup counts come from the household_summary view (like get_households).
    Accounts and positions for the whole page are batch-loaded (WHERE ... = ANY)
    and grouped in memory — no per-household round-trips. Positions come from
    positions_effective so overrides are applied and soft-deletes excluded.
    Statement freshness is recomputed live so is_stale reflects today's age.
    """
    from automation_pipeline import flag_statement_freshness

    # Single static query; the live-only filter is a BOUND boolean param, not
    # interpolated SQL: when include_superseded is true the predicate passes all
    # rows, otherwise it restricts to superseded_by IS NULL. No dynamic SQL.
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT h.*,
                       hs.total_accounts, hs.total_positions,
                       hs.acat_count, hs.liquidate_count, hs.unsupported_count,
                       hs.review_count, hs.transfer_count
               FROM household_summary hs
               JOIN households h ON h.id = hs.id
               WHERE (%s OR hs.superseded_by IS NULL)
               ORDER BY hs.processed_at DESC, h.id
               LIMIT %s OFFSET %s""",
            (include_superseded, limit, offset),
        )
        household_rows = cur.fetchall()

        household_ids = [h["id"] for h in household_rows]
        account_rows: list = []
        position_rows: list = []
        if household_ids:
            cur.execute(
                """SELECT * FROM accounts
                   WHERE household_id = ANY(%s::uuid[])
                     AND deleted_at IS NULL
                   ORDER BY custodian, account_type""",
                (household_ids,),
            )
            account_rows = cur.fetchall()

            account_ids = [a["id"] for a in account_rows]
            if account_ids:
                cur.execute(
                    """SELECT * FROM positions_effective
                       WHERE account_id = ANY(%s::uuid[])
                         AND deleted_at IS NULL
                       ORDER BY market_value DESC NULLS LAST""",
                    (account_ids,),
                )
                position_rows = cur.fetchall()

    households = [_serialize_row(h) for h in household_rows]
    accounts = [_serialize_row(a) for a in account_rows]
    positions = [_serialize_row(p) for p in position_rows]

    tree = assemble_household_tree(households, accounts, positions)
    for hh in tree:
        for acct in hh["accounts"]:
            flag_statement_freshness(acct)
    return tree


def get_households(
    conn,
    page: int = 1,
    per_page: int = 50,
    include_superseded: bool = False,
) -> list[dict]:
    """Return households from the summary view, most recent first.

    By default, superseded runs (older runs for the same client folder)
    are excluded. Pass include_superseded=True to see all runs.
    """
    offset = (max(page, 1) - 1) * per_page
    where_clause = "" if include_superseded else "WHERE superseded_by IS NULL"
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            f"""SELECT id, client_name, processed_at, total_value,
                      docs_total, docs_extracted, run_number,
                      total_accounts, total_positions,
                      acat_count, liquidate_count, unsupported_count,
                      review_count, transfer_count
               FROM household_summary
               {where_clause}
               ORDER BY processed_at DESC
               LIMIT %s OFFSET %s""",
            (per_page, offset),
        )
        rows = cur.fetchall()
    return [_serialize_row(r) for r in rows]


def get_household_detail(conn, household_id: str) -> Optional[dict]:
    """
    Return a full household with nested accounts and positions.
    Positions use the effective view (overrides applied).
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM households WHERE id = %s", (household_id,)
        )
        household = cur.fetchone()
        if not household:
            return None

        cur.execute(
            """SELECT * FROM accounts
               WHERE household_id = %s AND deleted_at IS NULL
               ORDER BY custodian, account_type""",
            (household_id,),
        )
        accounts = cur.fetchall()

        account_ids = [a["id"] for a in accounts]
        positions_by_account: dict[str, list] = {str(a["id"]): [] for a in accounts}

        if account_ids:
            cur.execute(
                """SELECT * FROM positions_effective
                   WHERE account_id = ANY(%s::uuid[])
                   ORDER BY market_value DESC NULLS LAST""",
                (account_ids,),
            )
            for pos in cur.fetchall():
                aid = str(pos["account_id"])
                if aid in positions_by_account:
                    positions_by_account[aid].append(_serialize_row(pos))

    # Recompute statement freshness live (not the value frozen at processing
    # time) so it reflects today's age and applies to households processed
    # before the staleness flag existed. Lazy import avoids a circular dep.
    from automation_pipeline import flag_statement_freshness

    result = _serialize_row(household)
    result["accounts"] = []
    for acct in accounts:
        a = _serialize_row(acct)
        a["account_number"] = _mask_account_number(a.get("account_number"))
        a["investor_number"] = _mask_account_number(a.get("investor_number"))
        a["assets"] = positions_by_account.get(str(acct["id"]), [])
        flag_statement_freshness(a)
        result["accounts"].append(a)

    # Accounts-to-be-opened destinations (client-level, persist across runs).
    result["destinations"] = get_destinations_for_client(conn, household.get("source_folder_id"))
    for d in result["destinations"]:
        for s in d.get("sources", []):
            s["account_number"] = _mask_account_number(s.get("account_number"))

    return result


# Retain the existing exception name for API consumers and tests.
AmbiguousAccountNumberError = AccountSelectionRequired


def _source_account_versions(conn, *, account_number=None, account_id=None, search=None):
    """Find candidate household lineages, then load complete versions/tombstones.

    A search is discovery only. It never chooses a source account for a caller.
    Full-number and UUID lookups are bound parameters, as is the escaped search.
    """
    pattern = None if search is None else "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    from account_resolution import normalize_number
    number = normalize_number(account_number) if account_number else None
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """WITH RECURSIVE lineage AS (
                 SELECT id AS origin_id, id, superseded_by, source_folder_id, ARRAY[id] AS path
                 FROM households
                 UNION ALL
                 SELECT l.origin_id, h.id, h.superseded_by, h.source_folder_id, l.path || h.id
                 FROM lineage l JOIN households h ON h.id = l.superseded_by
                 WHERE NOT h.id = ANY(l.path)
               ), roots AS (
                 SELECT DISTINCT ON (origin_id) origin_id,
                        COALESCE(NULLIF(source_folder_id, ''), id::text) AS family,
                        CASE WHEN superseded_by IS NULL
                             THEN COALESCE(NULLIF(source_folder_id, ''), id::text) END AS lineage_key
                 FROM lineage ORDER BY origin_id, cardinality(path) DESC
               ), families AS (
                 SELECT DISTINCT r.family
                 FROM accounts a JOIN households h ON h.id = a.household_id
                 JOIN roots r ON r.origin_id = h.id
                 WHERE (%s IS NOT NULL AND a.id = %s::uuid)
                    OR (%s IS NOT NULL AND (
                        UPPER(REGEXP_REPLACE(a.account_number, '[[:space:]-]', '', 'g')) = %s
                        OR UPPER(REGEXP_REPLACE(a.investor_number, '[[:space:]-]', '', 'g')) = %s))
                    OR (%s IS NOT NULL AND (
                        h.client_name ILIKE %s OR a.account_holder ILIKE %s
                        OR a.account_number ILIKE %s OR a.investor_number ILIKE %s))
                 ORDER BY family LIMIT 51
               )
               SELECT a.*, h.client_name, h.source_folder_id, h.superseded_by,
                      h.processed_at, h.run_number, r.lineage_key,
                      (SELECT COUNT(*) FROM positions p
                       WHERE p.account_id = a.id AND p.deleted_at IS NULL) AS position_count
               FROM accounts a JOIN households h ON h.id = a.household_id
               JOIN roots r ON r.origin_id = h.id
               JOIN families f ON f.family = r.family
               ORDER BY h.processed_at DESC, h.run_number DESC, a.id""",
            (account_id, account_id, number, number, number,
             pattern, pattern, pattern, pattern, pattern),
        )
        return [dict(row) for row in cur.fetchall()]


def _account_positions(conn, account):
    if account is None:
        return None
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT * FROM positions_effective WHERE account_id = %s
               ORDER BY market_value DESC NULLS LAST""", (account["id"],),
        )
        positions = [_serialize_row(p) for p in cur.fetchall()]
    result = _serialize_row(account)
    result["positions"] = positions
    result["is_historical"] = bool(account.get("superseded_by"))
    from automation_pipeline import flag_statement_freshness
    flag_statement_freshness(result)
    return result


def get_positions_by_account_number(conn, account_number: str) -> Optional[dict]:
    from account_resolution import normalize_number
    number = normalize_number(account_number)
    if not number or any(marker in number for marker in "*•●"):
        return None
    versions = _source_account_versions(conn, account_number=number)
    if len({a.get("source_folder_id") or str(a["household_id"]) for a in versions}) >= 51:
        raise AccountSelectionRequired("Too many matching households; choose the source account")
    return _account_positions(conn, resolve_account(versions, account_number=number))


def get_positions_by_account_id(conn, account_id: str) -> Optional[dict]:
    versions = _source_account_versions(conn, account_id=account_id)
    return _account_positions(conn, resolve_account(versions, account_id=account_id))


def search_position_accounts(conn, search: str) -> dict:
    versions = _source_account_versions(conn, search=search)
    choices = account_choices(versions)
    from automation_pipeline import flag_statement_freshness
    result = []
    for account in choices[:100]:
        row = _serialize_row(account)
        row["is_historical"] = bool(account.get("superseded_by"))
        flag_statement_freshness(row)
        result.append(row)
    return {"accounts": result, "truncated": len(choices) > 100 or len({a.get("source_folder_id") or str(a["household_id"]) for a in versions}) >= 51}


def touch_household(conn, household_id: str) -> None:
    """Bump households.updated_at to NOW(). Stays inside the caller's
    transaction — does not commit."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE households SET updated_at = NOW() WHERE id = %s",
            (household_id,),
        )


def touch_household_for_account(conn, account_id: str) -> None:
    """Bump updated_at on the household that owns this account. No commit."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE households
               SET updated_at = NOW()
               WHERE id = (SELECT household_id FROM accounts WHERE id = %s)""",
            (account_id,),
        )


def touch_household_for_position(conn, position_id: str) -> None:
    """Bump updated_at on the household that owns this position. No commit."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE households
               SET updated_at = NOW()
               WHERE id = (
                   SELECT a.household_id FROM accounts a
                   JOIN positions p ON p.account_id = a.id
                   WHERE p.id = %s
               )""",
            (position_id,),
        )


def mark_household_reviewed(
    conn, household_id: str, user_email: str
) -> Optional[datetime]:
    """Stamp reviewed_at = NOW() and reviewed_by = user_email on a household.
    Commits. Returns the new reviewed_at, or None if the household is missing."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE households
               SET reviewed_at = NOW(), reviewed_by = %s
               WHERE id = %s
               RETURNING reviewed_at""",
            (user_email, household_id),
        )
        row = cur.fetchone()
    conn.commit()
    return row[0] if row else None


def update_position_override(
    conn,
    position_id: str,
    status: str,
    notes: str = "",
    user: str = "ops",
) -> bool:
    """Write an override to a position. Returns True if the row existed."""
    now = datetime.now(ET)
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE positions
               SET override_status = %s,
                   override_notes = %s,
                   overridden_by = %s,
                   overridden_at = %s
               WHERE id = %s AND deleted_at IS NULL""",
            (status, notes, user, now, position_id),
        )
        updated = cur.rowcount > 0
    if updated:
        touch_household_for_position(conn, position_id)
    conn.commit()
    return updated


def set_position_transferring(
    conn,
    position_id: str,
    value: Optional[str],
    user: str = "ops",
) -> bool:
    """Set the ops 'transferring' flag on a position ('YES', 'NO', or None to
    clear). Records who/when. Returns True if the row existed."""
    now = datetime.now(ET)
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE positions
               SET transferring = %s,
                   transferring_by = %s,
                   transferring_at = %s
               WHERE id = %s AND deleted_at IS NULL""",
            (value, user if value is not None else None,
             now if value is not None else None, position_id),
        )
        updated = cur.rowcount > 0
    if updated:
        touch_household_for_position(conn, position_id)
    conn.commit()
    return updated


# ---------------------------------------------------------------------------
# Accounts to be opened at Apex — destination mapping + roster suggestions
# ---------------------------------------------------------------------------

def normalize_owner(name: Optional[str]) -> Optional[str]:
    """Normalize an owner name for matching: lowercase, drop punctuation and
    single-letter middle initials, collapse whitespace. 'KOFI M OKAFOR-ALVAREZ'
    and 'Kofi Okafor-Alvarez' both -> 'kofi okafor alvarez'. Joints keep '&'."""
    if not name:
        return None
    n = re.sub(r"[^a-zA-Z& ]", " ", name.lower())
    toks = [t for t in n.split() if len(t) > 1 or t == "&"]
    return " ".join(toks) or None


def normalize_acct_type(raw: Optional[str]) -> Optional[str]:
    """Collapse the many account-type spellings to a canonical bucket:
    INDIVIDUAL / JOINT / ROTH IRA / TRAD IRA (+ ' INHERITED'). Strips 'Companion'."""
    if not raw:
        return None
    s = raw.lower().replace("_", " ").replace("companion", "").strip()
    inherited = "inherited" in s or "beneficiary" in s or "bene " in s
    if ("joint" in s or "jwros" in s or "jtwros" in s or "jtic" in s or "wros" in s
            or "tenants" in s or "survivorship" in s or "community property" in s
            or "entirety" in s):
        base = "JOINT"
    elif "roth" in s:
        base = "ROTH IRA"
    elif "trad" in s or "ira" in s:  # traditional / sep / simple / rollover IRA
        base = "TRAD IRA"
    elif "401" in s or "403" in s or "rollover" in s or "pension" in s:
        base = "TRAD IRA"  # employer plans roll into a Trad IRA destination
    elif "brokerage" in s or "individual" in s:
        base = "INDIVIDUAL"
    else:
        base = s.upper().strip()
    return base + (" INHERITED" if inherited else "")


def touch_household_for_client(conn, source_folder_id: str) -> None:
    """Bump updated_at on the active (non-superseded) household for a client so
    the UI sees destination edits as a change."""
    if not source_folder_id:
        return
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE households SET updated_at = %s
               WHERE source_folder_id = %s AND superseded_by IS NULL""",
            (datetime.now(ET), source_folder_id),
        )


def create_target_account(conn, source_folder_id, owner, target_account_type,
                          needs_to_be_opened=True, existing_apex_number=None,
                          user="auto") -> str:
    """Insert a destination account. Returns its id."""
    target_id = str(uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO target_accounts
               (id, source_folder_id, owner, target_account_type,
                existing_apex_number, needs_to_be_opened, created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (target_id, source_folder_id, owner, target_account_type,
             existing_apex_number, needs_to_be_opened, user),
        )
    touch_household_for_client(conn, source_folder_id)
    conn.commit()
    return target_id


def get_link_target(conn, source_folder_id, custodian, account_number):
    """Return the target_account_id a source account is currently linked to, or None."""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT target_account_id FROM source_account_links
               WHERE source_folder_id = %s
                 AND COALESCE(source_custodian,'') = COALESCE(%s,'')
                 AND COALESCE(source_account_number,'') = COALESCE(%s,'')""",
            (source_folder_id, custodian, account_number),
        )
        row = cur.fetchone()
    return str(row[0]) if row else None


def link_source(conn, source_folder_id, custodian, account_number, target_account_id, user="auto"):
    """Create a source→target link (no dup check; caller ensures uniqueness)."""
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO source_account_links
               (id, source_folder_id, source_custodian, source_account_number,
                target_account_id, created_by)
               VALUES (%s,%s,%s,%s,%s,%s)""",
            (str(uuid4()), source_folder_id, custodian, account_number,
             target_account_id, user),
        )
    conn.commit()


def reassign_source_link(conn, source_folder_id, custodian, account_number,
                         target_account_id, user="ops") -> bool:
    """Point a source account at a different destination (upsert the link)."""
    existing = get_link_target(conn, source_folder_id, custodian, account_number)
    with conn.cursor() as cur:
        if existing:
            cur.execute(
                """UPDATE source_account_links SET target_account_id = %s, created_by = %s
                   WHERE source_folder_id = %s
                     AND COALESCE(source_custodian,'') = COALESCE(%s,'')
                     AND COALESCE(source_account_number,'') = COALESCE(%s,'')""",
                (target_account_id, user, source_folder_id, custodian, account_number),
            )
        else:
            cur.execute(
                """INSERT INTO source_account_links
                   (id, source_folder_id, source_custodian, source_account_number,
                    target_account_id, created_by)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                (str(uuid4()), source_folder_id, custodian, account_number,
                 target_account_id, user),
            )
    touch_household_for_client(conn, source_folder_id)
    conn.commit()
    return True


def link_folder(conn, link_id) -> Optional[str]:
    """The client (source folder) a source link belongs to, or None."""
    with conn.cursor() as cur:
        cur.execute("SELECT source_folder_id FROM source_account_links WHERE id = %s", (link_id,))
        row = cur.fetchone()
    return row[0] if row else None


def reassign_link(conn, link_id, target_account_id, user="ops") -> bool:
    """Point an existing source link at a different destination of the same client, by link id. False when
    the link is missing or the destination belongs to another client (the source would vanish from both)."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE source_account_links l SET target_account_id = %s, created_by = %s
               WHERE l.id = %s
                 AND EXISTS (SELECT 1 FROM target_accounts t
                             WHERE t.id = %s AND t.source_folder_id = l.source_folder_id)""",
            (target_account_id, user, link_id, target_account_id),
        )
        updated = cur.rowcount > 0
        cur.execute("SELECT source_folder_id FROM source_account_links WHERE id = %s", (link_id,))
        row = cur.fetchone()
    if updated and row:
        touch_household_for_client(conn, row[0])
    conn.commit()
    return updated


def set_target_account(conn, target_id, *, needs_to_be_opened=None,
                       target_account_type=None, existing_apex_number=None,
                       owner=None, user="ops") -> bool:
    """Update editable fields on a destination. Only non-None args are changed."""
    sets, vals = [], []
    if needs_to_be_opened is not None:
        sets.append("needs_to_be_opened = %s"); vals.append(needs_to_be_opened)
    if target_account_type is not None:
        sets.append("target_account_type = %s"); vals.append(target_account_type)
    if existing_apex_number is not None:
        sets.append("existing_apex_number = %s"); vals.append(existing_apex_number)
    if owner is not None:
        sets.append("owner = %s"); vals.append(owner)
    if not sets:
        return False
    sets.append("updated_at = %s"); vals.append(datetime.now(ET))
    vals.append(target_id)
    with conn.cursor() as cur:
        cur.execute(f"UPDATE target_accounts SET {', '.join(sets)} WHERE id = %s", vals)
        updated = cur.rowcount > 0
        cur.execute("SELECT source_folder_id FROM target_accounts WHERE id = %s", (target_id,))
        row = cur.fetchone()
    if updated and row:
        touch_household_for_client(conn, row[0])
    conn.commit()
    return updated


class DestinationInUse(Exception):
    """A destination still has source accounts mapped to it."""


def delete_target_account(conn, target_id) -> bool:
    """Delete a destination. Returns True if it existed. Refused (DestinationInUse) while source accounts are
    mapped to it: their links would cascade away, and a source with no link can't be moved again until the
    next run."""
    with conn.cursor() as cur:
        cur.execute("SELECT source_folder_id FROM target_accounts WHERE id = %s FOR UPDATE", (target_id,))
        row = cur.fetchone()
        cur.execute("SELECT 1 FROM source_account_links WHERE target_account_id = %s LIMIT 1", (target_id,))
        if cur.fetchone():
            conn.rollback()
            raise DestinationInUse(target_id)
        cur.execute("DELETE FROM target_accounts WHERE id = %s", (target_id,))
        deleted = cur.rowcount > 0
    if deleted and row:
        touch_household_for_client(conn, row[0])
    conn.commit()
    return deleted


def query_roster(conn, owner_norm, type_norm) -> list:
    """Return active-roster rows matching a destination's normalized owner + type."""
    if not owner_norm or not type_norm:
        return []
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT owner, account_type, account_title_raw, household,
                      trading_account_no, apex_number, total_value
               FROM active_accounts_roster
               WHERE owner_norm = %s AND type_norm = %s""",
            (owner_norm, type_norm),
        )
        return [dict(r) for r in cur.fetchall()]


def get_destinations_for_client(conn, source_folder_id: str) -> list:
    """Return the destination accounts for a client, each with its linked source
    accounts and a roster-based suggestion (existing match count)."""
    if not source_folder_id:
        return []
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT * FROM target_accounts WHERE source_folder_id = %s
               ORDER BY owner, target_account_type""",
            (source_folder_id,),
        )
        targets = [dict(t) for t in cur.fetchall()]
        cur.execute(
            """SELECT * FROM source_account_links WHERE source_folder_id = %s""",
            (source_folder_id,),
        )
        links = [dict(l) for l in cur.fetchall()]

    links_by_target: dict = {}
    for l in links:
        links_by_target.setdefault(str(l["target_account_id"]), []).append({
            "link_id": str(l["id"]),
            "custodian": l.get("source_custodian"),
            "account_number": l.get("source_account_number"),
        })

    out = []
    for t in targets:
        matches = query_roster(conn, normalize_owner(t.get("owner")),
                               normalize_acct_type(t.get("target_account_type")))
        out.append({
            "id": str(t["id"]),
            "owner": t.get("owner"),
            "target_account_type": t.get("target_account_type"),
            "existing_apex_number": t.get("existing_apex_number"),
            "needs_to_be_opened": t.get("needs_to_be_opened"),
            "sources": links_by_target.get(str(t["id"]), []),
            "suggestion": (lambda nums: {
                "existing_count": len(matches),
                "matched_titles": [m.get("account_title_raw") for m in matches][:5],
                "matched_numbers": nums,
                "suggested_apex_number": (nums[0] if len(nums) == 1 and not t.get("existing_apex_number") else None),
            })([m.get("apex_number") for m in matches if m.get("apex_number")]),
        })
    return out


def load_active_accounts_roster(conn, rows: list) -> int:
    """Replace the active-accounts roster with `rows` (dicts: household, owner,
    account_type, account_title_raw, total_value). Computes norm columns."""
    with conn.cursor() as cur:
        cur.execute("TRUNCATE active_accounts_roster")
        for r in rows:
            cur.execute(
                """INSERT INTO active_accounts_roster
                   (id, household, owner, owner_norm, account_type, type_norm,
                    account_title_raw, trading_account_no, apex_number, total_value)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (str(uuid4()), r.get("household"), r.get("owner"),
                 normalize_owner(r.get("owner")), r.get("account_type"),
                 normalize_acct_type(r.get("account_type")),
                 r.get("account_title_raw"), r.get("trading_account_no"),
                 r.get("apex_number"), _clean_numeric(r.get("total_value"))),
            )
        n = len(rows)
    conn.commit()
    return n


# ---------------------------------------------------------------------------
# Account-type override (ops only, triggers re-classification)
# ---------------------------------------------------------------------------

def get_account_for_reclassification(
    conn, account_id: str
) -> Optional[tuple[dict, list[dict]]]:
    """Fetch a non-deleted account plus its non-deleted positions in the
    minimal shape needed to re-run `reclassify_for_new_account_type`.

    Returns (account_dict, positions_list) or None if the account is
    missing / soft-deleted.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM accounts WHERE id = %s AND deleted_at IS NULL",
            (account_id,),
        )
        account = cur.fetchone()
        if not account:
            return None

        cur.execute(
            """SELECT id, symbol, asset_type, classification_source, notion_check,
                      transfer_eligible, transfer_notes, override_status
               FROM positions
               WHERE account_id = %s AND deleted_at IS NULL""",
            (account_id,),
        )
        positions = cur.fetchall()

    return _serialize_row(account), [_serialize_row(p) for p in positions]


def apply_account_type_change(
    conn,
    account_id: str,
    user_email: str,
    account_fields: dict,
    position_updates: list[dict],
) -> int:
    """Persist a manual account-type change and the resulting per-position
    re-classification in a single transaction.

    `account_type_raw` is intentionally NOT modified — it is the verbatim
    string from the source statement and must be preserved for audit.
    Per-position `override_status` / `override_notes` are also untouched,
    so manual position overrides survive an account-type change.

    Returns the number of positions whose engine status (transfer_eligible
    / transfer_notes) actually changed.
    """
    now = datetime.now(ET)
    changed = 0
    try:
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE accounts
                   SET account_type = %s,
                       account_type_other = %s,
                       is_rollover = %s,
                       rollover_note = %s,
                       is_inherited = %s,
                       inherited_note = %s,
                       apex_restriction = %s,
                       account_type_overridden_by = %s,
                       account_type_overridden_at = %s
                   WHERE id = %s AND deleted_at IS NULL""",
                (
                    account_fields["account_type"],
                    account_fields.get("account_type_other"),
                    account_fields["is_rollover"],
                    account_fields["rollover_note"],
                    account_fields["is_inherited"],
                    account_fields["inherited_note"],
                    account_fields["apex_restriction"],
                    user_email,
                    now,
                    account_id,
                ),
            )

            for pu in position_updates:
                cur.execute(
                    """UPDATE positions
                       SET transfer_eligible = %s,
                           transfer_notes = %s
                       WHERE id = %s
                         AND account_id = %s
                         AND deleted_at IS NULL
                         AND (transfer_eligible IS DISTINCT FROM %s
                              OR transfer_notes IS DISTINCT FROM %s)""",
                    (
                        pu["transfer_eligible"],
                        pu["transfer_notes"],
                        pu["id"],
                        account_id,
                        pu["transfer_eligible"],
                        pu["transfer_notes"],
                    ),
                )
                changed += cur.rowcount
                if "original_transfer_eligible" in pu:  # kept in REVIEW: the engine's answer, for the record
                    cur.execute(
                        """UPDATE positions SET original_transfer_eligible = %s
                           WHERE id = %s AND account_id = %s AND deleted_at IS NULL""",
                        (pu["original_transfer_eligible"], pu["id"], account_id),
                    )
            touch_household_for_account(conn, account_id)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return changed


# ---------------------------------------------------------------------------
# Soft-delete / restore (ops only)
# ---------------------------------------------------------------------------

def soft_delete_position(conn, position_id: str, user_email: str) -> bool:
    """Soft-delete a position. Returns True if the row existed and was not already deleted."""
    now = datetime.now(ET)
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE positions
               SET deleted_at = %s, deleted_by = %s
               WHERE id = %s AND deleted_at IS NULL""",
            (now, user_email, position_id),
        )
        updated = cur.rowcount > 0
    if updated:
        touch_household_for_position(conn, position_id)
    conn.commit()
    return updated


def soft_delete_account(conn, account_id: str, user_email: str) -> bool:
    """Soft-delete an account and all its positions. Returns True if the account existed."""
    now = datetime.now(ET)
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE accounts
               SET deleted_at = %s, deleted_by = %s
               WHERE id = %s AND deleted_at IS NULL""",
            (now, user_email, account_id),
        )
        updated = cur.rowcount > 0
        if updated:
            cur.execute(
                """UPDATE positions
                   SET deleted_at = %s, deleted_by = %s
                   WHERE account_id = %s AND deleted_at IS NULL""",
                (now, user_email, account_id),
            )
    if updated:
        touch_household_for_account(conn, account_id)
    conn.commit()
    return updated


def restore_position(conn, position_id: str) -> bool:
    """Restore a soft-deleted position. Returns True if the row was restored."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE positions
               SET deleted_at = NULL, deleted_by = NULL
               WHERE id = %s AND deleted_at IS NOT NULL""",
            (position_id,),
        )
        updated = cur.rowcount > 0
    if updated:
        touch_household_for_position(conn, position_id)
    conn.commit()
    return updated


def restore_account(conn, account_id: str) -> bool:
    """Restore a soft-deleted account and the positions deleted with it. Returns True if restored. A position
    deleted on its own before the account stays deleted: soft_delete_account stamps the account and the positions
    it takes with it with one time, and only that time is undone."""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE accounts a
               SET deleted_at = NULL, deleted_by = NULL
               FROM (SELECT id, deleted_at FROM accounts
                     WHERE id = %s AND deleted_at IS NOT NULL FOR UPDATE) deleted
               WHERE a.id = deleted.id
               RETURNING deleted.deleted_at""",
            (account_id,),
        )
        row = cur.fetchone()
        updated = row is not None
        if updated:
            cur.execute(
                """UPDATE positions
                   SET deleted_at = NULL, deleted_by = NULL
                   WHERE account_id = %s AND deleted_at = %s""",
                (account_id, row[0]),
            )
    if updated:
        touch_household_for_account(conn, account_id)
    conn.commit()
    return updated


# ---------------------------------------------------------------------------
# Household superseding / duplicate detection
# ---------------------------------------------------------------------------

def count_runs_for_folder(conn, source_folder_id: str) -> int:
    """Return how many household runs already exist for a source folder."""
    if not source_folder_id:
        return 0
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM households WHERE source_folder_id = %s",
            (source_folder_id,),
        )
        row = cur.fetchone()
    return row[0] if row else 0


def supersede_previous_runs(conn, source_folder_id: str, new_household_id: str) -> int:
    """Mark all previous runs for a folder as superseded by the new run.
    Returns the number of rows updated."""
    if not source_folder_id:
        return 0
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE households
               SET superseded_by = %s
               WHERE source_folder_id = %s
                 AND id != %s
                 AND superseded_by IS NULL""",
            (new_household_id, source_folder_id, new_household_id),
        )
        updated = cur.rowcount
    conn.commit()
    return updated


# ---------------------------------------------------------------------------
# User lookup (auth / RBAC)
# ---------------------------------------------------------------------------

def get_user_by_email(conn, email: str) -> Optional[dict]:
    """Return the user row for a given email, or None if not found."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM users WHERE email = %s", (email,))
        row = cur.fetchone()
    return _serialize_row(row) if row else None


def get_user_by_id(conn, user_id: str) -> Optional[dict]:
    """Return the user row for an id, or None if not found or not a UUID."""
    try:
        UUID(str(user_id))
    except ValueError:
        return None
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
    return _serialize_row(row) if row else None


def upsert_personas(conn, personas) -> None:
    """Demo mode: make sure each sign-in persona has its user row and role. Commits."""
    with conn.cursor() as cur:
        for p in personas:
            cur.execute(
                """INSERT INTO users (email, role) VALUES (%s, %s)
                   ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role""",
                (p["email"], p["role"]),
            )
    conn.commit()


def list_users(conn) -> list[dict]:
    """Return all users ordered by role then email."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM users ORDER BY role, email"
        )
        rows = cur.fetchall()
    return [_serialize_row(r) for r in rows]


def create_user(conn, email: str, role: str = "advisor") -> dict:
    """Insert a new user. Raises ValueError on duplicate email."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        try:
            cur.execute(
                """INSERT INTO users (email, role)
                   VALUES (%s, %s) RETURNING *""",
                (email.lower().strip(), role),
            )
            row = cur.fetchone()
        except psycopg2.errors.UniqueViolation:
            conn.rollback()
            raise ValueError(f"User {email} already exists")
    conn.commit()
    return _serialize_row(row)


def update_user_role(conn, user_id: str, new_role: str) -> Optional[dict]:
    """Change a user's role. Prevents demoting the last ops user."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        user = cur.fetchone()
        if not user:
            return None

        if user["role"] == "ops" and new_role != "ops":
            cur.execute("SELECT COUNT(*) AS cnt FROM users WHERE role = 'ops'")
            ops_count = cur.fetchone()["cnt"]
            if ops_count <= 1:
                raise ValueError("Cannot change role: at least one ops user must exist")

        cur.execute(
            "UPDATE users SET role = %s WHERE id = %s RETURNING *",
            (new_role, user_id),
        )
        row = cur.fetchone()
    conn.commit()
    return _serialize_row(row)


def delete_user(conn, user_id: str) -> bool:
    """Delete a user. Prevents deleting the last ops user."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
        user = cur.fetchone()
        if not user:
            return False

        if user["role"] == "ops":
            cur.execute("SELECT COUNT(*) AS cnt FROM users WHERE role = 'ops'")
            ops_count = cur.fetchone()["cnt"]
            if ops_count <= 1:
                raise ValueError("Cannot delete: at least one ops user must exist")

        cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
        deleted = cur.rowcount > 0
    conn.commit()
    return deleted


# ---------------------------------------------------------------------------
# MCP tokens (long-lived bearer tokens for Claude Code, Claude.ai, etc.)
# Raw token format: "eg_mcp_<43-char-base64url>". Stored as SHA-256 hash —
# the raw value is returned to the caller exactly once at creation time.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# The demo's Outbox
# ---------------------------------------------------------------------------

def lock_cap(conn, name: str) -> None:
    """Hold the named cap's lock until *conn*'s transaction ends, so a count and the insert it allows can't
    interleave with another request's."""
    with conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"cap:{name}",))


def insert_outbox_entry(conn, *, kind: str, title: str, body: str, meta: dict,
                        created_by: Optional[str], keep: Optional[int] = None, commit: bool = True) -> str:
    """Record a Slack post or Drive save the demo captured instead of sending. Returns the entry id. With *keep*,
    the oldest entries beyond that many are dropped in the same transaction: the Outbox is a log, so a full one
    makes room rather than refusing."""
    with conn.cursor() as cur:
        if keep is not None:
            lock_cap(conn, "outbox")
        cur.execute(
            """INSERT INTO outbox (kind, title, body, meta, created_by)
               VALUES (%s, %s, %s, %s, %s) RETURNING id""",
            (kind, title, body, json.dumps(meta, default=str), created_by),
        )
        entry_id = str(cur.fetchone()[0])
        if keep is not None:
            cur.execute(
                """DELETE FROM outbox WHERE id IN (
                       SELECT id FROM outbox ORDER BY created_at DESC, id OFFSET %s)""",
                (keep,),
            )
    if commit:
        conn.commit()
    return entry_id


def count_outbox(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM outbox")
        return cur.fetchone()[0]


def count_users(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM users")
        return cur.fetchone()[0]


def folder_has_runs(conn, source_folder_id: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM households WHERE source_folder_id = %s LIMIT 1", (source_folder_id,))
        return cur.fetchone() is not None


def count_target_accounts(conn, source_folder_id: str) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM target_accounts WHERE source_folder_id = %s", (source_folder_id,))
        return cur.fetchone()[0]


def list_outbox(conn, limit: int = 100) -> list[dict]:
    """Outbox entries, newest first."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT id, kind, title, body, meta, created_by, created_at
               FROM outbox ORDER BY created_at DESC, id LIMIT %s""",
            (limit,),
        )
        rows = cur.fetchall()
    return [_serialize_row(r) for r in rows]


def insert_mcp_token(
    conn,
    *,
    token_hash: str,
    user_email: str,
    description: str,
    last4: str,
    expires_at,
    created_by: str,
) -> dict:
    """
    Persist a freshly-minted MCP token. Caller is responsible for hashing
    the raw token (we never store or log the raw value).
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """INSERT INTO mcp_tokens
                   (token_hash, user_email, description, last4, expires_at, created_by)
               VALUES (%s, %s, %s, %s, %s, %s)
               RETURNING id, user_email, description, last4, created_at,
                         expires_at, last_used_at, revoked_at, created_by""",
            (token_hash, user_email.lower().strip(), description or None, last4, expires_at, created_by),
        )
        row = cur.fetchone()
    conn.commit()
    return _serialize_row(row)


def list_mcp_tokens(conn, user_email: Optional[str] = None) -> list[dict]:
    """
    List token metadata. Optionally scope to a single user_email. Never
    returns the token_hash. Ordered newest-first.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        if user_email:
            cur.execute(
                """SELECT id, user_email, description, last4, created_at,
                          expires_at, last_used_at, revoked_at, created_by
                   FROM mcp_tokens
                   WHERE user_email = %s
                   ORDER BY created_at DESC""",
                (user_email.lower().strip(),),
            )
        else:
            cur.execute(
                """SELECT id, user_email, description, last4, created_at,
                          expires_at, last_used_at, revoked_at, created_by
                   FROM mcp_tokens
                   ORDER BY created_at DESC"""
            )
        rows = cur.fetchall()
    return [_serialize_row(r) for r in rows]


def lookup_mcp_token_by_hash(conn, token_hash: str) -> Optional[dict]:
    """
    Look up a token by its SHA-256 hash. Returns the token row joined
    with the user (id, email, role) when valid (not revoked, not
    expired, user still in allowlist). Returns None otherwise.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """SELECT t.id          AS token_id,
                      t.user_email  AS email,
                      t.expires_at,
                      t.revoked_at,
                      u.id          AS user_id,
                      u.role        AS role,
                      u.created_at  AS user_created_at
               FROM mcp_tokens t
               JOIN users u ON u.email = t.user_email
               WHERE t.token_hash = %s
                 AND t.revoked_at IS NULL
                 AND t.expires_at > NOW()""",
            (token_hash,),
        )
        row = cur.fetchone()
    return _serialize_row(row) if row else None


def touch_mcp_token(conn, token_id: str) -> None:
    """Update last_used_at to NOW(). Called from MCP auth middleware."""
    with conn.cursor() as cur:
        cur.execute("UPDATE mcp_tokens SET last_used_at = NOW() WHERE id = %s", (token_id,))
    conn.commit()


def revoke_mcp_token(conn, token_id: str) -> bool:
    """Set revoked_at = NOW() if not already revoked. Returns True if state changed."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE mcp_tokens SET revoked_at = NOW() WHERE id = %s AND revoked_at IS NULL",
            (token_id,),
        )
        updated = cur.rowcount > 0
    conn.commit()
    return updated


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mask_account_number(acct_num: str) -> str:
    """Return only the last 4 digits/letters of an account number, rest masked."""
    if not acct_num:
        return acct_num
    s = str(acct_num)
    digit_count = 0
    reveal_start = len(s)
    for i in range(len(s) - 1, -1, -1):
        if s[i] != '-':
            digit_count += 1
        if digit_count == 4:
            reveal_start = i
            break
    if reveal_start == 0:
        return s
    return "\u2022" * reveal_start + s[reveal_start:]


def _clean_numeric(val):
    """Strip commas and currency symbols from Gemini-extracted numbers."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return val
    if isinstance(val, str):
        cleaned = val.replace(",", "").replace("$", "").strip()
        try:
            return float(cleaned)
        except (ValueError, TypeError):
            return None
    return val


def _serialize_row(row: dict) -> dict:
    """Convert psycopg2 row to JSON-serializable dict."""
    out = {}
    for k, v in dict(row).items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
        elif isinstance(v, (int, float, str, bool, list, dict)) or v is None:
            out[k] = v
        else:
            out[k] = str(v)
    return out
