"""DB_SCHEMA_OWNER=external: verify read-only, never run DDL, and fail closed at startup."""
import asyncio

import psycopg2
import pytest

import db
import server
from tests.flywheel import mark_case

SUITE = "external-schema"


def connect(pg_env):
    kwargs = {k[3:].lower(): v for k, v in pg_env.items() if k.startswith("DB_")}
    return psycopg2.connect(host=kwargs["host"], port=kwargs["port"], dbname=kwargs["name"], user=kwargs["user"],
                            password=kwargs["password"], options=f"-c search_path={kwargs['search_path']}")


@pytest.fixture
def external(monkeypatch):
    monkeypatch.setenv("DB_SCHEMA_OWNER", "external")

    def use(env):
        for key, value in env.items():
            monkeypatch.setenv(key, value)
    return use


def test_empty_schema_raises_and_creates_nothing(pg, external):
    name = pg["schema"](ddl=False)
    external(pg["env"]("DB_", name))
    conn = connect(pg["env"]("DB_", name))
    try:
        with pytest.raises(RuntimeError, match="external schema not ready: missing"):
            db.ensure_schema(conn)
    finally:
        conn.close()
    assert pg["fetch"](name, "SELECT count(*) FROM pg_class WHERE relnamespace = current_schema()::regnamespace") == [(0,)]
    mark_case(SUITE, "empty-raises-no-ddl")


def test_full_schema_passes(pg, external):
    name = pg["schema"]()
    external(pg["env"]("DB_", name))
    conn = connect(pg["env"]("DB_", name))
    try:
        db.ensure_schema(conn)
        assert conn.get_transaction_status() == psycopg2.extensions.TRANSACTION_STATUS_IDLE
    finally:
        conn.close()
    mark_case(SUITE, "full-schema-passes")


def test_missing_column_is_named(pg, external):
    name = pg["schema"]()
    pg["execute"](name, "ALTER TABLE accounts DROP COLUMN account_type_overridden_by")
    external(pg["env"]("DB_", name))
    conn = connect(pg["env"]("DB_", name))
    try:
        with pytest.raises(RuntimeError, match=r"accounts\.account_type_overridden_by"):
            db.ensure_schema(conn)
    finally:
        conn.close()
    mark_case(SUITE, "missing-column-named")


def test_wrong_search_path_raises(pg, external, monkeypatch):
    name = pg["schema"]()
    external(pg["env"]("DB_", name))
    monkeypatch.setenv("DB_SEARCH_PATH", "statement_pipeline")
    conn = connect(pg["env"]("DB_", name))
    try:
        with pytest.raises(RuntimeError, match="current_schema is"):
            db.ensure_schema(conn)
    finally:
        conn.close()
    mark_case(SUITE, "wrong-search-path")


async def _enter_lifespan():
    async with server.lifespan(server.app):
        pass


def _failing_pool(**_kwargs):
    raise psycopg2.OperationalError("connection refused")


def test_startup_fails_closed_when_external(monkeypatch, external):
    monkeypatch.setattr(db, "init_pool", _failing_pool)
    with pytest.raises(psycopg2.OperationalError):
        asyncio.run(_enter_lifespan())
    mark_case(SUITE, "startup-fails-closed")


def test_startup_fails_closed_on_unready_schema(pg, monkeypatch, external):
    name = pg["schema"](ddl=False)
    external(pg["env"]("DB_", name))
    monkeypatch.setattr(db, "_pool", None)
    try:
        with pytest.raises(RuntimeError, match="external schema not ready"):
            asyncio.run(_enter_lifespan())
    finally:
        if db._pool is not None:
            db._pool.closeall()
        monkeypatch.setattr(db, "_pool", None)
    mark_case(SUITE, "startup-fails-closed-unready")
